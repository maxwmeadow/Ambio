package dev.ambio.agent.rt;

import java.lang.instrument.ClassFileTransformer;
import java.security.ProtectionDomain;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.Label;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;
import org.objectweb.asm.commons.AdviceAdapter;

/**
 * Rewrites classes compiled from workspace sources so each method reports to
 * {@link Rec}: on entry, on each return, and - through a catch-all handler
 * placed after the method's own - when an exception leaves it.
 *
 * The handler uses no local variables, so its stack-map frame is "no locals,
 * one Throwable" whatever the method does. That keeps the rewrite free of
 * frame computation, which would need the class hierarchy and so the user's
 * class loader in the middle of loading.
 */
final class Transformer implements ClassFileTransformer {
    private static final String REC = "dev/ambio/agent/rt/Rec";
    private static final String CONTINUATION = "Lkotlin/coroutines/Continuation;";
    private static final boolean DEBUG = System.getenv("AMBIO_RECORDER_DEBUG") != null;
    private static final int SKIP = Opcodes.ACC_ABSTRACT | Opcodes.ACC_NATIVE | Opcodes.ACC_SYNTHETIC | Opcodes.ACC_BRIDGE;

    private static boolean neverOurs(String name) {
        return name.startsWith("java/") || name.startsWith("javax/") || name.startsWith("jdk/") || name.startsWith("sun/")
            || name.startsWith("com/sun/") || name.startsWith("kotlin/") || name.startsWith("kotlinx/")
            || name.startsWith("scala/") || name.startsWith("dev/ambio/agent/");
    }

    public byte[] transform(ClassLoader loader, String name, Class<?> redefined, ProtectionDomain domain, byte[] bytes) {
        try {
            if (name == null || loader == null || redefined != null || neverOurs(name) || !Main.inWorkspace(domain)) {
                return null;
            }
            ClassReader reader = new ClassReader(bytes);
            Info info = new Info();
            reader.accept(info, ClassReader.SKIP_FRAMES);
            if (info.source == null || info.coroutineInternal) {
                return null;
            }
            String file = Main.sourceFor(name, info.source);
            if (file == null) {
                return null;
            }
            ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS);
            Weaver weaver = new Weaver(writer, name, file, info);
            reader.accept(weaver, ClassReader.EXPAND_FRAMES);
            if (DEBUG) {
                System.err.println("[ambio] " + name + ": " + weaver.woven + " methods recorded (" + file + ")");
            }
            return weaver.woven > 0 ? writer.toByteArray() : null;
        } catch (Throwable t) {
            if (DEBUG) {
                System.err.println("[ambio] not recording " + name + ": " + t);
                t.printStackTrace();
            }
            return null; // the class loads as it was compiled
        }
    }

    /** What a first pass learns about each method: its first line and parameter names. */
    private static final class MethodInfo {
        int line = Integer.MAX_VALUE;
        int instructions;
        int fieldAccesses;
        boolean branchesOrCalls;

        /** A getter or setter: one field read or write and nothing else. */
        boolean trivial() {
            return !branchesOrCalls && instructions <= 4 && fieldAccesses == 1;
        }

        final Map<Integer, String> slots = new HashMap<Integer, String>();
        final List<String> parameters = new ArrayList<String>();
    }

    private static final class Info extends ClassVisitor {
        String source;
        int version;
        boolean isEnum;
        boolean coroutineInternal;
        int firstLine = Integer.MAX_VALUE;
        final Map<String, MethodInfo> methods = new HashMap<String, MethodInfo>();

        Info() {
            super(Opcodes.ASM9);
        }

        @Override
        public void visit(int version, int access, String name, String signature, String superName, String[] interfaces) {
            this.version = version & 0xffff;
            this.isEnum = (access & Opcodes.ACC_ENUM) != 0;
            // Kotlin compiles a lambda or a suspend function's state machine
            // to a class of its own, and Groovy does the same for a closure;
            // like a Java lambda, it is not a function the index knows.
            this.coroutineInternal = superName != null
                && (superName.startsWith("kotlin/coroutines/jvm/internal/") || superName.equals("kotlin/jvm/internal/Lambda")
                    || superName.equals("groovy/lang/Closure"));
        }

        @Override
        public void visitSource(String source, String debug) {
            this.source = source;
        }

        @Override
        public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
            final MethodInfo info = new MethodInfo();
            methods.put(name + descriptor, info);
            return new MethodVisitor(Opcodes.ASM9) {
                @Override
                public void visitLineNumber(int line, Label start) {
                    if (line < info.line) {
                        info.line = line;
                    }
                    if (line < firstLine) {
                        firstLine = line;
                    }
                }

                @Override
                public void visitInsn(int opcode) {
                    info.instructions++;
                }

                @Override
                public void visitVarInsn(int opcode, int index) {
                    info.instructions++;
                }

                @Override
                public void visitFieldInsn(int opcode, String owner, String name, String descriptor) {
                    info.instructions++;
                    info.fieldAccesses++;
                }

                @Override
                public void visitIntInsn(int opcode, int operand) {
                    info.instructions++;
                }

                @Override
                public void visitLdcInsn(Object value) {
                    info.instructions++;
                }

                @Override
                public void visitTypeInsn(int opcode, String type) {
                    info.branchesOrCalls = true;
                }

                @Override
                public void visitMethodInsn(int opcode, String owner, String name, String descriptor, boolean isInterface) {
                    info.branchesOrCalls = true;
                }

                @Override
                public void visitInvokeDynamicInsn(String name, String descriptor, org.objectweb.asm.Handle bootstrap, Object... arguments) {
                    info.branchesOrCalls = true;
                }

                @Override
                public void visitJumpInsn(int opcode, Label label) {
                    info.branchesOrCalls = true;
                }

                @Override
                public void visitLocalVariable(String name, String descriptor, String signature, Label start, Label end, int index) {
                    if (!info.slots.containsKey(index)) {
                        info.slots.put(index, name);
                    }
                }

                @Override
                public void visitParameter(String name, int access) {
                    info.parameters.add(name);
                }
            };
        }
    }

    private static final class Weaver extends ClassVisitor {
        private final String className;
        private final String file;
        private final Info info;
        int woven;

        Weaver(ClassVisitor next, String className, String file, Info info) {
            super(Opcodes.ASM9, next);
            this.className = className;
            this.file = file;
            this.info = info;
        }

        @Override
        public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
            MethodVisitor next = super.visitMethod(access, name, descriptor, signature, exceptions);
            MethodInfo method = info.methods.get(name + descriptor);
            if (next == null || method == null || method.line == Integer.MAX_VALUE || (access & SKIP) != 0
                || name.equals("<clinit>") || (name.indexOf('$') >= 0)
                || (info.isEnum && (name.equals("values") || name.equals("valueOf")))) {
                return next;
            }
            boolean isStatic = (access & Opcodes.ACC_STATIC) != 0;
            String shown = name.equals("<init>") ? constructorName() : name;
            boolean watched = Main.watched(file, shown, method.line);
            if (!watched && (method.trivial() || generated(name, method))) {
                return next;
            }
            Type[] types = Type.getArgumentTypes(descriptor);
            // A Kotlin suspend function takes its continuation as a last,
            // hidden parameter and returns Object.
            boolean suspend = types.length > 0 && types[types.length - 1].getDescriptor().equals(CONTINUATION)
                && descriptor.endsWith(")Ljava/lang/Object;");
            if (suspend) {
                types = java.util.Arrays.copyOf(types, types.length - 1);
            }
            String[] params = new String[types.length + (isStatic ? 0 : 1)];
            int slot = isStatic ? 0 : 1;
            for (int i = 0; i < types.length; i++) {
                String known = method.slots.get(slot);
                if (known == null && i < method.parameters.size()) {
                    known = method.parameters.get(i);
                }
                params[i] = known == null || known.isEmpty() ? "arg" + i : known;
                slot += types[i].getSize();
            }
            if (!isStatic) {
                params[types.length] = "this";
            }
            int id = Rec.register(className.replace('/', '.'), file, shown, method.line, params, watched);
            woven++;
            return new Advice(next, access, name, descriptor, id, watched, suspend, info.version >= Opcodes.V1_6);
        }

        /** Methods the compiler writes for a Kotlin data class or a Java record: they sit on the declaration's line. */
        private boolean generated(String name, MethodInfo method) {
            if (method.line != info.firstLine) {
                return false;
            }
            return name.equals("equals") || name.equals("hashCode") || name.equals("toString") || name.equals("copy")
                || (name.startsWith("component") && name.length() > 9 && Character.isDigit(name.charAt(9)))
                // a Scala case class and its companion
                || name.equals("apply") || name.equals("unapply") || name.equals("canEqual") || name.equals("fromProduct")
                || name.startsWith("product");
        }

        /** A constructor goes by its class's name, as the index names it. */
        private String constructorName() {
            String simple = className.substring(className.lastIndexOf('/') + 1);
            while (simple.length() > 1 && simple.endsWith("$")) {
                simple = simple.substring(0, simple.length() - 1); // a Scala object's class: Pricing$
            }
            String inner = simple.substring(simple.lastIndexOf('$') + 1);
            return inner.isEmpty() || Character.isDigit(inner.charAt(0)) ? "constructor" : inner;
        }
    }

    private static final class Advice extends AdviceAdapter {
        private final int id;
        private final boolean watched;
        private final boolean suspend;
        private final boolean frames;
        private final boolean isStatic;
        private final Type returnType;
        private final Label start = new Label();
        private boolean entered;

        Advice(MethodVisitor next, int access, String name, String descriptor, int id, boolean watched, boolean suspend, boolean frames) {
            super(Opcodes.ASM9, next, access, name, descriptor);
            this.id = id;
            this.watched = watched;
            this.suspend = suspend;
            this.frames = frames;
            this.isStatic = (access & Opcodes.ACC_STATIC) != 0;
            this.returnType = Type.getReturnType(descriptor);
        }

        private void rec(String method, String descriptor) {
            mv.visitMethodInsn(Opcodes.INVOKESTATIC, REC, method, descriptor, false);
        }

        @Override
        protected void onMethodEnter() {
            push(id);
            if (suspend) {
                // The continuation identifies the call across suspensions.
                loadArg(getArgumentTypes().length - 1);
                if (!watched) {
                    mv.visitInsn(Opcodes.ACONST_NULL);
                    mv.visitInsn(Opcodes.ACONST_NULL);
                } else {
                    if (isStatic) {
                        mv.visitInsn(Opcodes.ACONST_NULL);
                    } else {
                        loadThis();
                    }
                    loadArgArray();
                }
                rec("enterSuspend", "(ILjava/lang/Object;Ljava/lang/Object;[Ljava/lang/Object;)V");
            } else if (watched) {
                if (isStatic) {
                    mv.visitInsn(Opcodes.ACONST_NULL);
                } else {
                    loadThis();
                }
                loadArgArray();
                rec("enterWatched", "(ILjava/lang/Object;[Ljava/lang/Object;)V");
            } else {
                rec("enter", "(I)V");
            }
            mv.visitLabel(start);
            entered = true;
        }

        @Override
        protected void onMethodExit(int opcode) {
            if (opcode == Opcodes.ATHROW || !entered) {
                return; // the handler below reports exceptions
            }
            if (suspend) {
                dup();
                push(id);
                rec("exitSuspend", "(Ljava/lang/Object;I)V");
                return;
            }
            if (!watched) {
                push(id);
                rec("exit", "(I)V");
                return;
            }
            if (opcode == Opcodes.RETURN) {
                push(id);
                rec("exitWatchedVoid", "(I)V");
                return;
            }
            if (opcode == Opcodes.LRETURN || opcode == Opcodes.DRETURN) {
                dup2();
            } else {
                dup();
            }
            if (opcode != Opcodes.ARETURN) {
                box(returnType);
            }
            push(id);
            rec("exitWatched", "(Ljava/lang/Object;I)V");
        }

        @Override
        public void visitMaxs(int maxStack, int maxLocals) {
            if (entered) {
                // Last in the exception table: the method's own handlers win,
                // and only an exception that leaves the method reaches this.
                Label handler = new Label();
                mv.visitTryCatchBlock(start, handler, handler, null);
                mv.visitLabel(handler);
                if (frames) {
                    mv.visitFrame(Opcodes.F_NEW, 0, new Object[0], 1, new Object[] {"java/lang/Throwable"});
                }
                mv.visitInsn(Opcodes.DUP);
                mv.visitLdcInsn(id);
                rec("thrown", "(Ljava/lang/Throwable;I)V");
                mv.visitInsn(Opcodes.ATHROW);
            }
            super.visitMaxs(maxStack, maxLocals);
        }
    }
}

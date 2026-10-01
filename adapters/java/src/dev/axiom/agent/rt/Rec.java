package dev.axiom.agent.rt;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What instrumented methods call. Every method reports that it ran (call
 * counts, time, caller -> callee edges); watched methods also report their
 * arguments, what they returned or threw, and what they changed.
 *
 * Called from the user's threads: it must never throw, and never run the
 * user's code. While it is working on a call, calls it makes itself (through
 * reflection on a class that happens to be instrumented) are ignored.
 */
public final class Rec {
    private Rec() {}

    static final int MAX_EDGES = 5000;

    static final class Fn {
        final String file;
        final String name;
        final int line;
        final String[] params; // receiver last, as "this", for instance methods
        final Watch watch;
        long calls;
        long errors;
        long ns;

        Fn(String file, String name, int line, String[] params, Watch watch) {
            this.file = file;
            this.name = name;
            this.line = line;
            this.params = params;
            this.watch = watch;
        }
    }

    /** A watched call in progress. */
    static final class Frame {
        Object[] values;
        LinkedHashMap<String, Values.Leaf> before;
        int call;
        String args;
    }

    /** A suspend call between a suspension and its resumption. */
    static final class Pending {
        final int id;
        final Frame frame;
        final long ns;

        Pending(int id, Frame frame, long ns) {
            this.id = id;
            this.frame = frame;
            this.ns = ns;
        }
    }

    static final class Stack {
        int[] ids = new int[64];
        long[] t0 = new long[64];
        Frame[] frames = new Frame[64];
        /** For a suspend call: the continuation it was first called with, and time before this resumption. */
        Object[] keys = new Object[64];
        long[] earlier = new long[64];
        int depth;
        boolean busy;
    }

    private static final ThreadLocal<Stack> STACK = new ThreadLocal<Stack>() {
        @Override
        protected Stack initialValue() {
            return new Stack();
        }
    };

    private static final Object LOCK = new Object();
    private static Fn[] fns = new Fn[256];
    private static int fnCount;
    private static final HashMap<Long, long[]> EDGES = new HashMap<Long, long[]>();
    private static long edgesDropped;
    private static final List<String> UNCAUGHT = new ArrayList<String>();
    private static final java.util.IdentityHashMap<Object, Pending> PENDING = new java.util.IdentityHashMap<Object, Pending>();
    private static final int MAX_PENDING = 20000;
    private static final HashMap<String, String> SOURCES = new HashMap<String, String>(); // class → source file

    static String dir;
    static String runId = "";
    static final long STARTED = System.currentTimeMillis();
    private static long lastWritten = -1;

    // ── registration (from the transformer) ────────────────────────────────

    static int register(String className, String file, String name, int line, String[] params, boolean watched) {
        synchronized (LOCK) {
            if (fnCount == fns.length) {
                Fn[] bigger = new Fn[fns.length * 2];
                System.arraycopy(fns, 0, bigger, 0, fnCount);
                fns = bigger;
            }
            fns[fnCount] = new Fn(file, name, line, params, watched ? new Watch(file, name, line) : null);
            SOURCES.put(className, file);
            return fnCount++;
        }
    }

    // ── calls (from instrumented code) ─────────────────────────────────────

    public static void enter(int id) {
        try {
            Stack s = STACK.get();
            if (s.busy) {
                return;
            }
            push(s, id, null);
        } catch (Throwable t) {
            // never break the program
        }
    }

    public static void enterWatched(int id, Object self, Object[] args) {
        try {
            Stack s = STACK.get();
            if (s.busy) {
                return;
            }
            s.busy = true;
            try {
                push(s, id, watchedEntry(fns[id], self, args));
            } finally {
                s.busy = false;
            }
        } catch (Throwable t) {
            // never break the program
        }
    }

    /**
     * A Kotlin suspend function runs once per resumption. Its first call gets
     * the caller's continuation; each resumption gets the function's own state
     * machine, whose `completion` is that same continuation. So the
     * continuation identifies the call, and a resumption continues it instead
     * of counting again.
     */
    public static void enterSuspend(int id, Object continuation, Object self, Object[] args) {
        try {
            Stack s = STACK.get();
            if (s.busy) {
                return;
            }
            s.busy = true;
            try {
                Object parent = completionOf(continuation);
                Pending pending = null;
                if (parent != null) {
                    synchronized (LOCK) {
                        pending = PENDING.get(parent);
                        if (pending != null && pending.id == id) {
                            PENDING.remove(parent);
                        } else {
                            pending = null;
                        }
                    }
                }
                if (pending != null) {
                    resume(s, id, pending, parent);
                } else {
                    push(s, id, args == null ? null : watchedEntry(fns[id], self, args));
                    s.keys[s.depth - 1] = continuation;
                }
            } finally {
                s.busy = false;
            }
        } catch (Throwable t) {
            // never break the program
        }
    }

    public static void exitSuspend(Object returned, int id) {
        try {
            if (!suspended(returned)) {
                leave(id, returned, false, null);
                return;
            }
            long now = System.nanoTime();
            Stack s = STACK.get();
            if (s.busy) {
                return;
            }
            int at = s.depth - 1;
            while (at >= 0 && s.ids[at] != id) {
                at--;
            }
            if (at < 0) {
                return;
            }
            Object key = s.keys[at];
            Pending pending = new Pending(id, s.frames[at], s.earlier[at] + now - s.t0[at]);
            pop(s, at);
            if (key != null) {
                synchronized (LOCK) {
                    if (PENDING.size() < MAX_PENDING) {
                        PENDING.put(key, pending);
                    }
                }
            }
        } catch (Throwable t) {
            // never break the program
        }
    }

    private static boolean suspended(Object returned) {
        return returned instanceof Enum && ((Enum<?>) returned).name().equals("COROUTINE_SUSPENDED")
            && returned.getClass().getName().equals("kotlin.coroutines.intrinsics.CoroutineSingletons");
    }

    private static volatile java.lang.reflect.Field completionField;

    /** BaseContinuationImpl.completion: who a state machine reports back to. */
    private static Object completionOf(Object continuation) {
        if (continuation == null) {
            return null;
        }
        try {
            java.lang.reflect.Field field = completionField;
            if (field == null) {
                Class<?> base = Class.forName("kotlin.coroutines.jvm.internal.BaseContinuationImpl", false, continuation.getClass().getClassLoader());
                field = base.getDeclaredField("completion");
                field.setAccessible(true);
                completionField = field;
            }
            return field.getDeclaringClass().isInstance(continuation) ? field.get(continuation) : null;
        } catch (Throwable t) {
            return null;
        }
    }

    private static void resume(Stack s, int id, Pending pending, Object key) {
        grow(s);
        s.ids[s.depth] = id;
        s.frames[s.depth] = pending.frame;
        s.keys[s.depth] = key;
        s.earlier[s.depth] = pending.ns;
        s.t0[s.depth] = System.nanoTime();
        s.depth++;
    }

    private static void grow(Stack s) {
        if (s.depth == s.ids.length) {
            int size = s.depth * 2;
            s.ids = java.util.Arrays.copyOf(s.ids, size);
            s.t0 = java.util.Arrays.copyOf(s.t0, size);
            s.frames = java.util.Arrays.copyOf(s.frames, size);
            s.keys = java.util.Arrays.copyOf(s.keys, size);
            s.earlier = java.util.Arrays.copyOf(s.earlier, size);
        }
    }

    private static void pop(Stack s, int at) {
        for (int i = at; i < s.depth; i++) {
            s.frames[i] = null;
            s.keys[i] = null;
            s.earlier[i] = 0;
        }
        s.depth = at;
    }

    public static void exit(int id) {
        leave(id, null, false, null);
    }

    public static void exitWatched(Object returned, int id) {
        leave(id, returned, false, null);
    }

    public static void exitWatchedVoid(int id) {
        leave(id, null, true, null);
    }

    public static void thrown(Throwable error, int id) {
        leave(id, null, false, error);
    }

    private static void push(Stack s, int id, Frame frame) {
        Fn fn = fns[id];
        synchronized (LOCK) {
            fn.calls++;
            if (s.depth > 0) {
                int caller = s.ids[s.depth - 1];
                if (caller != id) {
                    Long key = ((long) caller << 32) | id;
                    long[] n = EDGES.get(key);
                    if (n != null) {
                        n[0]++;
                    } else if (EDGES.size() < MAX_EDGES) {
                        EDGES.put(key, new long[] {1});
                    } else {
                        edgesDropped++;
                    }
                }
            }
        }
        grow(s);
        s.ids[s.depth] = id;
        s.frames[s.depth] = frame;
        s.t0[s.depth] = System.nanoTime();
        s.depth++;
    }

    private static void leave(int id, Object returned, boolean isVoid, Throwable error) {
        try {
            long now = System.nanoTime();
            Stack s = STACK.get();
            if (s.busy) {
                return;
            }
            // The matching entry is the top one unless an enter was skipped.
            int at = s.depth - 1;
            while (at >= 0 && s.ids[at] != id) {
                at--;
            }
            if (at < 0) {
                return;
            }
            long ns = s.earlier[at] + now - s.t0[at];
            Frame frame = s.frames[at];
            pop(s, at);
            Fn fn = fns[id];
            synchronized (LOCK) {
                fn.ns += ns;
                if (error != null) {
                    fn.errors++;
                }
            }
            if (frame != null && fn.watch != null) {
                s.busy = true;
                try {
                    String threw = error == null ? null : describe(error);
                    synchronized (LOCK) {
                        watchedExit(fn, frame, returned, isVoid, threw, ns / 1.0e6);
                    }
                } finally {
                    s.busy = false;
                }
            }
        } catch (Throwable t) {
            // never break the program
        }
    }

    /** "IllegalStateException: message". Callers hold busy: getMessage may be the user's. */
    static String describe(Throwable error) {
        String message = null;
        try {
            message = error.getMessage();
        } catch (Throwable t) {
            // no message
        }
        String what = Values.simpleName(error.getClass());
        if (message == null) {
            return what;
        }
        return what + ": " + (message.length() <= 200 ? message : message.substring(0, 200));
    }

    // ── watched calls ──────────────────────────────────────────────────────

    private static Frame watchedEntry(Fn fn, Object self, Object[] args) {
        Watch w = fn.watch;
        String[] names = fn.params;
        Object[] values = new Object[names.length];
        // The receiver is the last name; a suspend function's continuation is
        // a last argument with no name.
        boolean receiver = names.length > 0 && names[names.length - 1].equals("this");
        int count = receiver ? names.length - 1 : names.length;
        System.arraycopy(args, 0, values, 0, Math.min(args.length, count));
        if (receiver) {
            values[count] = self;
        }
        Frame frame = new Frame();
        frame.values = values;
        frame.before = new LinkedHashMap<String, Values.Leaf>();
        synchronized (LOCK) {
            w.calls++;
            frame.call = w.calls;
            List<Values.Node> nodes = new ArrayList<Values.Node>();
            LinkedHashMap<String, Object> shown = new LinkedHashMap<String, Object>();
            for (int i = 0; i < names.length; i++) {
                for (Map.Entry<String, Values.Leaf> e : Values.flatten(values[i], names[i]).entrySet()) {
                    frame.before.put(e.getKey(), e.getValue());
                    w.observe("arg." + e.getKey(), e.getValue());
                }
                Values.collectNodes(values[i], names[i], nodes);
                shown.put(names[i], values[i]);
            }
            w.checkDrift(nodes, frame.call);
            frame.args = Values.preview(shown);
            StringBuilder fingerprint = new StringBuilder();
            for (Map.Entry<String, Values.Leaf> e : frame.before.entrySet()) {
                fingerprint.append(e.getKey()).append('=').append(Values.display(e.getValue())).append('|');
            }
            w.observeArgs(frame.call, names, values, fingerprint.toString(), frame.args);
        }
        return frame;
    }

    private static void watchedExit(Fn fn, Frame frame, Object returned, boolean isVoid, String threw, double ms) {
        Watch w = fn.watch;
        w.totalMs += ms;
        String shownReturn = null;
        if (threw != null) {
            w.exception(threw);
        } else if (isVoid) {
            shownReturn = "void";
            w.returns.addText("void");
        } else {
            shownReturn = Values.preview(returned);
            Values.Leaf leaf = Values.leaf(returned);
            if (leaf != null && leaf.numeric()) {
                w.returns.add(leaf);
            } else {
                w.returns.addText(shownReturn.length() <= 80 ? shownReturn : shownReturn.substring(0, 79) + "…");
            }
            for (Map.Entry<String, Values.Leaf> e : Values.flatten(returned, "return").entrySet()) {
                w.observe(e.getKey(), e.getValue());
            }
            if (leaf == null) {
                List<Values.Node> nodes = new ArrayList<Values.Node>();
                Values.collectNodes(returned, "return", nodes);
                w.checkDrift(nodes, frame.call);
            }
        }
        // What the call changed in its arguments and receiver.
        List<String[]> changed = new ArrayList<String[]>();
        List<Values.Node> nodes = new ArrayList<Values.Node>();
        String[] names = fn.params;
        for (int i = 0; i < names.length; i++) {
            String n = names[i];
            LinkedHashMap<String, Values.Leaf> after = Values.flatten(frame.values[i], n);
            Values.collectNodes(frame.values[i], n, nodes);
            List<String> keys = new ArrayList<String>();
            for (String k : frame.before.keySet()) {
                if (k.equals(n) || k.startsWith(n + ".") || k.startsWith(n + "[")) {
                    keys.add(k);
                }
            }
            for (String k : after.keySet()) {
                if (!frame.before.containsKey(k)) {
                    keys.add(k);
                }
            }
            for (String k : keys) {
                String b = Values.display(frame.before.get(k));
                String a = Values.display(after.get(k));
                if (!a.equals(b)) {
                    changed.add(new String[] {k, b, a});
                }
            }
        }
        w.checkDrift(nodes, frame.call);
        // An empty container gaining its first entry is one change, not two.
        List<String[]> real = new ArrayList<String[]>();
        for (String[] c : changed) {
            boolean placeholder = c[1].equals("{}") || c[1].equals("(absent)") || c[2].equals("{}") || c[2].equals("(absent)");
            boolean hasChild = false;
            for (String[] o : changed) {
                if (o != c && (o[0].startsWith(c[0] + ".") || o[0].startsWith(c[0] + "["))) {
                    hasChild = true;
                    break;
                }
            }
            if (!placeholder || !hasChild) {
                real.add(c);
            }
        }
        for (int i = 0; i < real.size() && i < 20; i++) {
            w.mutation(real.get(i)[0], real.get(i)[1], real.get(i)[2], frame.call);
        }
        Watch.Sample sample = new Watch.Sample();
        sample.call = frame.call;
        sample.args = frame.args;
        sample.ms = ms;
        sample.threw = threw;
        sample.returned = shownReturn;
        if (!real.isEmpty()) {
            sample.mutated = new ArrayList<String>();
            for (int i = 0; i < real.size() && i < 4; i++) {
                sample.mutated.add(real.get(i)[0] + ": " + real.get(i)[1] + " → " + real.get(i)[2]);
            }
        }
        w.sample(sample);
    }

    // ── crashes ────────────────────────────────────────────────────────────

    static void uncaught(Throwable error) {
        try {
            StringBuilder frames = new StringBuilder();
            int shown = 0;
            String what = describe(error);
            synchronized (LOCK) {
                if (UNCAUGHT.size() >= 5) {
                    return;
                }
                // Node-style frames so archd's stack parser can place the crash.
                for (StackTraceElement el : error.getStackTrace()) {
                    String file = SOURCES.get(el.getClassName());
                    if (file == null || el.getLineNumber() <= 0 || shown >= 12) {
                        continue;
                    }
                    if (shown++ > 0) {
                        frames.append('\n');
                    }
                    frames.append("    at ").append(el.getMethodName()).append(" (").append(file).append(':')
                        .append(el.getLineNumber()).append(":1)");
                }
                StringBuilder b = new StringBuilder("{\"what\":");
                Json.str(b, what.length() <= 300 ? what : what.substring(0, 300));
                b.append(",\"stack\":");
                Json.str(b, frames.toString());
                UNCAUGHT.add(b.append('}').toString());
            }
        } catch (Throwable t) {
            // never break the program
        }
    }

    // ── the evidence file ──────────────────────────────────────────────────

    static void write() {
        if (dir == null) {
            return;
        }
        Stack s = STACK.get();
        boolean wasBusy = s.busy;
        s.busy = true;
        try {
            String doc;
            synchronized (LOCK) {
                long total = UNCAUGHT.size();
                for (int i = 0; i < fnCount; i++) {
                    total += fns[i].calls;
                }
                if (total == lastWritten || total == 0) {
                    return;
                }
                lastWritten = total;
                doc = document();
            }
            String pid = Main.pid();
            File target = new File(dir);
            target.mkdirs();
            File tmp = new File(target, pid + ".json.tmp");
            Writer out = new OutputStreamWriter(new FileOutputStream(tmp), "UTF-8");
            try {
                out.write(doc);
            } finally {
                out.close();
            }
            File dest = new File(target, pid + ".json");
            if (!tmp.renameTo(dest)) {
                dest.delete();
                tmp.renameTo(dest);
            }
        } catch (Throwable t) {
            // evidence is best effort
        } finally {
            s.busy = wasBusy;
        }
    }

    private static void ref(StringBuilder b, Fn f) {
        b.append("{\"file\":");
        Json.str(b, f.file);
        b.append(",\"name\":");
        Json.str(b, f.name);
        b.append(",\"line\":").append(f.line).append('}');
    }

    private static String document() {
        StringBuilder b = new StringBuilder(4096);
        b.append("{\"version\":1,\"runId\":");
        Json.str(b, runId);
        b.append(",\"pid\":").append(Main.pidNumber()).append(",\"argv\":[\"java\"]");
        b.append(",\"startedAt\":").append(STARTED).append(",\"endedAt\":").append(System.currentTimeMillis());
        b.append(",\"functions\":[");
        int n = 0;
        for (int i = 0; i < fnCount; i++) {
            Fn f = fns[i];
            if (f.calls == 0) {
                continue;
            }
            if (n++ > 0) {
                b.append(',');
            }
            b.append("{\"file\":");
            Json.str(b, f.file);
            b.append(",\"name\":");
            Json.str(b, f.name);
            b.append(",\"line\":").append(f.line).append(",\"calls\":").append(f.calls).append(",\"errors\":").append(f.errors);
            b.append(",\"ms\":");
            Json.num(b, Math.round(f.ns / 1000.0) / 1000.0);
            b.append('}');
        }
        b.append("],\"edges\":[");
        n = 0;
        for (Map.Entry<Long, long[]> e : EDGES.entrySet()) {
            if (n++ > 0) {
                b.append(',');
            }
            b.append("{\"from\":");
            ref(b, fns[(int) (e.getKey() >> 32)]);
            b.append(",\"to\":");
            ref(b, fns[(int) (e.getKey() & 0xffffffffL)]);
            b.append(",\"calls\":").append(e.getValue()[0]).append('}');
        }
        b.append("],\"edgesDropped\":").append(edgesDropped).append(",\"watched\":[");
        n = 0;
        for (int i = 0; i < fnCount; i++) {
            Watch w = fns[i].watch;
            if (w == null || w.calls == 0) {
                continue;
            }
            if (n++ > 0) {
                b.append(',');
            }
            w.json(b);
        }
        b.append("],\"uncaught\":").append(UNCAUGHT).append('}');
        return b.toString();
    }
}

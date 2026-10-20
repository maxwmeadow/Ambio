import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.file.Files;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.commons.ClassRemapper;
import org.objectweb.asm.commons.Remapper;

/**
 * Build-time only. Moves ASM into the agent's own package, so the copy inside
 * ambio-agent.jar can never meet the ASM a user's project ships (Spring,
 * Hibernate and most build tools carry one).
 *
 * usage: Shade <out dir> <classes dir | jar>
 */
public final class Shade {
    private static final String FROM = "org/objectweb/asm/";
    private static final String TO = "dev/ambio/agent/asm/";

    private static final Remapper REMAPPER = new Remapper() {
        @Override
        public String map(String internalName) {
            return internalName.startsWith(FROM) ? TO + internalName.substring(FROM.length()) : internalName;
        }
    };

    public static void main(String[] args) throws Exception {
        File out = new File(args[0]);
        File in = new File(args[1]);
        if (in.isDirectory()) {
            walk(in, in, out);
            return;
        }
        try (ZipFile zip = new ZipFile(in)) {
            for (Enumeration<? extends ZipEntry> e = zip.entries(); e.hasMoreElements();) {
                ZipEntry entry = e.nextElement();
                String name = entry.getName();
                if (!name.endsWith(".class") || name.equals("module-info.class")) {
                    continue;
                }
                try (InputStream stream = zip.getInputStream(entry)) {
                    write(out, read(stream));
                }
            }
        }
    }

    private static void walk(File root, File dir, File out) throws Exception {
        for (File f : dir.listFiles()) {
            if (f.isDirectory()) {
                walk(root, f, out);
            } else if (f.getName().endsWith(".class")) {
                write(out, Files.readAllBytes(f.toPath()));
            }
        }
    }

    private static byte[] read(InputStream in) throws Exception {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        for (int n; (n = in.read(chunk)) > 0;) {
            buffer.write(chunk, 0, n);
        }
        return buffer.toByteArray();
    }

    private static void write(File out, byte[] classBytes) throws Exception {
        ClassReader reader = new ClassReader(classBytes);
        ClassWriter writer = new ClassWriter(0);
        reader.accept(new ClassRemapper(writer, REMAPPER), 0);
        File target = new File(out, REMAPPER.map(reader.getClassName()) + ".class");
        target.getParentFile().mkdirs();
        Files.write(target.toPath(), writer.toByteArray());
    }
}

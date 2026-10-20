package dev.ambio.agent.rt;

import java.io.File;
import java.lang.instrument.Instrumentation;
import java.net.URL;
import java.security.CodeSource;
import java.security.ProtectionDomain;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Starts the recorder inside a JVM that archd launched as a run. */
public final class Main {
    private Main() {}

    private static final class Spec {
        String symbol;
        int lineStart;
        int lineEnd;
    }

    private static String root = "";
    /** Source files in the workspace, by file name. */
    private static final Map<String, List<String>> SOURCES = new HashMap<String, List<String>>();
    private static final Map<String, List<Spec>> WATCHES = new HashMap<String, List<Spec>>();
    private static final ConcurrentHashMap<String, Boolean> LOCATIONS = new ConcurrentHashMap<String, Boolean>();
    private static String pid;

    private static final String[] SOURCE_EXTENSIONS = {".java", ".kt", ".kts", ".scala", ".groovy"};
    private static final int MAX_SOURCES = 60000;

    public static void start(Instrumentation inst) {
        Rec.dir = System.getenv("AMBIO_EVIDENCE_DIR");
        String id = System.getenv("AMBIO_RUN_ID");
        Rec.runId = id == null ? "" : id;
        String workspace = System.getenv("AMBIO_WORKSPACE_ROOT");
        root = canonical(workspace == null || workspace.isEmpty() ? System.getProperty("user.dir") : workspace);
        index(new File(root), 0);
        readWatches(System.getenv("AMBIO_WATCHES"));

        inst.addTransformer(new Transformer());

        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            public void uncaughtException(Thread thread, Throwable error) {
                Rec.uncaught(error);
                Rec.write();
                if (previous != null) {
                    previous.uncaughtException(thread, error);
                } else if (!(error instanceof ThreadDeath)) {
                    // What the JVM prints when no handler is installed.
                    System.err.print("Exception in thread \"" + thread.getName() + "\" ");
                    error.printStackTrace();
                }
            }
        });
        Runtime.getRuntime().addShutdownHook(new Thread("ambio-recorder-exit") {
            @Override
            public void run() {
                Rec.write();
            }
        });
        // A killed process (timeout, a stopped server) skips shutdown hooks on
        // SIGKILL; flush periodically.
        Thread flusher = new Thread("ambio-recorder-flush") {
            @Override
            public void run() {
                while (true) {
                    try {
                        Thread.sleep(1000);
                    } catch (InterruptedException e) {
                        return;
                    }
                    Rec.write();
                }
            }
        };
        flusher.setDaemon(true);
        flusher.start();
    }

    static String canonical(String path) {
        try {
            return new File(path).getCanonicalPath();
        } catch (Throwable t) {
            return new File(path).getAbsolutePath();
        }
    }

    private static boolean skippedDir(String name) {
        return name.startsWith(".") || name.equals("node_modules") || name.equals("build") || name.equals("target")
            || name.equals("out") || name.equals("bin") || name.equals("dist");
    }

    private static int indexed;

    private static void index(File dir, int depth) {
        File[] entries = dir.listFiles();
        if (entries == null || depth > 40) {
            return;
        }
        for (File entry : entries) {
            if (indexed >= MAX_SOURCES) {
                return;
            }
            String name = entry.getName();
            if (entry.isDirectory()) {
                if (!skippedDir(name)) {
                    index(entry, depth + 1);
                }
                continue;
            }
            for (String ext : SOURCE_EXTENSIONS) {
                if (name.endsWith(ext)) {
                    List<String> paths = SOURCES.get(name);
                    if (paths == null) {
                        paths = new ArrayList<String>(1);
                        SOURCES.put(name, paths);
                    }
                    paths.add(entry.getPath());
                    indexed++;
                    break;
                }
            }
        }
    }

    /**
     * The source file a class was compiled from: the one named by its
     * SourceFile attribute in the folder its package names, or - Kotlin lets
     * a file live anywhere - the only file of that name. Null when the class
     * was not compiled from a file in the workspace.
     */
    static String sourceFor(String internalName, String sourceFile) {
        List<String> candidates = SOURCES.get(sourceFile);
        if (candidates == null) {
            return null;
        }
        int slash = internalName.lastIndexOf('/');
        String suffix = (slash < 0 ? "" : internalName.substring(0, slash + 1)).replace('/', File.separatorChar) + sourceFile;
        for (String path : candidates) {
            if (path.endsWith(File.separator + suffix)) {
                return path;
            }
        }
        return candidates.size() == 1 ? candidates.get(0) : null;
    }

    /** Whether a class was loaded from inside the workspace (not a dependency). */
    static boolean inWorkspace(ProtectionDomain domain) {
        if (domain == null) {
            return false;
        }
        CodeSource source = domain.getCodeSource();
        URL location = source == null ? null : source.getLocation();
        if (location == null) {
            return false;
        }
        String key = location.toString();
        Boolean hit = LOCATIONS.get(key);
        if (hit == null) {
            hit = under(key);
            LOCATIONS.put(key, hit);
        }
        return hit;
    }

    private static boolean under(String url) {
        try {
            // file:/ws/build/classes/, jar:file:/ws/app.jar!/BOOT-INF/classes!/, jar:nested:/ws/app.jar/!BOOT-INF/...
            String path = url;
            for (String scheme : new String[] {"jar:", "nested:", "file:"}) {
                if (path.startsWith(scheme)) {
                    path = path.substring(scheme.length());
                }
            }
            int bang = path.indexOf('!');
            if (bang >= 0) {
                path = path.substring(0, bang);
            }
            path = canonical(java.net.URLDecoder.decode(path.replace("+", "%2B"), "UTF-8"));
            if (!path.startsWith(root + File.separator)) {
                return false;
            }
            String rel = path.substring(root.length()).replace(File.separatorChar, '/') + "/";
            return !rel.contains("/.gradle/") && !rel.contains("/.m2/") && !rel.contains("/node_modules/");
        } catch (Throwable t) {
            return false;
        }
    }

    @SuppressWarnings("unchecked")
    private static void readWatches(String json) {
        Object parsed = json == null ? null : Json.parse(json);
        if (!(parsed instanceof List)) {
            return;
        }
        for (Object item : (List<Object>) parsed) {
            if (!(item instanceof Map)) {
                continue;
            }
            Map<String, Object> w = (Map<String, Object>) item;
            Object path = w.get("absPath") != null ? w.get("absPath") : w.get("file");
            if (!(path instanceof String) || ((String) path).isEmpty()) {
                continue;
            }
            Spec spec = new Spec();
            spec.symbol = w.get("symbol") instanceof String && !((String) w.get("symbol")).isEmpty() ? (String) w.get("symbol") : "*";
            spec.lineStart = w.get("lineStart") instanceof Number ? ((Number) w.get("lineStart")).intValue() : 0;
            spec.lineEnd = w.get("lineEnd") instanceof Number ? ((Number) w.get("lineEnd")).intValue() : 0;
            String file = canonical((String) path);
            List<Spec> specs = WATCHES.get(file);
            if (specs == null) {
                specs = new ArrayList<Spec>();
                WATCHES.put(file, specs);
            }
            specs.add(spec);
        }
    }

    /** Whether a method is one the run was asked to watch. */
    static boolean watched(String file, String name, int line) {
        List<Spec> specs = WATCHES.get(canonical(file));
        if (specs == null) {
            return false;
        }
        int named = 0;
        for (Spec s : specs) {
            if (s.symbol.equals("*")) {
                return true;
            }
            if (!s.symbol.equals(name) && !s.symbol.endsWith("." + name)) {
                continue;
            }
            named++;
            // The line table starts at the first statement; the index's range
            // starts at the declaration, annotations included.
            if (s.lineStart == 0 || (s.lineStart - 3 <= line && line <= Math.max(s.lineEnd, s.lineStart))) {
                return true;
            }
        }
        return named == 1;
    }

    static synchronized String pid() {
        if (pid == null) {
            try {
                // ProcessHandle is Java 9+; the agent also runs on 8.
                Class<?> handle = Class.forName("java.lang.ProcessHandle");
                Object current = handle.getMethod("current").invoke(null);
                pid = String.valueOf(handle.getMethod("pid").invoke(current));
            } catch (Throwable t) {
                try {
                    String name = java.lang.management.ManagementFactory.getRuntimeMXBean().getName();
                    pid = name.substring(0, name.indexOf('@'));
                } catch (Throwable u) {
                    pid = String.valueOf(System.nanoTime() % 1000000);
                }
            }
        }
        return pid;
    }

    static long pidNumber() {
        try {
            return Long.parseLong(pid());
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}

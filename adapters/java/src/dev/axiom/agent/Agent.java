package dev.axiom.agent;

import java.io.File;
import java.lang.instrument.Instrumentation;
import java.util.jar.JarFile;

/**
 * Run recorder for `investigation run` - the JVM twin of recorder.cjs,
 * recorder.py and axiom_recorder.rb. archd launches the command with
 * JAVA_TOOL_OPTIONS=-javaagent:<this jar>, which every JVM the command starts
 * picks up (java, Maven Surefire forks, Gradle test workers), so Java, Kotlin
 * and Scala record with nothing installed. Without AXIOM_EVIDENCE_DIR it does
 * nothing.
 *
 * Instrumented classes call the recorder from whatever class loader loaded
 * them, so the recorder goes on the bootstrap search path, where every loader
 * finds it; this class only puts it there.
 */
public final class Agent {
    private Agent() {}

    public static void premain(String args, Instrumentation inst) {
        try {
            String dir = System.getenv("AXIOM_EVIDENCE_DIR");
            if (dir == null || dir.isEmpty()) {
                return;
            }
            File jar = new File(Agent.class.getProtectionDomain().getCodeSource().getLocation().toURI());
            inst.appendToBootstrapClassLoaderSearch(new JarFile(jar));
            Class<?> main = Class.forName("dev.axiom.agent.rt.Main", true, null);
            main.getMethod("start", Instrumentation.class).invoke(null, inst);
        } catch (Throwable t) {
            // Never break the program being observed.
        }
    }
}

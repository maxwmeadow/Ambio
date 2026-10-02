// Axiom's C# instrumenter for `investigation run`.
//
// MSBuild runs this before a project compiles (Axiom.targets, imported through
// CustomAfterMicrosoftCommonTargets when archd starts a run). It writes
// instrumented copies of the project's C# files next to the build's other
// intermediates and tells MSBuild to compile those instead. The user's files
// are never written.
//
// Each function gains code on the lines it already has, so every line number -
// in stack traces, in the debugger, in the evidence - is the user's own, and a
// #line directive keeps the original path in debug information. Roslyn is not
// shipped: the SDK that is about to compile the project supplies it.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text;

internal static class Program
{
    private static int Main(string[] args)
    {
        string outDir = null;
        try
        {
            var inputs = Inputs.Read(args[0]);
            outDir = inputs.Out;
            // A stale list from an earlier build must not survive a failure here.
            File.Delete(Path.Combine(outDir, "compile.txt"));
            string roslyn = Path.Combine(inputs.Roslyn, "bincore");
            AssemblyLoadContext.Default.Resolving += (context, name) =>
            {
                string candidate = Path.Combine(roslyn, name.Name + ".dll");
                return File.Exists(candidate) ? context.LoadFromAssemblyPath(candidate) : null;
            };
            Run(inputs);
        }
        catch (Exception error)
        {
            // The build goes on with the project's own files.
            if (Environment.GetEnvironmentVariable("AXIOM_RECORDER_DEBUG") != null) Console.Error.WriteLine("[axiom] not recording this project: " + error);
        }
        return 0;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run(Inputs inputs)
    {
        Instrumenter.Run(inputs);
    }
}

internal sealed class Inputs
{
    public string Roslyn = "", Out = "", Assembly = "", LangVersion = "", Nullable = "", Root = "";
    public List<string> Defines = new List<string>(), Compile = new List<string>(), References = new List<string>();
    public List<string> Analyzers = new List<string>(), Additional = new List<string>(), EditorConfigs = new List<string>();

    public static Inputs Read(string file)
    {
        var inputs = new Inputs();
        foreach (string line in File.ReadAllLines(file))
        {
            int eq = line.IndexOf('=');
            if (eq < 0) continue;
            string key = line.Substring(0, eq), value = line.Substring(eq + 1);
            switch (key)
            {
                case "roslyn": inputs.Roslyn = value; break;
                case "out": inputs.Out = value; break;
                case "assembly": inputs.Assembly = value; break;
                case "langversion": inputs.LangVersion = value; break;
                case "nullable": inputs.Nullable = value; break;
                case "defines": inputs.Defines.AddRange(value.Split(new[] { ';', ',' }, StringSplitOptions.RemoveEmptyEntries).Select(d => d.Trim())); break;
                case "compile": inputs.Compile.Add(value); break;
                case "reference": inputs.References.Add(value); break;
                case "analyzer": inputs.Analyzers.Add(value); break;
                case "additional": inputs.Additional.Add(value); break;
                case "editorconfig": inputs.EditorConfigs.Add(value); break;
            }
        }
        string root = Environment.GetEnvironmentVariable("AXIOM_WORKSPACE_ROOT");
        inputs.Root = Path.GetFullPath(string.IsNullOrEmpty(root) ? Directory.GetCurrentDirectory() : root)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return inputs;
    }

    public static string Hash(string text)
    {
        using (var sha = SHA256.Create())
        {
            byte[] sum = sha.ComputeHash(Encoding.UTF8.GetBytes(text));
            var b = new StringBuilder();
            for (int i = 0; i < 6; i++) b.Append(sum[i].ToString("x2"));
            return b.ToString();
        }
    }

    /// <summary>The recorder source, compiled into the project under a name unique to its assembly.</summary>
    public static string RecorderSource(string className)
    {
        using (Stream stream = typeof(Inputs).Assembly.GetManifestResourceStream("AxiomRec.cs"))
        using (var reader = new StreamReader(stream))
        {
            return reader.ReadToEnd().Replace("__AxiomRec", className);
        }
    }
}

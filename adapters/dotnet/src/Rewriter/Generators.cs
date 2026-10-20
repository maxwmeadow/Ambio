using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;

/// <summary>
/// The project's own source generators, run the way the compiler runs them.
///
/// A generator reads the project's syntax and writes more code. Some copy a
/// method's body into the code they write (a generator that derives a
/// synchronous method from an async one does), and then the rewriter's added
/// code is copied too, into a method it was not written for. So the rewriter
/// checks its work against what the generators produce from it, and reads
/// types the generators declare while deciding what is safe to add.
/// </summary>
internal sealed class Generators
{
    private GeneratorDriver driver;

    public bool Any { get { return driver != null; } }

    public static Generators Load(Inputs inputs, CSharpParseOptions parse)
    {
        var result = new Generators();
        try
        {
            var loader = new Loader(inputs.Analyzers);
            var generators = new List<ISourceGenerator>();
            foreach (string path in inputs.Analyzers.Where(File.Exists))
            {
                try { generators.AddRange(new AnalyzerFileReference(path, loader).GetGenerators(LanguageNames.CSharp)); }
                catch (Exception) { /* an analyzer assembly with no generators, or one that will not load here */ }
            }
            if (generators.Count == 0) return result;
            var additional = inputs.Additional.Where(File.Exists).Select(p => (AdditionalText)new FileText(p)).ToImmutableArray();
            result.driver = CSharpGeneratorDriver.Create(generators, additional, parse, new ConfigOptions(inputs.EditorConfigs));
        }
        catch (Exception error)
        {
            if (Environment.GetEnvironmentVariable("AMBIO_RECORDER_DEBUG") != null) Console.Error.WriteLine("[ambio] source generators not run: " + error.Message);
            result.driver = null;
        }
        return result;
    }

    /// <summary>The compilation with generated code added, and the problems the generated code has.</summary>
    public CSharpCompilation Run(CSharpCompilation compilation, out int problems)
    {
        problems = 0;
        if (driver == null) return compilation;
        Compilation updated;
        ImmutableArray<Diagnostic> reported;
        driver = driver.RunGeneratorsAndUpdateCompilation(compilation, out updated, out reported);
        problems = reported.Count(d => d.Severity >= DiagnosticSeverity.Warning);
        var before = new HashSet<SyntaxTree>(compilation.SyntaxTrees);
        foreach (SyntaxTree tree in updated.SyntaxTrees)
        {
            if (!before.Contains(tree)) problems += updated.GetSemanticModel(tree).GetDiagnostics().Count(d => d.Severity >= DiagnosticSeverity.Warning);
        }
        return (CSharpCompilation)updated;
    }

    /// <summary>Loads a generator and what it depends on from beside it; anything else comes from the compiler.</summary>
    private sealed class Loader : AssemblyLoadContext, IAnalyzerAssemblyLoader
    {
        private readonly Dictionary<string, string> beside = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public Loader(IEnumerable<string> analyzers) : base("ambio-generators")
        {
            foreach (string path in analyzers) AddDependencyLocation(path);
        }

        public void AddDependencyLocation(string fullPath)
        {
            string dir = Path.GetDirectoryName(fullPath);
            if (dir == null || !Directory.Exists(dir)) return;
            foreach (string file in Directory.GetFiles(dir, "*.dll"))
            {
                string name = Path.GetFileNameWithoutExtension(file);
                if (!beside.ContainsKey(name)) beside[name] = file;
            }
        }

        public Assembly LoadFromPath(string fullPath)
        {
            return LoadFromAssemblyPath(fullPath);
        }

        protected override Assembly Load(AssemblyName name)
        {
            // The compiler's own assemblies must be the ones this tool already
            // uses, or a generator's ISourceGenerator would be a different type.
            if (name.Name != null && (name.Name.StartsWith("Microsoft.CodeAnalysis", StringComparison.Ordinal) || name.Name.StartsWith("System.", StringComparison.Ordinal))) return null;
            string path;
            return name.Name != null && beside.TryGetValue(name.Name, out path) ? LoadFromAssemblyPath(path) : null;
        }
    }

    private sealed class FileText : AdditionalText
    {
        private readonly string path;
        public FileText(string path) { this.path = path; }
        public override string Path { get { return path; } }
        public override SourceText GetText(CancellationToken cancellationToken = default(CancellationToken))
        {
            return SourceText.From(File.ReadAllText(path));
        }
    }

    /// <summary>What .editorconfig and the build's generated config say, by file: generators read their settings here.</summary>
    private sealed class ConfigOptions : AnalyzerConfigOptionsProvider
    {
        private readonly AnalyzerConfigSet set;
        private readonly AnalyzerConfigOptions global;

        public ConfigOptions(IEnumerable<string> files)
        {
            var configs = new List<AnalyzerConfig>();
            foreach (string file in files.Where(File.Exists))
            {
                try { configs.Add(AnalyzerConfig.Parse(File.ReadAllText(file), file)); } catch (Exception) { }
            }
            set = AnalyzerConfigSet.Create(configs);
            global = new Options(set.GlobalConfigOptions.AnalyzerOptions);
        }

        public override AnalyzerConfigOptions GlobalOptions { get { return global; } }
        public override AnalyzerConfigOptions GetOptions(SyntaxTree tree) { return new Options(set.GetOptionsForSourcePath(tree.FilePath).AnalyzerOptions); }
        public override AnalyzerConfigOptions GetOptions(AdditionalText textFile) { return new Options(set.GetOptionsForSourcePath(textFile.Path).AnalyzerOptions); }

        private sealed class Options : AnalyzerConfigOptions
        {
            private readonly ImmutableDictionary<string, string> values;
            public Options(ImmutableDictionary<string, string> values) { this.values = values; }
            public override bool TryGetValue(string key, out string value) { return values.TryGetValue(key, out value); }
        }
    }
}

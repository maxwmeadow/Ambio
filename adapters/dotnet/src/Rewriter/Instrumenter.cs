using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

internal static class Instrumenter
{
    public static void Run(Inputs inputs)
    {
        LanguageVersion version;
        if (!LanguageVersionFacts.TryParse(inputs.LangVersion, out version)) version = LanguageVersion.Default;
        version = version.MapSpecifiedToEffectiveVersion();
        if (version < LanguageVersion.CSharp6) return; // exception filters, which the rewrite relies on

        var parse = new CSharpParseOptions(version, DocumentationMode.None, SourceCodeKind.Regular, inputs.Defines);
        string recorder = "__AxiomRec_" + Inputs.Hash(inputs.Assembly);

        var trees = new List<SyntaxTree>();
        foreach (string path in inputs.Compile)
        {
            if (File.Exists(path)) trees.Add(CSharpSyntaxTree.ParseText(File.ReadAllText(path), parse, path));
        }
        var references = inputs.References.Where(File.Exists).Select(r => (MetadataReference)MetadataReference.CreateFromFile(r));
        var options = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true, concurrentBuild: true,
            nullableContextOptions: inputs.Nullable.Equals("enable", StringComparison.OrdinalIgnoreCase) ? NullableContextOptions.Enable : NullableContextOptions.Disable);
        var original = CSharpCompilation.Create(inputs.Assembly, trees, references, options);

        // With the code the project's generators add: a type or a member they
        // declare is then known while deciding what each function can record.
        var generators = Generators.Load(inputs, parse);
        int generatedProblems;
        CSharpCompilation withGenerated = generators.Run(original, out generatedProblems);

        // Rewrite every file of the user's own source.
        var rewritten = new Dictionary<SyntaxTree, SyntaxTree>();
        foreach (SyntaxTree tree in trees)
        {
            if (!Instrumentable(tree.FilePath, inputs.Root, tree)) continue;
            string text = new FileRewriter(withGenerated.GetSemanticModel(tree), tree, recorder, inputs.Assembly).Rewrite();
            if (text != null) rewritten[tree] = CSharpSyntaxTree.ParseText(text, parse, tree.FilePath);
        }
        if (rewritten.Count == 0) return;

        // Never hand the compiler something it would treat differently: a file
        // whose rewrite adds an error or a warning (the project may promote
        // warnings to errors) goes back to the user's original.
        string recorderPath = Path.Combine(inputs.Out, recorder + ".cs");
        string recorderSource = Inputs.RecorderSource(recorder);
        SyntaxTree recorderTree = CSharpSyntaxTree.ParseText(recorderSource, parse, recorderPath);
        Func<ICollection<SyntaxTree>, CSharpCompilation> with = kept =>
        {
            CSharpCompilation c = original.AddSyntaxTrees(recorderTree);
            foreach (SyntaxTree tree in kept) c = c.ReplaceSyntaxTree(tree, rewritten[tree]);
            return c;
        };
        if (Problems(with(new SyntaxTree[0]), recorderTree) > 0) return;

        // A generator that copies a function's body into the code it writes
        // copies the added code with it, into a function it does not fit.
        // Which rewritten files make the generated code worse? Halve until
        // each is found, and give those back as written.
        if (generators.Any)
        {
            Func<List<SyntaxTree>, bool> worse = kept =>
            {
                int problems;
                generators.Run(with(kept), out problems);
                return problems > generatedProblems;
            };
            Func<List<SyntaxTree>, List<SyntaxTree>> culprits = null;
            culprits = set =>
            {
                if (set.Count == 0 || !worse(set)) return new List<SyntaxTree>();
                if (set.Count == 1) return set;
                var found = culprits(set.GetRange(0, set.Count / 2));
                found.AddRange(culprits(set.GetRange(set.Count / 2, set.Count - set.Count / 2)));
                // Neither half alone: the trouble needs both. Rare enough to give up the pair.
                return found.Count > 0 ? found : set;
            };
            foreach (SyntaxTree tree in culprits(rewritten.Keys.ToList()))
            {
                if (Environment.GetEnvironmentVariable("AXIOM_RECORDER_DEBUG") != null) Console.Error.WriteLine("[axiom] not recording " + tree.FilePath + ": a source generator copies its code");
                rewritten.Remove(tree);
            }
            if (rewritten.Count == 0) return;
        }

        int ignored;
        CSharpCompilation before = withGenerated;
        CSharpCompilation after = generators.Run(with(rewritten.Keys.ToList()), out ignored);
        var reverted = new ConcurrentBag<SyntaxTree>();
        Parallel.ForEach(rewritten, pair =>
        {
            int now = Problems(after, pair.Value);
            if (now > 0 && now > Problems(before, pair.Key)) reverted.Add(pair.Key);
        });
        foreach (SyntaxTree tree in reverted)
        {
            if (Environment.GetEnvironmentVariable("AXIOM_RECORDER_DEBUG") != null) Console.Error.WriteLine("[axiom] not recording " + tree.FilePath + ": the rewrite did not compile");
            rewritten.Remove(tree);
        }
        if (rewritten.Count == 0) return;

        Directory.CreateDirectory(inputs.Out);
        var compile = new List<string>();
        foreach (SyntaxTree tree in trees)
        {
            SyntaxTree replacement;
            if (!rewritten.TryGetValue(tree, out replacement))
            {
                compile.Add(tree.FilePath);
                continue;
            }
            string target = Path.Combine(inputs.Out, Inputs.Hash(tree.FilePath) + "_" + Path.GetFileName(tree.FilePath));
            WriteIfChanged(target, replacement.ToString());
            compile.Add(target);
        }
        WriteIfChanged(recorderPath, recorderSource);
        compile.Add(recorderPath);
        File.WriteAllLines(Path.Combine(inputs.Out, "compile.txt"), compile);
    }

    private static int Problems(Compilation compilation, SyntaxTree tree)
    {
        return compilation.GetSemanticModel(tree).GetDiagnostics().Count(d => d.Severity >= DiagnosticSeverity.Warning);
    }

    /// <summary>Unchanged output keeps its timestamp, so an unchanged project is not recompiled.</summary>
    private static void WriteIfChanged(string path, string text)
    {
        if (File.Exists(path) && File.ReadAllText(path) == text) return;
        File.WriteAllText(path, text, new UTF8Encoding(false));
    }

    private static bool Instrumentable(string path, string root, SyntaxTree tree)
    {
        string full = Path.GetFullPath(path);
        var comparison = Path.DirectorySeparatorChar == '\\' ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        if (!full.StartsWith(root + Path.DirectorySeparatorChar, comparison)) return false;
        string relative = full.Substring(root.Length).Replace('\\', '/').ToLowerInvariant();
        if (relative.Contains("/obj/") || relative.Contains("/bin/")) return false;
        if (relative.EndsWith(".g.cs") || relative.EndsWith(".designer.cs") || relative.EndsWith(".generated.cs") || relative.EndsWith("/assemblyinfo.cs")) return false;
        string head = tree.GetText().ToString(new Microsoft.CodeAnalysis.Text.TextSpan(0, Math.Min(600, tree.Length)));
        return head.IndexOf("<auto-generated", StringComparison.OrdinalIgnoreCase) < 0;
    }
}

/// <summary>Rewrites one file. Null when it has nothing to record.</summary>
internal sealed class FileRewriter : CSharpSyntaxWalker
{
    private struct Edit
    {
        public int Start, Length, Order;
        public string Text;
    }

    // Fully qualified, and with the `?` a nullable reference type was declared
    // with: `return null` from a `string?` method must not start warning.
    private static readonly SymbolDisplayFormat TypeName = SymbolDisplayFormat.FullyQualifiedFormat.WithMiscellaneousOptions(
        SymbolDisplayFormat.FullyQualifiedFormat.MiscellaneousOptions | SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier);

    private readonly SemanticModel model;
    private readonly SyntaxTree tree;
    private readonly string recorder;
    private readonly string fileClass;
    private readonly string baseRef;
    private readonly List<Edit> edits = new List<Edit>();
    private readonly List<string> specs = new List<string>();

    public FileRewriter(SemanticModel model, SyntaxTree tree, string recorder, string assembly)
    {
        this.model = model;
        this.tree = tree;
        this.recorder = recorder;
        fileClass = "__AxiomFile_" + Inputs.Hash(assembly + "|" + tree.FilePath);
        // A file-scoped namespace takes in everything after it, the class
        // appended at the end of the file included.
        var scoped = tree.GetCompilationUnitRoot().Members.OfType<FileScopedNamespaceDeclarationSyntax>().FirstOrDefault();
        baseRef = "global::" + (scoped == null ? "" : scoped.Name.ToString().Replace(" ", "") + ".") + fileClass + ".B";
    }

    public string Rewrite()
    {
        Visit(tree.GetRoot());
        if (specs.Count == 0) return null;
        string source = tree.GetText().ToString();
        var b = new StringBuilder(source.Length + edits.Count * 220);
        b.Append("#line 1 \"").Append(tree.FilePath).Append("\"\n");
        int last = 0;
        foreach (Edit edit in edits.OrderBy(e => e.Start).ThenBy(e => e.Order))
        {
            b.Append(source, last, edit.Start - last).Append(edit.Text);
            last = edit.Start + edit.Length;
        }
        b.Append(source, last, source.Length - last);
        b.Append("\n#line hidden\n[global::System.Runtime.CompilerServices.CompilerGenerated] internal static class ").Append(fileClass)
            .Append(" { internal static readonly int B = global::").Append(recorder).Append(".Register(@\"").Append(tree.FilePath.Replace("\"", "\"\"")).Append('"');
        foreach (string spec in specs) b.Append(", \"").Append(spec).Append('"');
        b.Append("); }\n");
        return b.ToString();
    }

    private void Insert(int at, string text)
    {
        edits.Add(new Edit { Start = at, Length = 0, Order = edits.Count, Text = text });
    }

    private void Replace(SyntaxToken token, string text)
    {
        edits.Add(new Edit { Start = token.SpanStart, Length = token.Span.Length, Order = edits.Count, Text = text });
    }

    public override void VisitMethodDeclaration(MethodDeclarationSyntax node)
    {
        Handle(model.GetDeclaredSymbol(node) as IMethodSymbol, node.Identifier, node.Identifier.Text, node.Body, node.ExpressionBody, node.SemicolonToken, false);
        base.VisitMethodDeclaration(node);
    }

    public override void VisitConstructorDeclaration(ConstructorDeclarationSyntax node)
    {
        if (!node.Modifiers.Any(SyntaxKind.StaticKeyword))
        {
            Handle(model.GetDeclaredSymbol(node) as IMethodSymbol, node.Identifier, node.Identifier.Text, node.Body, node.ExpressionBody, node.SemicolonToken, false);
        }
        base.VisitConstructorDeclaration(node);
    }

    public override void VisitLocalFunctionStatement(LocalFunctionStatementSyntax node)
    {
        Handle(model.GetDeclaredSymbol(node) as IMethodSymbol, node.Identifier, node.Identifier.Text, node.Body, node.ExpressionBody, node.SemicolonToken, false);
        base.VisitLocalFunctionStatement(node);
    }

    public override void VisitPropertyDeclaration(PropertyDeclarationSyntax node)
    {
        if (node.ExpressionBody != null && !Trivial(node.ExpressionBody.Expression))
        {
            var property = model.GetDeclaredSymbol(node) as IPropertySymbol;
            Handle(property == null ? null : property.GetMethod, node.Identifier, "get_" + node.Identifier.Text, null, node.ExpressionBody, node.SemicolonToken, true);
        }
        base.VisitPropertyDeclaration(node);
    }

    public override void VisitAccessorDeclaration(AccessorDeclarationSyntax node)
    {
        var property = node.Parent == null ? null : node.Parent.Parent as PropertyDeclarationSyntax;
        if (property != null && (node.Body != null || node.ExpressionBody != null) && !TrivialAccessor(node))
        {
            string prefix = node.Keyword.IsKind(SyntaxKind.GetKeyword) ? "get_" : "set_";
            Handle(model.GetDeclaredSymbol(node) as IMethodSymbol, property.Identifier, prefix + property.Identifier.Text, node.Body, node.ExpressionBody, node.SemicolonToken, false);
        }
        base.VisitAccessorDeclaration(node);
    }

    /// <summary>A field read or write and nothing else: `x`, `this.x`, `_x = value`.</summary>
    private static bool Trivial(ExpressionSyntax e)
    {
        if (e is IdentifierNameSyntax || e is LiteralExpressionSyntax) return true;
        var member = e as MemberAccessExpressionSyntax;
        if (member != null) return member.Expression is ThisExpressionSyntax;
        var assignment = e as AssignmentExpressionSyntax;
        return assignment != null && assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) && Trivial(assignment.Left) && Trivial(assignment.Right);
    }

    private static bool TrivialAccessor(AccessorDeclarationSyntax node)
    {
        if (node.ExpressionBody != null) return Trivial(node.ExpressionBody.Expression);
        if (node.Body.Statements.Count != 1) return node.Body.Statements.Count == 0;
        var returned = node.Body.Statements[0] as ReturnStatementSyntax;
        if (returned != null) return returned.Expression != null && Trivial(returned.Expression);
        var statement = node.Body.Statements[0] as ExpressionStatementSyntax;
        return statement != null && Trivial(statement.Expression);
    }

    private static bool Nested(SyntaxNode n)
    {
        return n is AnonymousFunctionExpressionSyntax || n is LocalFunctionStatementSyntax;
    }

    private static bool Boxable(ITypeSymbol type)
    {
        if (type == null || type.IsRefLikeType || type.SpecialType == SpecialType.System_Void) return false;
        if (type.TypeKind == TypeKind.Pointer || type.TypeKind == TypeKind.FunctionPointer || type.TypeKind == TypeKind.Error) return false;
        if (type is ITypeParameterSymbol)
        {
            // `allows ref struct` (C# 13); the property is absent from older compilers.
            var allows = type.GetType().GetProperty("AllowsRefLikeType");
            if (allows != null && true.Equals(allows.GetValue(type))) return false;
        }
        return true;
    }

    /// <summary>Whether a type can be written out as a type argument.</summary>
    private static bool Nameable(ITypeSymbol type)
    {
        if (!Boxable(type) || type.TypeKind == TypeKind.Dynamic) return false;
        var array = type as IArrayTypeSymbol;
        if (array != null) return Nameable(array.ElementType);
        var named = type as INamedTypeSymbol;
        if (named == null) return type is ITypeParameterSymbol;
        if (named.IsAnonymousType || named.IsStatic) return false;
        foreach (ITypeSymbol argument in named.TypeArguments)
        {
            if (argument.TypeKind == TypeKind.Dynamic ? false : !Nameable(argument)) return false;
        }
        return named.ContainingType == null || Nameable(named.ContainingType);
    }

    private void Handle(IMethodSymbol symbol, SyntaxToken identifier, string name, BlockSyntax body, ArrowExpressionClauseSyntax arrow, SyntaxToken semicolon, bool property)
    {
        if (symbol == null || (body == null && arrow == null) || symbol.IsVararg || symbol.IsExtern || symbol.IsAbstract) return;
        int n = specs.Count;
        bool iterator = body != null && body.DescendantNodes(c => !Nested(c)).Any(x => x is YieldStatementSyntax);

        bool hasValue;
        if (symbol.IsAsync)
        {
            var returned = symbol.ReturnType as INamedTypeSymbol;
            hasValue = returned != null && returned.IsGenericType && returned.TypeArguments.Length == 1;
        }
        else
        {
            hasValue = !symbol.ReturnsVoid;
        }
        bool byRef = symbol.ReturnsByRef || symbol.ReturnsByRefReadonly;

        var parameters = symbol.Parameters.Where(p => p.RefKind != RefKind.Out && Boxable(p.Type) && !string.IsNullOrEmpty(p.Name)).ToList();
        bool receiver = !symbol.IsStatic && symbol.MethodKind != MethodKind.LocalFunction && symbol.ContainingType != null
            && !symbol.ContainingType.IsRefLikeType && !(symbol.MethodKind == MethodKind.Constructor && symbol.ContainingType.IsValueType);

        string call = "__ax" + n;
        string rec = "global::" + recorder;
        string values = parameters.Count == 0 ? "new object[0]" : "new object[] { " + string.Join(", ", parameters.Select(p => "@" + p.Name)) + " }";
        string enter = " var " + call + " = " + rec + ".Enter(" + baseRef + ", " + n + "); if (" + call + ".W) " + rec + ".Args(" + call + ", "
            + (receiver ? "this" : "null") + ", " + values + "); try {";
        // An iterator cannot yield inside a try that has a catch.
        string leave = (iterator ? " }" : " } catch (global::System.Exception __axe" + n + ") when (" + rec + ".Thrown(" + call + ", __axe" + n + ")) { throw; }")
            + " finally { " + rec + ".Exit(" + call + "); } ";

        int line = tree.GetLineSpan(identifier.Span).StartLinePosition.Line + 1;
        var names = parameters.Select(p => p.Name).ToList();
        if (receiver) names.Add("this");
        // What the recorder shows when a result exists but cannot be captured.
        string result = iterator ? "iterator" : hasValue && (byRef || !Nameable(Result(symbol))) ? "uncaptured" : "";
        specs.Add(name + ":" + line + ":" + string.Join(",", names) + ":" + result);

        if (body != null)
        {
            Insert(body.OpenBraceToken.Span.End, enter);
            if (hasValue && !byRef && !iterator)
            {
                foreach (var returned in body.DescendantNodes(c => !Nested(c)).OfType<ReturnStatementSyntax>())
                {
                    if (returned.Expression != null) Wrap(returned.Expression, call);
                }
            }
            Insert(body.CloseBraceToken.SpanStart, leave);
            return;
        }

        ExpressionSyntax expression = arrow.Expression;
        bool statement = !hasValue || expression is ThrowExpressionSyntax;
        string open = (property ? "{ get {" : "{") + enter + (statement ? " " : " return ");
        Replace(arrow.ArrowToken, open);
        if (!statement && !byRef) Wrap(expression, call);
        Replace(semicolon, ";" + leave + (property ? "} }" : "}"));
    }

    /// <summary>The type a `return` hands back: T for an async method returning Task&lt;T&gt;.</summary>
    private static ITypeSymbol Result(IMethodSymbol symbol)
    {
        var named = symbol.ReturnType as INamedTypeSymbol;
        return symbol.IsAsync && named != null && named.TypeArguments.Length == 1 ? named.TypeArguments[0] : symbol.ReturnType;
    }

    /// <summary>
    /// `return X` becomes `return Rec.Ret&lt;T&gt;(call, X)`. T is always written
    /// out: X then converts exactly as it did (a literal 1 to a byte, null or
    /// `new()` to their target), which type inference would not guarantee.
    /// </summary>
    private void Wrap(ExpressionSyntax expression, string call)
    {
        if (expression is RefExpressionSyntax || expression is ThrowExpressionSyntax) return;
        TypeInfo info = model.GetTypeInfo(expression);
        ITypeSymbol converted = info.ConvertedType;
        if (converted == null || !Nameable(converted)) return;
        if (info.Type != null && info.Type.TypeKind == TypeKind.Dynamic) return;
        Insert(expression.SpanStart, "global::" + recorder + ".Ret<" + converted.ToDisplayString(TypeName) + ">(" + call + ", ");
        Insert(expression.Span.End, ")");
    }
}

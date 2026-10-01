import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ADAPTER = dirname(fileURLToPath(import.meta.url))
const dotnet = process.env.DOTNET_ROOT ? join(process.env.DOTNET_ROOT, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet') : 'dotnet'
const probe = spawnSync(dotnet, ['--version'], { encoding: 'utf8', timeout: 60_000 })
const SDK = probe.status === 0 ? Number(probe.stdout.split('.')[0]) : 0
const skip = SDK < 6 && 'no .NET SDK 6+'
const quiet = { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' }

const PROJECT = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net${SDK}.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
  </PropertyGroup>
</Project>
`

/** A workspace with one project; `run` builds and runs it, with or without Axiom's build hook. */
function workspace(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axiom-csrec-')))
  const app = join(root, 'App')
  mkdirSync(app)
  writeFileSync(join(app, 'App.csproj'), PROJECT)
  for (const [name, code] of Object.entries(files)) writeFileSync(join(app, name), code)
  const evidence = join(root, '.evidence')
  const run = (watches, { record = true, args = ['run'] } = {}) => {
    const env = { ...process.env, ...quiet, MSBUILDDISABLENODEREUSE: '1', UseSharedCompilation: 'false' }
    if (record) {
      Object.assign(env, {
        CustomAfterMicrosoftCommonTargets: join(ADAPTER, 'Axiom.targets'),
        AXIOM_WORKSPACE_ROOT: root,
        AXIOM_EVIDENCE_DIR: evidence,
        AXIOM_WATCHES: JSON.stringify(watches.map(([file, symbol]) => ({ absPath: join(app, file), symbol }))),
      })
    }
    const result = spawnSync(dotnet, args, { cwd: app, encoding: 'utf8', timeout: 600_000, env })
    const docs = existsSync(evidence)
      ? readdirSync(evidence).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(evidence, f), 'utf8')))
      : []
    const doc = docs[0] ?? { functions: [], watched: [], edges: [], uncaught: [] }
    return {
      doc, status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr,
      watched: symbol => doc.watched.find(w => w.symbol === symbol),
      fn: name => doc.functions.find(f => f.name === name),
    }
  }
  return { root, app, run }
}

const STOCK = `namespace Shop;

public record Order(string Item, long Qty);

public class Stock
{
    private readonly Dictionary<string, int> levels = new() { ["widget"] = 10 };

    public Dictionary<string, int> Levels => levels;

    public int Reserve(Dictionary<string, int> stock, string item, int qty)
    {
        int have = stock.GetValueOrDefault(item);
        if (qty > have)
        {
            throw new ArgumentException("not enough " + item);
        }
        stock[item] = have - qty;
        return have - qty;
    }

    public static double Price(Order order)
    {
        try
        {
            return Lookup(order.Item);
        }
        catch (InvalidOperationException)
        {
            return 0.5;
        }
    }

    static double Lookup(string item) => item == "gadget" ? throw new InvalidOperationException("no price for " + item) : 2.5;

    public static async Task<string?> DescribeAsync(Order order)
    {
        await Task.Delay(5);
        if (order.Qty == 0) return null;
        return $"{order.Qty} x {order.Item}";
    }
}
`
const MAIN = `using Shop;

var s = new Stock();
for (int i = 0; i < 3; i++) s.Reserve(s.Levels, "widget", 3);
Console.WriteLine(Stock.Price(new Order("widget", 2)) + " " + Stock.Price(new Order("gadget", 1)));
Console.WriteLine(await Stock.DescribeAsync(new Order("widget", 2)) + "|" + (await Stock.DescribeAsync(new Order("widget", 0)) ?? "none"));
s.Reserve(s.Levels, "widget", 3);
`

test('a C# run records arguments by name, mutations, awaited results and the crash', { skip }, () => {
  const ws = workspace({ 'Stock.cs': STOCK, 'Program.cs': MAIN })
  const r = ws.run([['Stock.cs', 'Reserve'], ['Stock.cs', 'Price'], ['Stock.cs', 'DescribeAsync']])
  assert.match(r.stdout, /2\.5 0\.5\n2 x widget\|none/)
  // The program's own crash report is untouched: real names, real lines.
  assert.match(r.output, /ArgumentException: not enough widget\n\s+at Shop\.Stock\.Reserve\(.*\) in .*Stock\.cs:line 16/)
  assert.doesNotMatch(r.output, /warning/i, 'the rewrite adds no warnings to the build')

  const reserve = r.watched('Reserve')
  assert.equal(reserve.calls, 4)
  assert.equal(reserve.line, 11)
  assert.equal(reserve.samples[0].args, '{"stock": {"widget": 10}, "item": "widget", "qty": 3, "this": Stock(levels={"widget": 10})}')
  assert.equal(reserve.samples[0].returned, '7')
  assert.equal(reserve.samples[3].threw, 'ArgumentException: not enough widget')
  assert.deepEqual(reserve.mutations.find(m => m.path === 'stock.widget').examples.slice(0, 2).map(e => `${e.before}>${e.after}`), ['10>7', '7>4'])
  assert.deepEqual(reserve.shared.find(x => x.param === 'stock'), { param: 'stock', calls: 3, firstCall: 1 })

  // An exception a method handles itself is not that method failing.
  assert.deepEqual(r.watched('Price').samples.map(x => x.returned), ['2.5', '0.5'])
  assert.equal(r.fn('Price').errors, 0)
  assert.equal(r.fn('Lookup').errors, 1)
  // An async method's result is what it returned, not the Task.
  assert.deepEqual(r.watched('DescribeAsync').samples.map(x => x.returned), ['"2 x widget"', 'null'])

  assert.ok(r.doc.edges.some(e => e.from.name === 'Price' && e.to.name === 'Lookup' && e.calls === 2))
  assert.equal(r.doc.uncaught[0].what, 'ArgumentException: not enough widget')
  assert.match(r.doc.uncaught[0].stack.split('\n')[0], /at Reserve \(.*Stock\.cs:16:1\)/)
})

// Everything a source rewrite can trip on. The instrumented build must behave
// exactly like the ordinary one, under warnings-as-errors, and each kind of
// function must actually be recorded rather than quietly left out.
const TORTURE = `using System.Text.RegularExpressions;

namespace T;

public interface IShape { double Area(); string Label() => "shape:" + Area(); }
public readonly record struct Circle(double R) : IShape { public double Area() => Math.PI * R * R; }
public enum Level : byte { Low, High }
public struct Point
{
    public int X, Y;
    public Point(int x, int y) { X = x; Y = y; }
    public Point(int v) : this(v, v) { }
    public int Sum() => X + Y;
}
public ref struct Window
{
    private readonly Span<int> data;
    public Window(Span<int> d) { data = d; }
    public int First() => data[0];
    public Span<int> Slice(int n) { return data.Slice(n); }
}
public class Base { protected readonly string tag; public Base(string t) { tag = t; } public virtual string Tag => tag + "!"; }
public class Derived : Base
{
    private int hits;
    public Derived(int n) : base(n > 3 ? "big" : "small") { hits = n; }
    public override string Tag { get { hits++; return base.Tag + hits; } }
    public int Hits { get => hits; set => hits = value < 0 ? 0 : value; }
}
public static partial class Fns
{
    public static byte Small() { return 1; }
    public static Level Lvl() => 0;
    public static string? Nothing(bool b) { if (b) return null; return default; }
    public static List<int> Fresh() { return new(); }
    public static int[] Arr() => [1, 2, 3];
    public static (int a, string? b) Pair() { return (1, null); }
    public static Func<int, int> Adder(int k) { return x => { return x + k; }; }
    public static long Widen(int x) { return x; }
    public static object Boxed(int x) => x > 0 ? x : "neg";
    public static bool TryParse(string s, out int value, ref int count, in int scale) { count++; return int.TryParse(s, out value); }
    public static ref int Biggest(int[] xs) { return ref xs[0]; }
    public static unsafe int Deref(int* p) { return *p + 1; }
    public static unsafe int DerefFour() { int q = 4; return Deref(&q); }
    public static int SpanSum(ReadOnlySpan<int> xs) { int t = 0; foreach (var x in xs) t += x; return t; }
    public static IEnumerable<int> Count(int n) { for (int i = 0; i < n; i++) { if (i == 3) yield break; yield return i; } }
    public static async IAsyncEnumerable<int> Stream(int n) { for (int i = 0; i < n; i++) { await Task.Yield(); yield return i; } }
    public static async Task<int> SlowAsync(int x) { await Task.Delay(1); if (x < 0) throw new ArgumentException("neg"); return x * 2; }
    public static async Task Fire() { await Task.Yield(); }
    public static async ValueTask<string?> MaybeAsync(bool b) { await Task.Yield(); return b ? "y" : null; }
    public static T Max<T>(IEnumerable<T> xs) where T : IComparable<T> { T best = default!; bool any = false; foreach (var x in xs) { if (!any || x.CompareTo(best) > 0) { best = x; any = true; } } return best; }
    public static int Outer(int x)
    {
        int Inner(int y) => y * 2;
        static int Twice(int y) { return y + y; }
        return Inner(x) + Twice(x) + new[] { 1, 2 }.Select(v => v + x).Sum();
    }
    public static string Sw(object o) => o switch { int i when i > 5 => "big", int => "int", string s => s, _ => throw new InvalidOperationException("?") };
    public static string TryIt(int n)
    {
        try { if (n == 0) return "zero"; if (n < 0) throw new InvalidOperationException("neg"); return "ok"; }
        catch (InvalidOperationException) { return "caught"; }
        finally { Seen++; }
    }
    public static int Seen;
    public static void Void(List<int> xs) => xs.Add(1);
    public static dynamic Dyn(dynamic d) { return d + 1; }
    public static decimal Money() => 5;
    public static int? Maybe(bool b) => b ? 1 : null;
    [GeneratedRegex("a+")] private static partial Regex As();
    public static int CountAs(string s) { return As().Matches(s).Count; }
}
public static class Program
{
    public static async Task Main()
    {
        var o = new System.Text.StringBuilder();
        IShape c = new Circle(1);
        o.Append(c.Label().Length).Append(' ').Append(new Point(2).Sum()).Append(' ');
        int[] buf = [4, 5, 6];
        o.Append(First(buf)).Append(' ');
        var d = new Derived(5); o.Append(d.Tag).Append(d.Hits).Append(' '); d.Hits = -4; o.Append(d.Hits).Append(' ');
        o.Append(Fns.Small()).Append(Fns.Lvl()).Append(Fns.Nothing(true) ?? "n").Append(Fns.Nothing(false) ?? "d").Append(Fns.Fresh().Count).Append(Fns.Arr().Length).Append(Fns.Pair().a).Append(Fns.Adder(2)(3)).Append(Fns.Widen(9)).Append(Fns.Boxed(-1)).Append(' ');
        int count = 0; o.Append(Fns.TryParse("12", out var v, ref count, 3)).Append(v).Append(count).Append(' ');
        var xs = new[] { 3, 1 }; Fns.Biggest(xs) = 9; o.Append(xs[0]).Append(Fns.DerefFour()).Append(Fns.SpanSum(buf)).Append(' ').Append(string.Join("", Fns.Count(9))).Append(' ');
        await foreach (var i in Fns.Stream(2)) o.Append(i);
        o.Append(await Fns.SlowAsync(4)).Append(' ');
        try { await Fns.SlowAsync(-1); } catch (ArgumentException) { o.Append("threw "); }
        await Fns.Fire(); o.Append(await Fns.MaybeAsync(false) ?? "null").Append(' ');
        o.Append(Fns.Max(new[] { 3, 9, 4 })).Append(Fns.Outer(2)).Append(Fns.Sw(7)).Append(Fns.Sw("s")).Append(Fns.TryIt(0)).Append(Fns.TryIt(-1)).Append(Fns.TryIt(1)).Append(Fns.Seen).Append(' ');
        var list = new List<int>(); Fns.Void(list); o.Append(list.Count).Append((int)Fns.Dyn(1)).Append(Fns.Money()).Append(Fns.Maybe(false)?.ToString() ?? "-").Append(Fns.CountAs("aa b a"));
        Console.WriteLine(o);
    }

    static int First(int[] buf) { var w = new Window(buf); return w.First() + w.Slice(1)[0]; }
}
`

test('the instrumented build behaves like the ordinary one across the language', { skip: SDK < 8 && 'needs C# 12' }, () => {
  const ws = workspace({ 'Torture.cs': TORTURE })
  const plain = ws.run([], { record: false })
  assert.equal(plain.status, 0, plain.output)
  const r = ws.run([['Torture.cs', '*']])
  assert.equal(r.status, 0, r.output)
  assert.equal(r.stdout.trim().split('\n').pop(), plain.stdout.trim().split('\n').pop())
  assert.doesNotMatch(r.output, /warning/i)

  const names = new Set(r.doc.functions.map(f => f.name))
  for (const expected of ['Area', 'Label', 'Point', 'Sum', 'Window', 'First', 'Slice', 'Base', 'Derived', 'get_Tag', 'set_Hits', 'Small', 'Lvl',
    'Nothing', 'Fresh', 'Arr', 'Pair', 'Adder', 'Widen', 'Boxed', 'TryParse', 'Biggest', 'Deref', 'SpanSum', 'Count', 'Stream', 'SlowAsync',
    'Fire', 'MaybeAsync', 'Max', 'Outer', 'Inner', 'Twice', 'Sw', 'TryIt', 'Void', 'Dyn', 'Money', 'Maybe', 'CountAs', 'Main']) {
    assert.ok(names.has(expected), `${expected} was not recorded: ${[...names].join(' ')}`)
  }
  assert.ok(!names.has('get_Hits'), 'a getter that only reads a field is not a function worth recording')

  const first = name => r.doc.watched.find(w => w.symbol === name).samples[0]
  assert.deepEqual([first('SlowAsync').args, first('SlowAsync').returned], ['{"x": 4}', '8'])
  assert.equal(r.watched('SlowAsync').samples[1].threw, 'ArgumentException: neg')
  assert.equal(first('TryParse').args, '{"s": "12", "count": 0, "scale": 3}', 'an out parameter has no value on entry')
  assert.equal(first('Nothing').returned, 'null')
  assert.equal(first('Small').returned, '1')
  assert.equal(first('Count').returned, '(iterator)')
  assert.equal(first('Biggest').returned, '(not captured)', 'a ref return cannot be copied out')
  assert.equal(first('SpanSum').args, '{}', 'a span cannot be boxed')
  assert.equal(first('CountAs').returned, '2', 'source generators still run')

  // The first ordinary build after a run recompiles: nothing of the recorder stays in the output.
  const rebuilt = ws.run([], { record: false, args: ['build'] })
  assert.equal(rebuilt.status, 0, rebuilt.output)
  assert.ok(!readFileSync(join(ws.app, 'bin', 'Debug', `net${SDK}.0`, 'App.dll')).includes('__AxiomRec'))
})

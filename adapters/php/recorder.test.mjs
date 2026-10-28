import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'

const ADAPTER = dirname(fileURLToPath(import.meta.url))
const php = process.env.PHP_BINARY || 'php'
const probe = spawnSync(php, ['-r', 'echo PHP_VERSION_ID;'], { encoding: 'utf8', timeout: 30_000 })
const VERSION = probe.status === 0 ? Number(probe.stdout) : 0
const skip = VERSION < 70100 && 'no PHP 7.1+'

/** A workspace of `files`; `run` executes `script`, with or without the recorder. */
function workspace(files) {
  // native: on Windows it also expands 8.3 short names (RUNNER~1), as PHP does.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ambio-phprec-')))
  for (const [rel, code] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), code)
  }
  const ini = join(root, '.ini')
  mkdirSync(ini)
  writeFileSync(join(ini, 'ambio.ini'), `auto_prepend_file="${join(ADAPTER, 'ambio_recorder.php').replaceAll('\\', '/')}"\n`)
  const evidence = join(root, '.evidence')
  const run = (script, watches, { record = true } = {}) => {
    const env = { ...process.env }
    if (record) {
      Object.assign(env, {
        PHP_INI_SCAN_DIR: delimiter + ini,
        AMBIO_WORKSPACE_ROOT: root,
        AMBIO_EVIDENCE_DIR: evidence,
        AMBIO_WATCHES: JSON.stringify(watches.map(([file, symbol]) => ({ absPath: join(root, file), symbol }))),
      })
    }
    const result = spawnSync(php, [script], { cwd: root, encoding: 'utf8', timeout: 60_000, env })
    const docs = existsSync(evidence)
      ? readdirSync(evidence).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(evidence, f), 'utf8')))
      : []
    const doc = docs[0] ?? { functions: [], watched: [], edges: [], uncaught: [] }
    return {
      doc, docs, status: result.status, output: result.stdout + result.stderr,
      watched: symbol => doc.watched.find(w => w.symbol === symbol),
      fn: name => doc.functions.find(f => f.name === name),
    }
  }
  return { root, run }
}

const STOCK = `<?php
declare(strict_types=1);

namespace Shop;

final class Order
{
    public function __construct(public string $item, public int $qty) {}
}

final class Stock
{
    /** @var array<string,int> */
    public array $levels = ['widget' => 10];
    private int $reservations = 0;

    public function reserve(Stock $stock, string $item, int $qty): int
    {
        $have = $stock->levels[$item] ?? 0;
        if ($qty > $have) {
            throw new \\InvalidArgumentException("not enough $item");
        }
        $stock->levels[$item] = $have - $qty;
        $this->reservations++;
        return $have - $qty;
    }

    public static function price(Order $order): float
    {
        try {
            return self::lookup($order->item);
        } catch (\\RuntimeException $e) {
            return 0.5;
        }
    }

    private static function lookup(string $item): float
    {
        if ($item === 'gadget') {
            throw new \\RuntimeException("no price for $item");
        }
        return 2.5;
    }
}
`
const REPRO = `#!/usr/bin/env php
<?php
require __DIR__ . '/src/Stock.php';

use Shop\\{Order, Stock};

function describe(Order $o): ?string {
    if ($o->qty === 0) return null;
    return "{$o->qty} x {$o->item}";
}

$s = new Stock();
for ($i = 0; $i < 3; $i++) $s->reserve($s, 'widget', 3);
echo Stock::price(new Order('widget', 2)), ' ', Stock::price(new Order('gadget', 1)), "\\n";
echo describe(new Order('widget', 2)), '|', describe(new Order('widget', 0)) ?? 'none', "\\n";
$s->reserve($s, 'widget', 3);
`

test('a PHP run records arguments by name, object mutations and the crash, and prints what PHP would', { skip }, () => {
  const ws = workspace({ 'src/Stock.php': STOCK, 'repro.php': REPRO })
  const plain = ws.run('repro.php', [], { record: false })
  const r = ws.run('repro.php', [['src/Stock.php', 'reserve'], ['src/Stock.php', 'price'], ['repro.php', 'describe']])
  assert.equal(r.status, 255)
  // Byte for byte what PHP prints on its own: the fatal error, its trace, the shebang line not echoed.
  assert.equal(r.output, plain.output)
  assert.match(r.output, /Uncaught InvalidArgumentException: not enough widget in .*Stock\.php:21\nStack trace:\n#0 .*repro\.php\(16\): Shop\\Stock->reserve\(.*\)\n#1 \{main\}/)

  const reserve = r.watched('reserve')
  assert.equal(reserve.calls, 4)
  assert.equal(reserve.line, 17)
  assert.equal(reserve.samples[0].args, '{"stock": Stock(levels={"widget": 10}, reservations=0), "item": "widget", "qty": 3, "this": Stock(levels={"widget": 10}, reservations=0)}')
  assert.equal(reserve.samples[0].returned, '7')
  assert.equal(reserve.samples[3].threw, 'InvalidArgumentException: not enough widget')
  assert.deepEqual(reserve.mutations.find(m => m.path === 'stock.levels.widget').examples.slice(0, 2).map(e => `${e.before}>${e.after}`), ['10>7', '7>4'])
  assert.deepEqual(reserve.shared.find(s => s.param === 'stock'), { param: 'stock', calls: 3, firstCall: 1 })

  // An exception a function handles itself is not that function failing.
  assert.deepEqual(r.watched('price').samples.map(s => s.returned), ['2.5', '0.5'])
  assert.equal(r.fn('price').errors, 0)
  assert.equal(r.fn('lookup').errors, 1)
  // Functions in the script PHP was started with are recorded too.
  assert.deepEqual(r.watched('describe').samples.map(s => s.returned), ['"2 x widget"', 'null'])

  assert.ok(r.doc.edges.some(e => e.from.name === 'price' && e.to.name === 'lookup' && e.calls === 2))
  assert.equal(r.doc.uncaught.length, 1)
  assert.equal(r.doc.uncaught[0].what, 'InvalidArgumentException: not enough widget')
  assert.deepEqual(r.doc.uncaught[0].stack.split('\n').map(l => l.replace(ws.root, '').replaceAll('\\', '/')), ['    at reserve (/src/Stock.php:21:1)', '    at {main} (/repro.php:16:1)'])
})

// Everything a token-level rewrite can trip on, and every kind of file
// operation the stand-in stream wrapper has to pass through unchanged.
const SHAPES = `<?php
declare(strict_types=1);

namespace T;

interface Shape { public function area(): float; }

abstract class Base implements Shape
{
    protected static int $made = 0;
    public function __construct(protected readonly string $tag) { static::$made++; }
    abstract public function area(): float;
    public function label(): string { return "{$this->tag}:" . number_format($this->area(), 2); }
    public static function made(): int { return self::$made; }
}

trait Scales
{
    public function scaled(float $k): static { $c = clone $this; $c->k = ($c->k ?? 1.0) * $k; return $c; }
}

final class Circle extends Base
{
    use Scales;
    public float $k = 1.0;
    public function __construct(private float $r) { parent::__construct('circle'); }
    public function area(): float { return M_PI * ($this->r * $this->k) ** 2; }
}

enum Level: int
{
    case Low = 1;
    case High = 2;
    public function flip(): self { return $this === self::Low ? self::High : self::Low; }
    public static function parse(string $s): ?self { return self::tryFrom((int) $s); }
}

final class Temp
{
    public float $celsius = 0.0;
    public float $fahrenheit {
        get { return $this->celsius * 9 / 5 + 32; }
        set(float $v) { $this->celsius = ($v - 32) * 5 / 9; }
    }
}

final class Fns
{
    private static array $store = ['a' => 1];
    public static int $seen = 0;

    public static function &slot(string $k) { return self::$store[$k]; }
    public static function adder(int $k): \\Closure { return function (int $x) use ($k) { return $x + $k; }; }
    public static function arrow(int $k): \\Closure { return fn(int $x) => $x * $k; }
    public static function count(int $n): \\Generator { for ($i = 0; $i < $n; $i++) { if ($i === 3) { return 'stopped'; } yield $i; } return 'done'; }
    public static function sum(int ...$xs): int { return array_sum($xs); }
    public static function named(int $a, int $b = 2, int ...$rest): string { return "$a-$b-" . count($rest); }
    public static function bump(array &$xs, int $by = 1): void { foreach ($xs as &$x) { $x += $by; } }
    public static function tryIt(int $n): string
    {
        try {
            if ($n === 0) { return 'zero'; }
            if ($n < 0) { throw new \\DomainException('neg'); }
            return 'ok';
        } catch (\\DomainException $e) {
            return 'caught';
        } finally {
            self::$seen++;
        }
    }
    public static function sw(mixed $o): string
    {
        return match (true) {
            is_int($o) && $o > 5 => 'big',
            is_int($o) => 'int',
            is_string($o) => "s{$o}",
            default => throw new \\LogicException('?'),
        };
    }
    public static function heredoc(string $n): string
    {
        return <<<TXT
        {$n} said "function x() { return 1; }"
        TXT;
    }
    public static function anon(): object
    {
        return new class(fn() => 1) {
            public function __construct(public \\Closure $f) {}
            public function twice(int $x): int { return 2 * $x + ($this->f)(); }
        };
    }
    public static function nothing(): void { return; }
    public static function fact(int $n): int { return $n <= 1 ? 1 : $n * self::fact($n - 1); }
    public static function nested(int $x): int
    {
        if (!function_exists('T\\inner_helper')) {
            function inner_helper(int $y): int { return $y * 3; }
        }
        static $calls = 0;
        $calls++;
        return inner_helper($x) + $calls + array_sum(array_map(function ($v) use ($x) { return $v + $x; }, [1, 2]));
    }
    public static function nullsafe(?Circle $c): ?string { return $c?->label(); }
    public static function callable(): int { $f = strlen(...); $g = self::fact(...); return $f('abc') + $g(3); }
}
`
const VIEW = `<?php function render_row(array $row): string { ob_start(); ?>
<li><?= htmlspecialchars($row['name']) ?>: <?php if ($row['n'] > 1): ?>many<?php else: ?>one<?php endif ?></li>
<?php return trim(ob_get_clean()); } ?>
`
const DEP = `<?php
function dep_helper(int $x): int { return $x + 100; }
`
const MAIN = `<?php
declare(strict_types=1);

use T\\{Circle, Level, Temp, Fns, Base};

require __DIR__ . '/lib/Shapes.php';
require_once __DIR__ . '/vendor/dep/dep.php';
include __DIR__ . '/lib/view.phtml';

$o = [];
$c = new Circle(1.0);
$o[] = $c->label() . ' ' . $c->scaled(2.0)->label() . ' ' . Base::made();
$o[] = Level::Low->flip()->name . (Level::parse('2')?->name ?? '-') . (Level::parse('9')?->name ?? '-');
$t = new Temp(); $t->fahrenheit = 212.0; $o[] = $t->celsius . '/' . $t->fahrenheit;
$slot = &Fns::slot('a'); $slot = 7; $o[] = Fns::slot('a');
$o[] = Fns::adder(2)(3) . Fns::arrow(3)(4);
$g = Fns::count(9); $o[] = implode('', iterator_to_array($g)) . $g->getReturn();
$o[] = Fns::sum(1, 2, 3) . Fns::named(b: 5, a: 1) . Fns::named(1, 2, 3, 4);
$xs = [1, 2]; Fns::bump($xs, 10); $o[] = implode(',', $xs);
$o[] = Fns::tryIt(0) . Fns::tryIt(-1) . Fns::tryIt(1) . Fns::$seen;
$o[] = Fns::sw(7) . Fns::sw(1) . Fns::sw('x') . Fns::heredoc('bob');
$o[] = Fns::anon()->twice(4) . Fns::fact(5) . Fns::nested(2) . Fns::nested(2) . (Fns::nullsafe(null) ?? 'null') . Fns::callable();
Fns::nothing();
$o[] = dep_helper(1) . render_row(['name' => 'a<b', 'n' => 2]);
// The file wrapper stands in for PHP's own: ordinary file work must not notice.
$dir = __DIR__ . '/tmp/work'; @mkdir($dir, 0777, true);
file_put_contents("$dir/a.txt", "hello\\n"); file_put_contents("$dir/a.txt", "more\\n", FILE_APPEND | LOCK_EX);
$fh = fopen("$dir/a.txt", 'r+'); flock($fh, LOCK_SH); fseek($fh, 0, SEEK_END); $size = ftell($fh); rewind($fh); $first = fgets($fh); ftruncate($fh, 6); flock($fh, LOCK_UN); fclose($fh);
touch("$dir/b.txt", 1000000000); chmod("$dir/b.txt", 0600); rename("$dir/b.txt", "$dir/c.txt"); copy("$dir/a.txt", "$dir/d.php");
$listing = scandir($dir); $glob = array_map('basename', glob("$dir/*.txt"));
$o[] = $size . trim($first) . filesize("$dir/a.txt") . implode(',', $listing) . implode(',', $glob) . filemtime("$dir/c.txt") . substr(sprintf('%o', fileperms("$dir/c.txt")), -3)
    . (is_file("$dir/c.txt") ? 'F' : '-') . (is_dir($dir) ? 'D' : '-') . (file_exists("$dir/nope") ? 'E' : '-') . strlen(file_get_contents(__DIR__ . '/lib/Shapes.php') ?: '') . (realpath("$dir/../work") === $dir ? 'R' : '-');
$missing = @file_get_contents("$dir/nope"); $o[] = var_export($missing, true) . (@include "$dir/nope.php" ? 'I' : 'i');
foreach (new DirectoryIterator($dir) as $f) { if (!$f->isDot()) { unlink($f->getPathname()); } } rmdir($dir); $o[] = is_dir($dir) ? 'left' : 'gone';
$spl = new SplFileObject(__FILE__); $o[] = trim($spl->fgets()) === '<?php' ? 'spl' : 'nospl';
echo implode("\\n", $o), "\\n";
echo __LINE__, ' ', basename(__FILE__), ' ', count(get_included_files()), "\\n";
`

test('the recorded program behaves like the ordinary one across the language and the file system', { skip: VERSION < 80400 && 'needs PHP 8.4 syntax' }, () => {
  const ws = workspace({ 'lib/Shapes.php': SHAPES, 'lib/view.phtml': VIEW, 'vendor/dep/dep.php': DEP, 'main.php': MAIN })
  mkdirSync(join(ws.root, 'tmp'))
  const plain = ws.run('main.php', [], { record: false })
  assert.equal(plain.status, 0, plain.output)
  const r = ws.run('main.php', [['lib/Shapes.php', '*'], ['lib/view.phtml', '*']])
  assert.equal(r.status, 0, r.output)
  // One line differs by design: get_included_files() counts the recorder's three files.
  const lines = text => text.trimEnd().split('\n')
  assert.deepEqual(lines(r.output).slice(0, -1), lines(plain.output).slice(0, -1))
  assert.equal(lines(plain.output).pop(), '37 main.php 4')
  assert.equal(lines(r.output).pop(), '37 main.php 7')

  const names = new Set(r.doc.functions.map(f => f.name))
  for (const expected of ['__construct', 'area', 'label', 'made', 'scaled', 'flip', 'parse', 'slot', 'adder', 'arrow', 'count', 'sum', 'named', 'bump',
    'tryIt', 'sw', 'heredoc', 'anon', 'twice', 'nothing', 'fact', 'nested', 'inner_helper', 'nullsafe', 'callable', 'render_row']) {
    assert.ok(names.has(expected), `${expected} was not recorded: ${[...names].join(' ')}`)
  }
  assert.ok(!names.has('dep_helper'), 'a dependency under vendor/ is not the program\'s code')

  const first = name => r.doc.watched.find(w => w.symbol === name).samples[0]
  assert.equal(first('count').returned, '"stopped"', 'a generator is one call; its result is what it returned')
  assert.equal(first('slot').returned, '(not captured)', 'a reference cannot pass through the recorder')
  assert.equal(r.doc.watched.find(w => w.symbol === 'named').samples[1].args, '{"a": 1, "b": 2, "rest": [3, 4]}')
  assert.deepEqual(r.doc.watched.find(w => w.symbol === 'tryIt').samples.map(s => s.returned), ['"zero"', '"caught"', '"ok"'])
  assert.equal(first('flip').args, '{"this": Level::Low}')
  assert.equal(first('render_row').returned, '"<li>a&lt;b: many</li>"')
})

test('without AMBIO_EVIDENCE_DIR the recorder is inert', { skip }, () => {
  const ws = workspace({ 'a.php': '<?php function f() { return 1; } echo f(), count(get_included_files());' })
  const r = spawnSync(php, ['a.php'], { cwd: ws.root, encoding: 'utf8', env: { ...process.env, PHP_INI_SCAN_DIR: delimiter + join(ws.root, '.ini'), AMBIO_EVIDENCE_DIR: '' } })
  assert.equal(r.stdout, '12', 'the script and the prepended file; nothing rewritten')
})

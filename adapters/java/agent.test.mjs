import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const AGENT = join(dirname(fileURLToPath(import.meta.url)), 'axiom-agent.jar')
const exe = name => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', name) : name
const JDK = spawnSync(exe('javac'), ['-version'], { timeout: 30_000 }).status === 0
// Kotlin is optional: KOTLIN_HOME (a kotlinc distribution), or kotlinc on the PATH.
const kotlinc = process.env.KOTLIN_HOME ? join(process.env.KOTLIN_HOME, 'bin', 'kotlinc') : 'kotlinc'
const KOTLIN = JDK && spawnSync(kotlinc, ['-version'], { timeout: 120_000 }).status === 0

/** Compile `files` into a workspace and run `main` under the agent; return the evidence. */
function record(files, main, watches, { kotlin = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axiom-jvmrec-')))
  const paths = Object.entries(files).map(([rel, code]) => {
    const file = join(root, 'src', rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, code)
    return file
  })
  const classes = join(root, 'target', 'classes')
  const compiled = kotlin
    ? spawnSync(kotlinc, [...paths, '-include-runtime', '-d', classes + '.jar'], { encoding: 'utf8', timeout: 300_000 })
    : spawnSync(exe('javac'), ['-g', '-d', classes, ...paths], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  const evidence = join(root, '.evidence')
  const result = spawnSync(exe('java'), ['-cp', kotlin ? classes + '.jar' : classes, main], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      JAVA_TOOL_OPTIONS: `-javaagent:${AGENT}`,
      AXIOM_WORKSPACE_ROOT: root,
      AXIOM_EVIDENCE_DIR: evidence,
      AXIOM_WATCHES: JSON.stringify(watches.map(([rel, symbol]) => ({ absPath: join(root, 'src', rel), symbol }))),
    },
  })
  const docs = readdirSync(evidence).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(evidence, f), 'utf8')))
  assert.equal(docs.length, 1, `expected one evidence file; stderr:\n${result.stderr}`)
  const doc = docs[0]
  return {
    doc, root, status: result.status, stdout: result.stdout, stderr: result.stderr,
    watched: symbol => doc.watched.find(w => w.symbol === symbol),
    fn: name => doc.functions.find(f => f.name === name),
  }
}

const STOCK = `package shop;

import java.util.HashMap;
import java.util.Map;

public class Stock {
    private final Map<String, Integer> levels = new HashMap<>();

    public Stock() {
        levels.put("widget", 10);
    }

    public int reserve(Map<String, Integer> stock, String item, int qty) {
        int have = stock.getOrDefault(item, 0);
        if (qty > have) {
            throw new IllegalArgumentException("not enough " + item);
        }
        stock.put(item, have - qty);
        return have - qty;
    }

    static double price(Order order) {
        try {
            return lookup(order.item);
        } catch (IllegalStateException e) {
            return 0.0;
        }
    }

    static double lookup(String item) {
        if (item.equals("gadget")) {
            throw new IllegalStateException("no price for " + item);
        }
        return 2.5;
    }

    public static void main(String[] args) {
        Stock s = new Stock();
        for (int i = 0; i < 3; i++) {
            s.reserve(s.levels, "widget", 3);
        }
        System.out.println(price(new Order("widget", 2L)) + " " + price(new Order("gadget", 1L)));
        s.reserve(s.levels, "widget", 3);
    }
}

class Order {
    final String item;
    final long qty;

    Order(String item, long qty) {
        this.item = item;
        this.qty = qty;
    }
}
`

test('a Java run records arguments by name, mutations, shared state and the crash', { skip: !JDK && 'no JDK' }, () => {
  const r = record({ 'shop/Stock.java': STOCK }, 'shop.Stock', [['shop/Stock.java', 'reserve'], ['shop/Stock.java', 'price']])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /2\.5 0\.0/)
  assert.match(r.stderr, /Exception in thread "main" java\.lang\.IllegalArgumentException: not enough widget/, 'the JVM still reports the crash itself')

  const reserve = r.watched('reserve')
  assert.equal(reserve.calls, 4)
  assert.equal(reserve.errors, 1)
  assert.equal(reserve.line, 14)
  assert.equal(reserve.samples[0].args, '{"stock": {"widget": 10}, "item": "widget", "qty": 3, "this": Stock(levels={"widget": 10})}')
  assert.equal(reserve.samples[0].returned, '7')
  assert.equal(reserve.samples[3].threw, 'IllegalArgumentException: not enough widget')
  const m = reserve.mutations.find(x => x.path === 'stock.widget')
  assert.deepEqual(m.examples.slice(0, 2).map(e => `${e.before}>${e.after}`), ['10>7', '7>4'])
  assert.deepEqual(reserve.shared.find(s => s.param === 'stock'), { param: 'stock', calls: 3, firstCall: 1 })

  // An exception a method handles itself is not that method failing.
  assert.deepEqual(r.watched('price').samples.map(s => s.returned), ['2.5', '0.0'])
  assert.equal(r.fn('price').errors, 0)
  assert.equal(r.fn('lookup').errors, 1)
  assert.equal(r.fn('Order').calls, 2, 'a constructor goes by its class name')

  assert.ok(r.doc.edges.some(e => e.from.name === 'price' && e.to.name === 'lookup' && e.calls === 2))
  assert.equal(r.doc.uncaught[0].what, 'IllegalArgumentException: not enough widget')
  assert.match(r.doc.uncaught[0].stack.split('\n')[0], /at reserve \(.*Stock\.java:16:1\)/)
})

test('a cached object someone else changed shows up as drift in what the cache returns', { skip: !JDK && 'no JDK' }, () => {
  const r = record({
    'Ledger.java': `import java.util.HashMap;
import java.util.Map;

public class Ledger {
    static final Map<String, Customer> CACHE = new HashMap<>();

    static Customer customer(String id) {
        return CACHE.computeIfAbsent(id, k -> new Customer(k, 10));
    }

    static void applyReferral(String id) {
        customer(id).discount += 5;
    }

    public static void main(String[] args) {
        customer("a");
        applyReferral("a");
        customer("a");
    }
}

class Customer {
    final String id;
    int discount;

    Customer(String id, int discount) {
        this.id = id;
        this.discount = discount;
    }
}
`,
  }, 'Ledger', [['Ledger.java', 'customer']])
  assert.equal(r.status, 0, r.stderr)
  const drift = r.watched('customer').drift.find(d => d.path === 'return')
  assert.ok(drift, JSON.stringify(r.watched('customer').drift))
  assert.deepEqual(drift.examples[0].changes, [{ key: 'discount', before: '10', after: '15' }])
})

// Kotlin compiles to the same bytecode with its own conventions: top-level
// functions in a FileKt class, a source file in any folder, generated
// accessors, and suspend functions that run once per resumption.
test('a Kotlin run records top-level and suspend functions as the source reads', { skip: !KOTLIN && 'no Kotlin compiler' }, () => {
  const r = record({
    'anywhere/Pricing.kt': `package shop.pricing

import kotlin.coroutines.*

data class Cart(val items: MutableList<Int>, var coupon: String? = null)

val rates = mutableMapOf("base" to 10)
var waiting: Continuation<Int>? = null

fun applyPeak(table: MutableMap<String, Int>, bump: Int = 5): Int {
    table["base"] = (table["base"] ?: 0) + bump
    return table["base"]!!
}

suspend fun later(x: Int): Int {
    val y = suspendCoroutine<Int> { waiting = it }
    return x + y
}

fun main() {
    repeat(2) { applyPeak(rates) }
    var result = 0
    suspend { later(41) }.startCoroutine(Continuation(EmptyCoroutineContext) { result = it.getOrThrow() })
    waiting!!.resume(1)
    println(result + Cart(mutableListOf(1)).items.size)
}
`,
  }, 'shop.pricing.PricingKt', [['anywhere/Pricing.kt', 'applyPeak'], ['anywhere/Pricing.kt', 'later']], { kotlin: true })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), '43')

  const peak = r.watched('applyPeak')
  assert.deepEqual(peak.samples.map(s => `${s.args} -> ${s.returned}`), ['{"table": {"base": 10}, "bump": 5} -> 15', '{"table": {"base": 15}, "bump": 5} -> 20'])
  assert.equal(peak.mutations[0].path, 'table.base')

  // One call, though the JVM entered the function twice (start and resume).
  const later = r.watched('later')
  assert.equal(later.calls, 1)
  assert.deepEqual(later.samples.map(s => `${s.args} -> ${s.returned}`), ['{"x": 41} -> 42'])
  assert.equal(r.fn('later').calls, 1)

  const names = r.doc.functions.map(f => f.name)
  for (const generated of ['getItems', 'getCoupon', 'component1', 'copy', 'invokeSuspend', 'invoke']) {
    assert.ok(!names.includes(generated), `${generated} is compiler output, not a function in the source: ${names}`)
  }
})

test('without AXIOM_EVIDENCE_DIR the agent does nothing', { skip: !JDK && 'no JDK' }, () => {
  const result = spawnSync(exe('java'), ['-version'], { encoding: 'utf8', env: { ...process.env, JAVA_TOOL_OPTIONS: `-javaagent:${AGENT}`, AXIOM_EVIDENCE_DIR: '' } })
  assert.equal(result.status, 0, result.stderr)
})

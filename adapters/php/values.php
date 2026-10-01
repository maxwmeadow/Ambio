<?php
// Value flattening, previews and per-function statistics for the PHP run
// recorder, mirroring recorder.py. Nothing here runs the program's code: no
// __toString, __get or iterators. An object is read through an array cast,
// which exposes its properties without calling anything.

namespace AxiomRecorder;

final class Values
{
    const FLATTEN_DEPTH = 4;
    const FLATTEN_LEAVES = 160;
    const PREVIEW_MAX = 240;
    const MAX_NODES = 60;
    const NODE_DEPTH = 5;
    const NODE_FIELDS = 48;
    const JSON = 320; // JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE

    public static function clip($s, $max)
    {
        if (\function_exists('mb_strlen')) {
            return \mb_strlen($s, 'UTF-8') <= $max ? $s : \mb_substr($s, 0, $max - 1, 'UTF-8') . '…';
        }
        return \strlen($s) <= $max ? $s : \substr($s, 0, $max - 1) . '…';
    }

    public static function shortName($class)
    {
        $at = \strrpos($class, '\\');
        $short = $at === false ? $class : \substr($class, $at + 1);
        // class@anonymous followed by a NUL and the file it came from
        $nul = \strpos($short, "\0");
        return $nul === false ? $short : \substr($short, 0, $nul);
    }

    /** [kind, text] for a value with no parts worth walking, else null. */
    public static function leaf($v)
    {
        if ($v === null) {
            return array('null', 'null');
        }
        if (\is_bool($v)) {
            return array('boolean', $v ? 'true' : 'false');
        }
        if (\is_int($v)) {
            return array('number', (string) $v);
        }
        if (\is_float($v)) {
            return \is_finite($v) ? array('number', \var_export($v, true)) : array('special', \is_nan($v) ? 'NAN' : ($v > 0 ? 'INF' : '-INF'));
        }
        if (\is_string($v)) {
            return array('string', self::clip($v, 120));
        }
        if (\is_array($v)) {
            return null;
        }
        if (!\is_object($v)) {
            return array('value', '<resource>');
        }
        if ($v instanceof \Closure) {
            return array('function', '<function>');
        }
        if ($v instanceof \UnitEnum) {
            return array('enum', self::shortName(\get_class($v)) . '::' . $v->name);
        }
        if ($v instanceof \DateTimeInterface) {
            return array('value', $v->format('c'));
        }
        if ($v instanceof \Generator) {
            return array('value', '<Generator>');
        }
        return null;
    }

    public static function display($leaf)
    {
        if ($leaf === null) {
            return '(absent)';
        }
        return $leaf[0] === 'string' ? self::quote($leaf[1]) : $leaf[1];
    }

    public static function quote($s)
    {
        $json = \json_encode((string) $s, self::JSON | JSON_PARTIAL_OUTPUT_ON_ERROR);
        return $json === false || $json === 'null' ? '"<binary>"' : $json;
    }

    /** An object's properties, by the names the source gave them. */
    private static function properties($object)
    {
        $out = array();
        foreach ((array) $object as $key => $value) {
            $key = (string) $key;
            $nul = \strrpos($key, "\0"); // "\0Class\0name" (private), "\0*\0name" (protected)
            $out[$nul === false ? $key : \substr($key, $nul + 1)] = $value;
        }
        return $out;
    }

    private static function isList(array $a)
    {
        $i = 0;
        foreach ($a as $k => $unused) {
            if ($k !== $i++) {
                return false;
            }
        }
        return true;
    }

    private static function key($k)
    {
        $k = (string) $k;
        return \strlen($k) <= 40 ? $k : \substr($k, 0, 40);
    }

    /** path => leaf, depth and count bounded. */
    public static function flatten($root, $prefix)
    {
        $out = array();
        try {
            self::walk($root, $prefix, 0, $out, array());
        } catch (\Throwable $ignored) {
        }
        return $out;
    }

    private static function walk($v, $p, $depth, array &$out, array $seen)
    {
        if (\count($out) >= self::FLATTEN_LEAVES) {
            return;
        }
        $leaf = self::leaf($v);
        if ($leaf !== null) {
            $out[$p] = $leaf;
            return;
        }
        if (\is_object($v)) {
            $id = \spl_object_id($v);
            if (isset($seen[$id])) {
                $out[$p] = array('ref', '<circular>');
                return;
            }
            $seen[$id] = true;
        }
        if ($depth >= self::FLATTEN_DEPTH) {
            $out[$p] = array('object', \is_array($v) ? '<array>' : '<' . self::shortName(\get_class($v)) . '>');
            return;
        }
        if (\is_array($v) && self::isList($v)) {
            $out[$p . '.length'] = array('number', (string) \count($v));
            foreach (\array_slice($v, 0, 8) as $i => $item) {
                self::walk($item, $p . '[' . $i . ']', $depth + 1, $out, $seen);
            }
            return;
        }
        $items = \is_array($v) ? $v : self::properties($v);
        if (!$items) {
            $out[$p] = array('object', \is_array($v) ? '{}' : '<' . self::shortName(\get_class($v)) . '>');
            return;
        }
        $n = 0;
        foreach ($items as $k => $item) {
            if ($n++ >= 24) {
                break;
            }
            self::walk($item, $p === '' ? self::key($k) : $p . '.' . self::key($k), $depth + 1, $out, $seen);
        }
    }

    /** Bounded, side-effect-free rendering. */
    public static function preview($v, $depth = 0)
    {
        try {
            $s = self::render($v, $depth);
        } catch (\Throwable $e) {
            $s = '<?>';
        }
        return self::clip($s, self::PREVIEW_MAX);
    }

    private static function render($v, $depth)
    {
        $leaf = self::leaf($v);
        if ($leaf !== null) {
            return self::display($leaf);
        }
        if ($depth >= 3) {
            return \is_array($v) ? '<array>' : '<' . self::shortName(\get_class($v)) . '>';
        }
        $parts = array();
        if (\is_array($v)) {
            $list = self::isList($v);
            foreach (\array_slice($v, 0, 8, true) as $k => $item) {
                $parts[] = ($list ? '' : (\is_string($k) ? self::quote($k) : $k) . ': ') . self::render($item, $depth + 1);
            }
            $more = \count($v) > 8 ? ', …' : '';
            return $list ? '[' . \implode(', ', $parts) . $more . ']' : '{' . \implode(', ', $parts) . $more . '}';
        }
        foreach (\array_slice(self::properties($v), 0, 8, true) as $k => $item) {
            $parts[] = $k . '=' . self::render($item, $depth + 1);
        }
        $name = self::shortName(\get_class($v));
        return $parts ? $name . '(' . \implode(', ', $parts) . ')' : '<' . $name . '>';
    }

    public static function outcomeShape($returned)
    {
        if ($returned === null || $returned === 'null') {
            return 'none';
        }
        $c = \substr($returned, 0, 1);
        if ($c === '{') {
            return 'dict';
        }
        if ($c === '[') {
            return 'sequence';
        }
        if ($c === '"') {
            return 'string';
        }
        if ($returned === 'true' || $returned === 'false') {
            return 'bool:' . $returned;
        }
        if (\is_numeric($returned)) {
            return 'number';
        }
        $paren = \strpos($returned, '(');
        return 'object:' . \substr($paren === false ? $returned : \substr($returned, 0, $paren), 0, 40);
    }

    /**
     * Objects reachable from a value, each with its own leaf fields, as
     * [object, path, fields]. Only objects have identity in PHP; an array an
     * object holds is part of that object's state, so its scalars are fields
     * of the object and drift in them is the object's drift.
     */
    public static function collectNodes($root, $prefix, array &$nodes)
    {
        try {
            $seen = array();
            self::nodes($root, $prefix, 0, $nodes, $seen);
        } catch (\Throwable $ignored) {
        }
    }

    private static function nodes($v, $p, $depth, array &$nodes, array &$seen)
    {
        if (\count($nodes) >= self::MAX_NODES || $depth > self::NODE_DEPTH || self::leaf($v) !== null) {
            return;
        }
        if (\is_array($v)) {
            // No identity of its own: look inside for objects.
            $list = self::isList($v);
            foreach (\array_slice($v, 0, $list ? 8 : self::NODE_FIELDS, true) as $k => $item) {
                self::nodes($item, $list ? $p . '[' . $k . ']' : $p . '.' . self::key($k), $depth + 1, $nodes, $seen);
            }
            return;
        }
        $id = \spl_object_id($v);
        if (isset($seen[$id])) {
            return;
        }
        $seen[$id] = true;
        $fields = array();
        $children = array();
        self::fields(self::properties($v), '', $fields, $children, 0);
        if ($fields) {
            $nodes[] = array($v, $p, $fields);
        }
        foreach ($children as $path => $child) {
            self::nodes($child, $p . '.' . $path, $depth + 1, $nodes, $seen);
        }
    }

    private static function fields(array $items, $prefix, array &$fields, array &$children, $depth)
    {
        $list = $prefix !== '' && self::isList($items);
        if ($list) {
            $fields[$prefix . '.len'] = (string) \count($items);
        }
        foreach (\array_slice($items, 0, $list ? 8 : self::NODE_FIELDS, true) as $k => $item) {
            if (\count($fields) >= self::NODE_FIELDS) {
                return;
            }
            $path = $prefix === '' ? self::key($k) : ($list ? $prefix . '[' . $k . ']' : $prefix . '.' . self::key($k));
            $leaf = self::leaf($item);
            if ($leaf !== null) {
                $fields[$path] = self::display($leaf);
            } elseif (\is_array($item) && $depth < 2) {
                self::fields($item, $path, $fields, $children, $depth + 1);
            } elseif (\is_object($item)) {
                $children[$path] = $item;
            }
        }
    }
}

/** How one value path behaved across calls. */
final class PathStats
{
    const SERIES_KEEP = 12;
    const DISTINCT_KEEP = 24;

    private $count = 0;
    private $kind;
    private $first;
    private $last;
    private $min;
    private $max;
    private $nonDec = true;
    private $nonInc = true;
    private $changes = 0;
    private $series = array();
    private $tail = array();
    private $distinct = array();
    private $overflow = false;
    private $lastNum;

    public function add($leaf)
    {
        $numeric = $leaf !== null && $leaf[0] === 'number' && \is_numeric($leaf[1]);
        $this->put(Values::display($leaf), $leaf === null ? 'absent' : $leaf[0], $numeric ? $leaf[1] + 0 : null);
    }

    public function addText($text)
    {
        $this->put($text, 'text', null);
    }

    private function put($d, $kind, $n)
    {
        $this->count++;
        if ($this->kind === null) {
            $this->kind = $kind;
        } elseif ($this->kind !== $kind && $this->kind !== 'mixed') {
            $this->kind = 'mixed';
        }
        if ($this->count > 1 && $d !== $this->last) {
            $this->changes++;
        }
        if ($n !== null) {
            if ($this->lastNum !== null) {
                if ($n < $this->lastNum) {
                    $this->nonDec = false;
                }
                if ($n > $this->lastNum) {
                    $this->nonInc = false;
                }
            }
            $this->lastNum = $n;
            $this->min = $this->min === null ? $n : \min($this->min, $n);
            $this->max = $this->max === null ? $n : \max($this->max, $n);
        }
        if ($this->first === null) {
            $this->first = $d;
        }
        $this->last = $d;
        if (\count($this->series) < self::SERIES_KEEP) {
            $this->series[] = $d;
        }
        $this->tail[] = $d;
        if (\count($this->tail) > 3) {
            \array_shift($this->tail);
        }
        $key = 'v' . $d; // a numeric string must stay a string key
        if (isset($this->distinct[$key])) {
            $this->distinct[$key][1]++;
        } elseif (\count($this->distinct) < self::DISTINCT_KEEP) {
            $this->distinct[$key] = array($d, 1);
        } else {
            $this->overflow = true;
        }
    }

    public function toJson()
    {
        $numeric = $this->kind === 'number';
        if ($numeric && $this->changes > 0) {
            $trend = $this->nonDec ? 'increasing' : ($this->nonInc ? 'decreasing' : 'varying');
        } else {
            $trend = $this->changes > 0 ? 'varying' : 'constant';
        }
        $doc = array(
            'kind' => $this->kind,
            'count' => $this->count,
            'changes' => $this->changes,
            'distinct' => $this->overflow ? self::DISTINCT_KEEP . '+' : \count($this->distinct),
            'first' => $this->first,
            'last' => $this->last,
            'trend' => $trend,
            'series' => $this->series,
        );
        if ($numeric && $this->min !== null) {
            $doc['min'] = $this->min;
            $doc['max'] = $this->max;
        }
        if ($this->count > self::SERIES_KEEP) {
            $doc['tail'] = $this->tail;
        }
        if (\count($this->distinct) <= 8 && !$this->overflow) {
            $top = \array_values($this->distinct);
            \usort($top, function ($x, $y) {
                return $y[1] - $x[1];
            });
            $doc['top'] = \array_map(function ($entry) {
                return array('value' => $entry[0], 'n' => $entry[1]);
            }, $top);
        }
        return $doc;
    }
}

/** Everything recorded about one watched function. */
final class Watch
{
    const SAMPLE_HEAD = 6;
    const SAMPLE_TAIL = 4;
    const MUTATION_EXAMPLES = 6;
    const MAX_EXCEPTIONS = 20;

    public $calls = 0;
    public $totalMs = 0.0;
    public $returns;
    private $file;
    private $symbol;
    private $line;
    private $errors = 0;
    private $head = array();
    private $tail = array();
    private $novel = array();
    private $shapes = array();
    private $paths = array();
    private $mutations = array();
    private $exceptions = array();
    // Objects passed before, kept for the run so an object id always means the same object.
    private $seenObjects = array();
    private $shared = array();
    private $lastArgs;
    private $repeats = 0;
    private $repeatExample;
    private $objects = array();
    private $drift = array();

    public function __construct($file, $symbol, $line)
    {
        $this->file = $file;
        $this->symbol = $symbol;
        $this->line = $line;
        $this->returns = new PathStats();
    }

    public function observe($path, $leaf)
    {
        if (!isset($this->paths[$path])) {
            if (\count($this->paths) >= 400) {
                return;
            }
            $this->paths[$path] = new PathStats();
        }
        $this->paths[$path]->add($leaf);
    }

    public function observeArgs($call, array $names, array $values, $fingerprint, $argsPreview)
    {
        foreach ($names as $i => $name) {
            $v = $values[$i];
            if (!\is_object($v) || Values::leaf($v) !== null) {
                continue;
            }
            $id = \spl_object_id($v);
            if (!isset($this->seenObjects[$id])) {
                $this->seenObjects[$id] = array($v, $call);
                continue;
            }
            if (!isset($this->shared[$name])) {
                $this->shared[$name] = array('param' => $name, 'calls' => 0, 'firstCall' => $this->seenObjects[$id][1]);
            }
            $this->shared[$name]['calls']++;
        }
        if ($this->lastArgs !== null && $fingerprint === $this->lastArgs && $names) {
            $this->repeats++;
            if ($this->repeatExample === null) {
                $this->repeatExample = array('call' => $call, 'args' => $argsPreview);
            }
        }
        $this->lastArgs = $fingerprint;
    }

    /** The same object, seen on an earlier call with different contents. */
    public function checkDrift(array $nodes, $call)
    {
        foreach ($nodes as $node) {
            list($object, $path, $fields) = $node;
            $parts = \explode('.', \str_replace('[', '.[', $path));
            if ($parts[0] === 'this' && \count($parts) <= 2) {
                continue; // the receiver's own state is expected to change
            }
            $id = \spl_object_id($object);
            if (isset($this->objects[$id]) && $this->objects[$id][1] !== $call) {
                $prev = $this->objects[$id];
                $changes = array();
                foreach (\array_keys($prev[2] + $fields) as $k) {
                    $a = \array_key_exists($k, $prev[2]) ? $prev[2][$k] : '(absent)';
                    $b = \array_key_exists($k, $fields) ? $fields[$k] : '(absent)';
                    if ($a !== $b && \count($changes) < 4) {
                        $changes[] = array('key' => (string) $k, 'before' => $a, 'after' => $b);
                    }
                }
                if ($changes) {
                    if (!isset($this->drift[$path]) && \count($this->drift) < 20) {
                        $this->drift[$path] = array('calls' => 0, 'examples' => array());
                    }
                    if (isset($this->drift[$path])) {
                        $this->drift[$path]['calls']++;
                        if (\count($this->drift[$path]['examples']) < 4) {
                            $this->drift[$path]['examples'][] = array('fromCall' => $prev[1], 'toCall' => $call, 'changes' => $changes);
                        }
                    }
                }
            }
            $this->objects[$id] = array($object, $call, $fields);
        }
    }

    public function mutation($path, $before, $after, $call)
    {
        if (!isset($this->mutations[$path])) {
            if (\count($this->mutations) >= 40) {
                return;
            }
            $this->mutations[$path] = array('calls' => 0, 'examples' => array());
        }
        $this->mutations[$path]['calls']++;
        if (\count($this->mutations[$path]['examples']) < self::MUTATION_EXAMPLES) {
            $this->mutations[$path]['examples'][] = array('call' => $call, 'before' => $before, 'after' => $after);
        }
    }

    public function exception($what)
    {
        $this->errors++;
        if (isset($this->exceptions[$what])) {
            $this->exceptions[$what]++;
        } elseif (\count($this->exceptions) < self::MAX_EXCEPTIONS) {
            $this->exceptions[$what] = 1;
        }
    }

    /** Keeps the first calls, the last calls, and the first of each kind of outcome. */
    public function sample(array $s)
    {
        $shape = isset($s['threw']) ? 'threw:' . \explode(':', $s['threw'])[0] : Values::outcomeShape($s['returned']);
        $known = isset($this->shapes[$shape]);
        if (!$known && \count($this->shapes) < 8) {
            $this->shapes[$shape] = true;
        }
        if (\count($this->head) < self::SAMPLE_HEAD) {
            $this->head[] = $s;
            return;
        }
        if (!$known && \count($this->novel) < 6) {
            $this->novel[] = $s;
            return;
        }
        $this->tail[] = $s;
        if (\count($this->tail) > self::SAMPLE_TAIL) {
            \array_shift($this->tail);
        }
    }

    public function toJson()
    {
        $samples = \array_merge($this->head, $this->novel, $this->tail);
        \usort($samples, function ($x, $y) {
            return $x['call'] - $y['call'];
        });
        $values = array();
        foreach ($this->paths as $path => $stats) {
            $values[$path] = $stats->toJson();
        }
        $mutations = array();
        foreach ($this->mutations as $path => $m) {
            $mutations[] = array('path' => (string) $path, 'calls' => $m['calls'], 'examples' => $m['examples']);
        }
        $exceptions = array();
        foreach ($this->exceptions as $what => $n) {
            $exceptions[] = array('what' => (string) $what, 'n' => $n);
        }
        $drift = array();
        foreach ($this->drift as $path => $d) {
            $drift[] = array('path' => (string) $path, 'calls' => $d['calls'], 'examples' => $d['examples']);
        }
        return array(
            'file' => $this->file,
            'symbol' => $this->symbol,
            'line' => $this->line,
            'calls' => $this->calls,
            'errors' => $this->errors,
            'avgMs' => $this->calls ? \round($this->totalMs / $this->calls, 3) : 0,
            'samples' => $samples,
            'values' => (object) $values,
            'mutations' => $mutations,
            'exceptions' => $exceptions,
            'returns' => $this->returns->toJson(),
            'shared' => \array_values($this->shared),
            'repeats' => $this->repeats,
            'repeatExample' => $this->repeatExample,
            'drift' => $drift,
        );
    }
}

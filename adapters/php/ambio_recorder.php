<?php
// Run recorder for `investigation run` - the PHP twin of recorder.cjs,
// recorder.py and ambio_recorder.rb.
//
// archd launches the command with PHP_INI_SCAN_DIR pointing at an ini file
// whose auto_prepend_file is this script, so every PHP the command starts
// (php script.php, vendor/bin/phpunit, php -S) loads it before any user code.
// Without AMBIO_EVIDENCE_DIR it does nothing.
//
// PHP has no tracing hook a script can use, so the recorder rewrites the
// program's own files as they are included: it takes over the file:// stream
// wrapper, and when PHP opens a workspace .php file to include it, serves an
// instrumented copy from memory (instrument.php). Nothing on disk changes, the
// path PHP sees is the real one, and code is added only on existing lines, so
// __FILE__, __LINE__ and every stack trace are the user's own.
//
// At exit it writes one JSON document per process (per request under a
// server), in the shape the other recorders write.

namespace AmbioRecorder;

// (A constant, not class_exists: this file's classes exist as soon as it compiles.)
if (\getenv('AMBIO_EVIDENCE_DIR') === false || \getenv('AMBIO_EVIDENCE_DIR') === '' || \defined('AMBIO_RECORDER_LOADED')) {
    return;
}
\define('AMBIO_RECORDER_LOADED', true);

/** A call in progress. */
final class Frame
{
    public $fn;
    public $started;
    public $watch;
    public $values;
    public $names;
    public $before;
    public $call;
    public $args;
    public $result;
    public $returned = false;
    public $threw;
    public $done = false;
    public $byRef = false;
}

/** What instrumented functions call. Never throws into the program. */
final class R
{
    const MAX_EDGES = 5000;
    const FLUSH_SECONDS = 1.0;

    public static $root = '';
    private static $dir = '';
    private static $fns = array();      // "file|name|line" => [file, name, line, calls, errors, seconds, Watch|null]
    private static $edges = array();
    private static $edgesDropped = 0;
    private static $stack = array();
    private static $uncaught = array();
    private static $watches = array();  // real path => list of [symbol, lineStart, lineEnd]
    private static $busy = false;
    private static $startedAt = 0;
    private static $lastWritten = -1;
    private static $lastFlush = 0.0;
    private static $file = '';

    public static function start()
    {
        self::$dir = \getenv('AMBIO_EVIDENCE_DIR');
        $root = \getenv('AMBIO_WORKSPACE_ROOT');
        $root = \realpath($root === false || $root === '' ? \getcwd() : $root);
        self::$root = \rtrim($root === false ? \getcwd() : $root, '/\\');
        self::$startedAt = (int) \round(\microtime(true) * 1000);
        self::$lastFlush = \microtime(true);
        // A server handles many requests in one process: one document each.
        self::$file = \getmypid() . (PHP_SAPI === 'cli' ? '' : '-' . \bin2hex(\random_bytes(4)));
        $watches = \json_decode((string) \getenv('AMBIO_WATCHES'), true);
        foreach (\is_array($watches) ? $watches : array() as $w) {
            $path = isset($w['absPath']) && $w['absPath'] !== '' ? $w['absPath'] : (isset($w['file']) ? $w['file'] : '');
            if (!\is_string($path) || $path === '') {
                continue;
            }
            $real = \realpath($path);
            self::$watches[$real === false ? $path : $real][] = array(
                isset($w['symbol']) && $w['symbol'] !== '' ? (string) $w['symbol'] : '*',
                isset($w['lineStart']) ? (int) $w['lineStart'] : 0,
                isset($w['lineEnd']) ? (int) $w['lineEnd'] : 0,
            );
        }
        \register_shutdown_function(array(__CLASS__, 'shutdown'));
        // A handler the program installs later replaces this one, and then
        // the exception is the program's to report.
        \set_exception_handler(function ($error) {
            R::uncaught($error);
            R::write();
            // PHP reports the exception itself, exactly as it would have:
            // with no handler set, rethrowing it is an ordinary uncaught exception.
            R::hideOwnFrames($error);
            \set_exception_handler(null);
            throw $error;
        });
    }

    private static function watched($file, $name, $line)
    {
        if (!isset(self::$watches[$file])) {
            return false;
        }
        $named = 0;
        foreach (self::$watches[$file] as $spec) {
            if ($spec[0] === '*') {
                return true;
            }
            $symbol = $spec[0];
            $tail = \strrpos($symbol, '.') === false ? $symbol : \substr($symbol, \strrpos($symbol, '.') + 1);
            $tail = \strrpos($tail, '::') === false ? $tail : \substr($tail, \strrpos($tail, '::') + 2);
            if (\strcasecmp($tail, $name) !== 0) {
                continue;
            }
            $named++;
            // The index's range starts at the declaration, attributes included.
            if ($spec[1] === 0 || ($spec[1] - 3 <= $line && $line <= \max($spec[2], $spec[1]))) {
                return true;
            }
        }
        return $named === 1;
    }

    /** Called on entry to every instrumented function. */
    public static function enter($file, $name, $line, $params, $byRef = false)
    {
        if (self::$busy) {
            return null;
        }
        try {
            $key = $file . '|' . $name . '|' . $line;
            if (!isset(self::$fns[$key])) {
                $watch = self::watched($file, $name, $line) ? new Watch($file, $name, $line) : null;
                self::$fns[$key] = array($file, $name, $line, 0, 0, 0.0, $watch, $params === '' ? array() : \explode(',', $params));
            }
            self::$fns[$key][3]++;
            $top = \end(self::$stack);
            if ($top !== false && $top->fn !== $key) {
                $edge = $top->fn . "\n" . $key;
                if (isset(self::$edges[$edge])) {
                    self::$edges[$edge]++;
                } elseif (\count(self::$edges) < self::MAX_EDGES) {
                    self::$edges[$edge] = 1;
                } else {
                    self::$edgesDropped++;
                }
            }
            $frame = new Frame();
            $frame->fn = $key;
            $frame->watch = self::$fns[$key][6];
            $frame->byRef = $byRef;
            $frame->started = \microtime(true);
            self::$stack[] = $frame;
            return $frame;
        } catch (\Throwable $ignored) {
            return null;
        }
    }

    /** Arguments and receiver of a watched call. */
    public static function args($frame, array $args, $self)
    {
        if ($frame === null || self::$busy) {
            return;
        }
        self::$busy = true;
        try {
            $w = $frame->watch;
            $names = self::$fns[$frame->fn][7];
            $values = array();
            foreach ($names as $i => $n) {
                if (\strncmp($n, '...', 3) === 0) {
                    // A variadic parameter is the array of everything from here on.
                    $names[$i] = \substr($n, 3);
                    $values[] = \array_slice($args, $i);
                    $args = \array_slice($args, 0, $i);
                    break;
                }
                $values[] = \array_key_exists($i, $args) ? $args[$i] : null;
            }
            // Arguments beyond the declared ones (read with func_get_args) keep their position.
            for ($i = \count($names); $i < \count($args); $i++) {
                $names[] = 'arg' . $i;
                $values[] = $args[$i];
            }
            if ($self !== null) {
                $names[] = 'this';
                $values[] = $self;
            }
            $frame->names = $names;
            $frame->values = $values;
            $frame->before = array();
            $w->calls++;
            $frame->call = $w->calls;
            $nodes = array();
            $shown = array();
            $fingerprint = '';
            foreach ($names as $i => $n) {
                foreach (Values::flatten($values[$i], $n) as $path => $leaf) {
                    $frame->before[$path] = $leaf;
                    $w->observe('arg.' . $path, $leaf);
                    $fingerprint .= $path . '=' . Values::display($leaf) . '|';
                }
                Values::collectNodes($values[$i], $n, $nodes);
                $shown[] = \json_encode($n) . ': ' . Values::preview($values[$i], 1);
            }
            $w->checkDrift($nodes, $frame->call);
            $frame->args = Values::clip('{' . \implode(', ', $shown) . '}', Values::PREVIEW_MAX);
            $w->observeArgs($frame->call, $names, $values, $fingerprint, $frame->args);
        } catch (\Throwable $ignored) {
            $frame->values = null;
        } finally {
            self::$busy = false;
        }
    }

    /** Wraps a returned value: records it for a watched call and hands it back. */
    public static function ret($frame, $value)
    {
        if ($frame !== null && $frame->watch !== null) {
            $frame->result = $value;
            $frame->returned = true;
        }
        return $value;
    }

    public static function thrown($frame, $error)
    {
        if ($frame === null || self::$busy) {
            return;
        }
        self::$busy = true;
        try {
            $frame->threw = self::describe($error);
        } catch (\Throwable $ignored) {
        } finally {
            self::$busy = false;
        }
    }

    public static function leave($frame)
    {
        if ($frame === null || $frame->done || self::$busy) {
            return;
        }
        $frame->done = true;
        self::$busy = true;
        try {
            $now = \microtime(true);
            // Usually the top; a suspended generator can leave frames above it.
            for ($i = \count(self::$stack) - 1; $i >= 0; $i--) {
                if (self::$stack[$i] === $frame) {
                    \array_splice(self::$stack, $i, 1);
                    break;
                }
            }
            self::$fns[$frame->fn][5] += $now - $frame->started;
            if ($frame->threw !== null) {
                self::$fns[$frame->fn][4]++;
            }
            if ($frame->watch !== null && $frame->values !== null) {
                self::watchedExit($frame, ($now - $frame->started) * 1000.0);
            }
            if ($now - self::$lastFlush >= self::FLUSH_SECONDS) {
                self::$busy = false;
                self::write();
            }
        } catch (\Throwable $ignored) {
        } finally {
            self::$busy = false;
        }
    }

    private static function describe($error)
    {
        $class = \get_class($error);
        $short = \strrpos($class, '\\') === false ? $class : \substr($class, \strrpos($class, '\\') + 1);
        $message = (string) $error->getMessage();
        return $message === '' ? $short : $short . ': ' . Values::clip($message, 200);
    }

    private static function watchedExit(Frame $frame, $ms)
    {
        $w = $frame->watch;
        $w->totalMs += $ms;
        $shownReturn = null;
        if ($frame->threw !== null) {
            $w->exception($frame->threw);
        } elseif (!$frame->returned) {
            // A reference cannot be passed through the recorder and stay one.
            $shownReturn = $frame->byRef ? '(not captured)' : 'null';
            $w->returns->addText($shownReturn);
        } else {
            $returned = $frame->result;
            $shownReturn = Values::preview($returned, 0);
            $leaf = Values::leaf($returned);
            if ($leaf !== null && $leaf[0] === 'number') {
                $w->returns->add($leaf);
            } else {
                $w->returns->addText(Values::clip($shownReturn, 80));
            }
            foreach (Values::flatten($returned, 'return') as $path => $l) {
                $w->observe($path, $l);
            }
            if ($leaf === null) {
                $nodes = array();
                Values::collectNodes($returned, 'return', $nodes);
                $w->checkDrift($nodes, $frame->call);
            }
        }
        // What the call changed in the objects it was given. Arrays are
        // values in PHP: a callee's change to one is its own copy's.
        $changed = array();
        $nodes = array();
        foreach ($frame->names as $i => $n) {
            $after = Values::flatten($frame->values[$i], $n);
            Values::collectNodes($frame->values[$i], $n, $nodes);
            $keys = array();
            foreach ($frame->before as $k => $unused) {
                if ($k === $n || \strpos($k, $n . '.') === 0 || \strpos($k, $n . '[') === 0) {
                    $keys[] = $k;
                }
            }
            foreach ($after as $k => $unused) {
                if (!\array_key_exists($k, $frame->before)) {
                    $keys[] = $k;
                }
            }
            foreach ($keys as $k) {
                $b = Values::display(isset($frame->before[$k]) ? $frame->before[$k] : null);
                $a = Values::display(isset($after[$k]) ? $after[$k] : null);
                if ($a !== $b) {
                    $changed[] = array($k, $b, $a);
                }
            }
        }
        $w->checkDrift($nodes, $frame->call);
        // An empty container gaining its first entry is one change, not two.
        $real = array();
        foreach ($changed as $c) {
            $placeholder = $c[1] === '{}' || $c[1] === '(absent)' || $c[2] === '{}' || $c[2] === '(absent)';
            $hasChild = false;
            foreach ($changed as $o) {
                if ($o !== $c && (\strpos($o[0], $c[0] . '.') === 0 || \strpos($o[0], $c[0] . '[') === 0)) {
                    $hasChild = true;
                    break;
                }
            }
            if (!$placeholder || !$hasChild) {
                $real[] = $c;
            }
        }
        foreach (\array_slice($real, 0, 20) as $c) {
            $w->mutation($c[0], $c[1], $c[2], $frame->call);
        }
        $sample = array('call' => $frame->call, 'args' => $frame->args, 'ms' => \round($ms, 3));
        if ($frame->threw !== null) {
            $sample['threw'] = $frame->threw;
        } else {
            $sample['returned'] = $shownReturn;
        }
        if ($real) {
            $sample['mutated'] = array();
            foreach (\array_slice($real, 0, 4) as $c) {
                $sample['mutated'][] = $c[0] . ': ' . $c[1] . ' → ' . $c[2];
            }
        }
        $w->sample($sample);
    }

    public static function uncaught($error)
    {
        if (!($error instanceof \Throwable) || \count(self::$uncaught) >= 5) {
            return;
        }
        self::$busy = true;
        try {
            // Node-style frames so archd's stack parser can place the crash.
            $frames = array('    at ' . self::frameName($error->getTrace(), 0) . ' (' . $error->getFile() . ':' . $error->getLine() . ':1)');
            foreach ($error->getTrace() as $i => $frame) {
                if (\count($frames) >= 12 || !isset($frame['file'], $frame['line'])) {
                    continue;
                }
                $frames[] = '    at ' . self::frameName($error->getTrace(), $i + 1) . ' (' . $frame['file'] . ':' . $frame['line'] . ':1)';
            }
            $inside = array();
            foreach ($frames as $line) {
                if (\strpos($line, '(' . self::$root . DIRECTORY_SEPARATOR) !== false) {
                    $inside[] = $line;
                }
            }
            self::$uncaught[] = array('what' => Values::clip(self::describe($error), 300), 'stack' => \implode("\n", $inside));
        } catch (\Throwable $ignored) {
        } finally {
            self::$busy = false;
        }
    }

    /** The function a trace position is in: the one the next frame out called. */
    private static function frameName(array $trace, $i)
    {
        $name = isset($trace[$i]['function']) ? $trace[$i]['function'] : '{main}';
        return \in_array($name, array('require', 'require_once', 'include', 'include_once'), true) ? '{main}' : $name;
    }

    /**
     * The main script runs through a `require` in this file (see the end of
     * it). That frame is the recorder's, not the program's: take it out of
     * the trace PHP is about to print.
     */
    public static function hideOwnFrames($error)
    {
        try {
            $property = new \ReflectionProperty($error instanceof \Error ? 'Error' : 'Exception', 'trace');
            if (PHP_VERSION_ID < 80100) {
                $property->setAccessible(true); // needed before 8.1, deprecated from 8.5
            }
            $kept = array();
            foreach ($property->getValue($error) as $frame) {
                if (!isset($frame['file']) || $frame['file'] !== __FILE__) {
                    $kept[] = $frame;
                }
            }
            $property->setValue($error, $kept);
        } catch (\Throwable $ignored) {
        }
    }

    public static function shutdown()
    {
        // A fatal error that is not an exception (out of memory, a parse error in an included file).
        $last = \error_get_last();
        if ($last !== null && \in_array($last['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)
            && !self::$uncaught && \strpos($last['message'], 'Uncaught') !== 0) {
            self::$uncaught[] = array(
                'what' => Values::clip(\strtok($last['message'], "\n"), 300),
                'stack' => '    at {main} (' . $last['file'] . ':' . $last['line'] . ':1)',
            );
        }
        self::write();
    }

    public static function write()
    {
        if (self::$busy || self::$dir === '') {
            return;
        }
        self::$busy = true;
        try {
            self::$lastFlush = \microtime(true);
            $total = \count(self::$uncaught);
            foreach (self::$fns as $f) {
                $total += $f[3];
            }
            if ($total === self::$lastWritten || $total === 0) {
                return;
            }
            self::$lastWritten = $total;
            $functions = array();
            $watched = array();
            foreach (self::$fns as $f) {
                $functions[] = array('file' => $f[0], 'name' => $f[1], 'line' => $f[2], 'calls' => $f[3], 'errors' => $f[4], 'ms' => \round($f[5] * 1000.0, 3));
                if ($f[6] !== null && $f[6]->calls > 0) {
                    $watched[] = $f[6]->toJson();
                }
            }
            $edges = array();
            foreach (self::$edges as $pair => $n) {
                list($from, $to) = \explode("\n", $pair);
                $a = self::$fns[$from];
                $b = self::$fns[$to];
                $edges[] = array(
                    'from' => array('file' => $a[0], 'name' => $a[1], 'line' => $a[2]),
                    'to' => array('file' => $b[0], 'name' => $b[1], 'line' => $b[2]),
                    'calls' => $n,
                );
            }
            $doc = array(
                'version' => 1,
                'runId' => (string) \getenv('AMBIO_RUN_ID'),
                'pid' => \getmypid(),
                'argv' => array('php'),
                'startedAt' => self::$startedAt,
                'endedAt' => (int) \round(\microtime(true) * 1000),
                'functions' => $functions,
                'edges' => $edges,
                'edgesDropped' => self::$edgesDropped,
                'watched' => $watched,
                'uncaught' => self::$uncaught,
            );
            $json = \json_encode($doc, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
            if ($json === false) {
                return;
            }
            Stream::native(function () use ($json) {
                if (!\is_dir(R::dir())) {
                    @\mkdir(R::dir(), 0777, true);
                }
                $tmp = R::dir() . DIRECTORY_SEPARATOR . R::fileName() . '.json.tmp';
                if (@\file_put_contents($tmp, $json) !== false) {
                    @\rename($tmp, R::dir() . DIRECTORY_SEPARATOR . R::fileName() . '.json');
                }
            });
        } catch (\Throwable $ignored) {
        } finally {
            self::$busy = false;
        }
    }

    public static function dir()
    {
        return self::$dir;
    }

    public static function fileName()
    {
        return self::$file;
    }
}

require __DIR__ . '/values.php';
require __DIR__ . '/instrument.php';

R::start();
Stream::install();

// PHP opens the script it was asked to run itself, before this file and not
// through the stream wrapper. When that script is the program's own code, run
// the instrumented copy from here instead and stop before PHP runs the original.
$ambioMain = isset($_SERVER['SCRIPT_FILENAME']) ? \realpath($_SERVER['SCRIPT_FILENAME']) : false;
if ($ambioMain !== false && Stream::ours($ambioMain) && \getenv('AMBIO_PHP_NO_MAIN') === false) {
    unset($ambioMain);
    Stream::$main = true;
    // At the top level of this file, so the script's variables are globals as they would have been.
    require $_SERVER['SCRIPT_FILENAME'];
    exit;
}
unset($ambioMain);

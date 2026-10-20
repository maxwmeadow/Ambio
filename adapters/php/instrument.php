<?php
// Source rewriting for the PHP run recorder (ambio_recorder.php).
//
// Instrument turns a PHP file into one whose named functions and methods
// report to R on entry, on each return and when an exception leaves them.
// Stream stands in for PHP's file:// wrapper and serves that rewrite whenever
// PHP opens a workspace file to include it.

namespace AmbioRecorder;

final class Instrument
{
    const REC = '\\AmbioRecorder\\R';

    /**
     * The instrumented source, or the original when there is nothing to record
     * or the rewrite would not parse. Code is only ever added on a line that
     * already exists, so line numbers do not move.
     */
    public static function rewrite($code, $main = false)
    {
        try {
            $tokens = \token_get_all($code);
        } catch (\Throwable $e) {
            return $code;
        }
        $out = self::weave($tokens);
        if ($out === null) {
            $out = $code;
        }
        if ($main && \strncmp($out, '#!', 2) === 0) {
            // PHP skips a shebang only in the script it was started with. An
            // included copy would print it; an empty PHP block keeps the line.
            $end = \strpos($out, "\n");
            $out = '<?php ?>' . ($end === false ? '' : \substr($out, $end));
        }
        if ($out === $code) {
            return $code;
        }
        try {
            // TOKEN_PARSE runs the real parser: a rewrite that is not valid PHP is dropped.
            \token_get_all($out, TOKEN_PARSE);
        } catch (\Throwable $e) {
            return $code;
        }
        return $out;
    }

    private static function id($token)
    {
        return \is_array($token) ? $token[0] : null;
    }

    private static function text($token)
    {
        return \is_array($token) ? $token[1] : $token;
    }

    private static function blank($token)
    {
        $id = self::id($token);
        return $id === T_WHITESPACE || $id === T_COMMENT || $id === T_DOC_COMMENT;
    }

    private static function opens($token)
    {
        $id = self::id($token);
        return $token === '{' || $id === T_CURLY_OPEN || $id === T_DOLLAR_OPEN_CURLY_BRACES;
    }

    /** Index of the next token that is not whitespace or a comment. */
    private static function next(array $tokens, $i)
    {
        $n = \count($tokens);
        for ($i++; $i < $n && self::blank($tokens[$i]); $i++) {
        }
        return $i;
    }

    private static function previous(array $tokens, $i)
    {
        for ($i--; $i >= 0 && self::blank($tokens[$i]); $i--) {
        }
        return $i;
    }

    private static function weave(array $tokens)
    {
        $n = \count($tokens);
        $insertBefore = array(); // token index => text
        $insertAfter = array();
        $scopes = array();       // [kind, depth of the body, recorded?, returns by reference?]
        $depth = 0;
        $pending = null;         // a declaration whose body has not opened yet
        $recorded = 0;
        $modifiers = array(T_PUBLIC, T_PROTECTED, T_PRIVATE, T_STATIC, T_ABSTRACT, T_FINAL);

        for ($i = 0; $i < $n; $i++) {
            $token = $tokens[$i];
            $id = self::id($token);

            if ($id === T_HALT_COMPILER) {
                return null; // data follows the code; its offset must not move
            }

            if ($id === T_CLASS || $id === T_TRAIT || $id === T_INTERFACE || (\defined('T_ENUM') && $id === T_ENUM)) {
                $before = self::previous($tokens, $i);
                if ($before < 0 || self::id($tokens[$before]) !== T_DOUBLE_COLON) { // not Foo::class
                    $pending = array('class', null, false, false, '', 0, '');
                }
                continue;
            }

            if ($id === T_FUNCTION || $id === T_FN) {
                $at = self::next($tokens, $i);
                $byRef = false;
                if ($at < $n && \strpos(self::text($tokens[$at]), '&') === 0 && \trim(self::text($tokens[$at])) === '&') {
                    $byRef = true;
                    $at = self::next($tokens, $at);
                }
                if ($id === T_FN) {
                    continue; // an arrow function has no body of statements
                }
                if ($at >= $n || $tokens[$at] === '(') {
                    // A closure: not recorded, and its returns are its own.
                    $pending = array('closure', null, false, false, '', 0, '');
                    continue;
                }
                $name = self::text($tokens[$at]);
                $isStatic = false;
                for ($b = self::previous($tokens, $i); $b >= 0 && \in_array(self::id($tokens[$b]), $modifiers, true); $b = self::previous($tokens, $b)) {
                    if (self::id($tokens[$b]) === T_STATIC) {
                        $isStatic = true;
                    }
                }
                $inClass = $scopes && $scopes[\count($scopes) - 1][0] === 'class';
                // Parameter names: every variable inside the parameter list.
                $params = array();
                $open = self::next($tokens, $at);
                if ($open < $n && $tokens[$open] === '(') {
                    $level = 0;
                    for ($j = $open; $j < $n; $j++) {
                        if ($tokens[$j] === '(') {
                            $level++;
                        } elseif ($tokens[$j] === ')' && --$level === 0) {
                            break;
                        } elseif (self::id($tokens[$j]) === T_VARIABLE) {
                            // "...rest" marks a variadic: it takes every remaining argument.
                            $before = self::previous($tokens, $j);
                            $params[] = (self::id($tokens[$before]) === T_ELLIPSIS ? '...' : '') . \substr($tokens[$j][1], 1);
                        }
                    }
                }
                $pending = array('function', null, true, $byRef, $name, $token[2], \implode(',', $params), $inClass && !$isStatic);
                continue;
            }

            if ($token === ';' && $pending !== null && $pending[0] === 'function') {
                $pending = null; // abstract or interface method: no body
                continue;
            }

            if (self::opens($token)) {
                $depth++;
                if ($pending !== null && $token === '{') {
                    $pending[1] = $depth;
                    $scopes[] = $pending;
                    if ($pending[0] === 'function') {
                        $recorded++;
                        $insertAfter[$i] = ' $__ax = ' . self::REC . '::enter(__FILE__, ' . \var_export($pending[4], true) . ', ' . $pending[5] . ', '
                            . \var_export($pending[6], true) . ($pending[3] ? ', true' : '') . '); if ($__ax !== null && $__ax->watch !== null) { ' . self::REC . '::args($__ax, \\func_get_args(), '
                            . ($pending[7] ? '$this' : 'null') . '); } try {';
                    }
                    $pending = null;
                }
                continue;
            }

            if ($token === '}') {
                if ($scopes && $scopes[\count($scopes) - 1][1] === $depth) {
                    $scope = \array_pop($scopes);
                    if ($scope[0] === 'function') {
                        // Rethrowing the same object keeps its trace: a PHP exception records where it was created.
                        $insertBefore[$i] = ' } catch (\\Throwable $__axe) { ' . self::REC . '::thrown($__ax, $__axe); throw $__axe; } finally { '
                            . self::REC . '::leave($__ax); } ';
                    }
                }
                $depth--;
                continue;
            }

            if ($id === T_RETURN && $scopes) {
                $scope = $scopes[\count($scopes) - 1];
                if ($scope[0] !== 'function' || $scope[3]) {
                    continue; // a closure's return, or a function returning by reference
                }
                $first = self::next($tokens, $i);
                if ($first >= $n || $tokens[$first] === ';' || self::id($tokens[$first]) === T_CLOSE_TAG) {
                    continue; // a bare `return;`
                }
                $level = 0;
                for ($j = $first; $j < $n; $j++) {
                    $t = $tokens[$j];
                    if ($t === '(' || $t === '[' || self::opens($t)) {
                        $level++;
                    } elseif ($t === ')' || $t === ']' || $t === '}') {
                        $level--;
                    } elseif ($level === 0 && ($t === ';' || self::id($t) === T_CLOSE_TAG)) {
                        break;
                    }
                }
                if ($j < $n) {
                    $insertAfter[$i] = ' ' . self::REC . '::ret($__ax,';
                    $insertBefore[$j] = isset($insertBefore[$j]) ? ')' . $insertBefore[$j] : ')';
                }
            }
        }

        if ($recorded === 0) {
            return null;
        }
        $out = '';
        foreach ($tokens as $i => $token) {
            if (isset($insertBefore[$i])) {
                $out .= $insertBefore[$i];
            }
            $out .= self::text($token);
            if (isset($insertAfter[$i])) {
                $out .= $insertAfter[$i];
            }
        }
        return $out;
    }
}

/**
 * PHP's file:// wrapper, with one difference: a workspace .php file opened to
 * be included is served instrumented. Every other operation goes to the
 * native wrapper unchanged.
 */
final class Stream
{
    const OPEN_FOR_INCLUDE = 128; // STREAM_OPEN_FOR_INCLUDE, which PHP does not expose as a constant

    public static $main = false;
    private static $installed = false;

    /** @var resource|null */
    public $context;
    private $handle;

    public static function install()
    {
        if (!self::$installed) {
            self::$installed = true;
            \stream_wrapper_unregister('file');
            \stream_wrapper_register('file', __CLASS__);
        }
    }

    /** Runs $fn with PHP's own file wrapper in place. */
    public static function native($fn)
    {
        if (!self::$installed) {
            return $fn();
        }
        \stream_wrapper_restore('file');
        try {
            return $fn();
        } finally {
            \stream_wrapper_unregister('file');
            \stream_wrapper_register('file', __CLASS__);
        }
    }

    /** Whether a file is the program's own PHP: inside the workspace, not a dependency. */
    public static function ours($path)
    {
        $root = R::$root;
        if ($root === '' || \strncmp($path, $root . DIRECTORY_SEPARATOR, \strlen($root) + 1) !== 0) {
            return false;
        }
        $relative = \str_replace('\\', '/', \substr($path, \strlen($root)));
        if (\strpos($relative, '/vendor/') !== false || \strpos($relative, '/node_modules/') !== false) {
            return false;
        }
        $extension = \strtolower(\pathinfo($path, PATHINFO_EXTENSION));
        return $extension === 'php' || $extension === 'inc' || $extension === 'phtml';
    }

    public function stream_open($path, $mode, $options, &$openedPath)
    {
        $usePath = (bool) ($options & STREAM_USE_PATH);
        $report = (bool) ($options & STREAM_REPORT_ERRORS);
        $context = $this->context;
        if (($options & self::OPEN_FOR_INCLUDE) && $mode[0] === 'r') {
            $real = self::native(function () use ($path, $usePath) {
                return $usePath ? \stream_resolve_include_path($path) : \realpath($path);
            });
            if ($real !== false && self::ours($real)) {
                $main = self::$main;
                self::$main = false;
                $this->handle = self::native(function () use ($real, $main) {
                    $code = @\file_get_contents($real);
                    if ($code === false) {
                        return false;
                    }
                    $handle = \tmpfile();
                    if ($handle === false) {
                        return false;
                    }
                    \fwrite($handle, Instrument::rewrite($code, $main));
                    \rewind($handle);
                    return $handle;
                });
                if ($this->handle !== false && $this->handle !== null) {
                    $openedPath = $real;
                    return true;
                }
            }
        }
        $this->handle = self::native(function () use ($path, $mode, $usePath, $context, $report) {
            if ($context) {
                return $report ? \fopen($path, $mode, $usePath, $context) : @\fopen($path, $mode, $usePath, $context);
            }
            return $report ? \fopen($path, $mode, $usePath) : @\fopen($path, $mode, $usePath);
        });
        return (bool) $this->handle;
    }

    public function stream_close()
    {
        if (\is_resource($this->handle)) {
            \fclose($this->handle);
        }
    }

    public function stream_read($count)
    {
        return \fread($this->handle, $count);
    }

    public function stream_write($data)
    {
        return \fwrite($this->handle, $data);
    }

    public function stream_eof()
    {
        return \feof($this->handle);
    }

    public function stream_flush()
    {
        return \fflush($this->handle);
    }

    public function stream_seek($offset, $whence = SEEK_SET)
    {
        return \fseek($this->handle, $offset, $whence) === 0;
    }

    public function stream_tell()
    {
        return \ftell($this->handle);
    }

    public function stream_stat()
    {
        return \fstat($this->handle);
    }

    public function stream_truncate($size)
    {
        return \ftruncate($this->handle, $size);
    }

    public function stream_lock($operation)
    {
        // PHP passes 0 when a locked handle is closed.
        return $operation ? \flock($this->handle, $operation) : true;
    }

    public function stream_set_option($option, $arg1, $arg2)
    {
        switch ($option) {
            case STREAM_OPTION_BLOCKING:
                return \stream_set_blocking($this->handle, (bool) $arg1);
            case STREAM_OPTION_READ_TIMEOUT:
                return \stream_set_timeout($this->handle, $arg1, $arg2);
            case STREAM_OPTION_WRITE_BUFFER:
                return \stream_set_write_buffer($this->handle, $arg2) === 0;
            case STREAM_OPTION_READ_BUFFER:
                return \stream_set_read_buffer($this->handle, $arg2) === 0;
        }
        return false;
    }

    public function stream_cast($castAs)
    {
        return $this->handle ?: false;
    }

    public function stream_metadata($path, $option, $value)
    {
        return self::native(function () use ($path, $option, $value) {
            switch ($option) {
                case STREAM_META_TOUCH:
                    return $value ? \touch($path, isset($value[0]) ? $value[0] : \time(), isset($value[1]) ? $value[1] : \time()) : \touch($path);
                case STREAM_META_OWNER_NAME:
                case STREAM_META_OWNER:
                    return \chown($path, $value);
                case STREAM_META_GROUP_NAME:
                case STREAM_META_GROUP:
                    return \chgrp($path, $value);
                case STREAM_META_ACCESS:
                    return \chmod($path, $value);
            }
            return false;
        });
    }

    public function url_stat($path, $flags)
    {
        return self::native(function () use ($path, $flags) {
            $link = (bool) ($flags & STREAM_URL_STAT_LINK);
            if ($flags & STREAM_URL_STAT_QUIET) {
                return $link ? @\lstat($path) : @\stat($path);
            }
            return $link ? \lstat($path) : \stat($path);
        });
    }

    public function unlink($path)
    {
        $context = $this->context;
        return self::native(function () use ($path, $context) {
            return $context ? \unlink($path, $context) : \unlink($path);
        });
    }

    public function rename($from, $to)
    {
        $context = $this->context;
        return self::native(function () use ($from, $to, $context) {
            return $context ? \rename($from, $to, $context) : \rename($from, $to);
        });
    }

    public function mkdir($path, $mode, $options)
    {
        $context = $this->context;
        return self::native(function () use ($path, $mode, $options, $context) {
            $recursive = (bool) ($options & STREAM_MKDIR_RECURSIVE);
            return $context ? \mkdir($path, $mode, $recursive, $context) : \mkdir($path, $mode, $recursive);
        });
    }

    public function rmdir($path, $options)
    {
        $context = $this->context;
        return self::native(function () use ($path, $context) {
            return $context ? \rmdir($path, $context) : \rmdir($path);
        });
    }

    public function dir_opendir($path, $options)
    {
        $context = $this->context;
        $this->handle = self::native(function () use ($path, $context) {
            return $context ? \opendir($path, $context) : \opendir($path);
        });
        return (bool) $this->handle;
    }

    public function dir_readdir()
    {
        return \readdir($this->handle);
    }

    public function dir_rewinddir()
    {
        \rewinddir($this->handle);
        return true;
    }

    public function dir_closedir()
    {
        \closedir($this->handle);
        return true;
    }
}

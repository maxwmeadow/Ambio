"""Run recorder for `investigation run` - the Python twin of recorder.cjs.

archd launches the command with AXIOM_EVIDENCE_DIR set and this directory on
PYTHONPATH; sitecustomize starts the recorder before any user code runs. At
exit it writes one JSON document per process, in exactly the shape the Node
recorder writes, so archd analyses both the same way.

Mechanism: sys.settrace, which every supported CPython has (the streaming
adapter's sys.monitoring needs 3.12, and most projects are not there yet).
The global tracer sees every Python call; for code outside the workspace it
returns None, so library code gets no further callbacks. Workspace frames get
a local tracer with line events switched off, so only return and exception
events arrive. Overhead is a few times native speed on call-heavy code -
fine for a repro, not for production.

What it records matches recorder.cjs: call counts and caller -> callee edges
for every workspace function; for watched functions, call samples, per-path
value statistics, argument mutations, arguments shared by identity across
calls, repeated identical calls, returns and exceptions.
"""

from __future__ import annotations

import atexit
import json
import os
import sys
import threading
import time

SAMPLE_HEAD = 6
SAMPLE_TAIL = 4
MAX_EDGES = 5000
MAX_FUNCTIONS = 20000
FLATTEN_DEPTH = 4
FLATTEN_LEAVES = 160
SERIES_KEEP = 12
DISTINCT_KEEP = 24
PREVIEW_MAX = 240
MUTATION_EXAMPLES = 6
MAX_EXCEPTIONS = 20

_EXCLUDE_PARTS = ("site-packages", "dist-packages", ".venv", "venv", "node_modules", "__pypackages__", ".tox")


_REAL = {}


def _norm(path):
    """Canonical path. realpath matters: a project under a symlink (macOS
    /tmp -> /private/tmp, a linked home directory) otherwise never matches the
    paths Python reports, and the run silently records nothing."""
    hit = _REAL.get(path)
    if hit is None:
        try:
            hit = os.path.normcase(os.path.realpath(path))
        except Exception:
            hit = os.path.normcase(os.path.abspath(path))
        _REAL[path] = hit
    return hit


# ── value flattening (mirrors recorder.cjs) ─────────────────────────────────

_ABSENT = object()


def _leaf(v):
    if v is None:
        return ("null", None)
    if isinstance(v, bool):
        return ("boolean", v)
    if isinstance(v, int):
        return ("number", v)
    if isinstance(v, float):
        return ("number", v) if v == v and v not in (float("inf"), float("-inf")) else ("special", repr(v))
    if isinstance(v, str):
        return ("string", v if len(v) <= 120 else v[:119] + "…")
    if isinstance(v, bytes):
        return ("bytes", "<%d bytes>" % len(v))
    if type(v).__name__ == "Pattern" and hasattr(v, "pattern"):
        return ("regexp", "re.compile(%r)" % (v.pattern[:100],))
    if callable(v) and not isinstance(v, type):
        return ("function", "<function %s>" % getattr(v, "__name__", "?"))
    try:
        import decimal
        if isinstance(v, decimal.Decimal):
            return ("number", float(v))
    except Exception:
        pass
    return None


def _attrs(v):
    """An object's own data, without running properties or __getattr__."""
    d = getattr(v, "__dict__", None)
    if isinstance(d, dict):
        return list(d.items())
    slots = []
    for cls in type(v).__mro__:
        for name in getattr(cls, "__slots__", ()) or ():
            if isinstance(name, str) and not name.startswith("__"):
                try:
                    slots.append((name, object.__getattribute__(v, name)))
                except Exception:
                    pass
    return slots


def flatten(root, prefix):
    out = {}
    seen = set()

    def walk(v, p, depth):
        if len(out) >= FLATTEN_LEAVES:
            return
        l = _leaf(v)
        if l is not None:
            out[p] = l
            return
        if id(v) in seen:
            out[p] = ("ref", "<circular>")
            return
        if depth >= FLATTEN_DEPTH:
            out[p] = ("object", "<%s>" % type(v).__name__)
            return
        seen.add(id(v))
        try:
            if isinstance(v, dict):
                if not v:
                    out[p] = ("object", "{}")
                    return
                for i, (k, val) in enumerate(v.items()):
                    if i >= 24:
                        break
                    walk(val, "%s.%s" % (p, str(k)[:40]) if p else str(k)[:40], depth + 1)
            elif isinstance(v, (list, tuple)):
                out[p + ".length"] = ("number", len(v))
                for i, val in enumerate(v[:8]):
                    walk(val, "%s[%d]" % (p, i), depth + 1)
            elif isinstance(v, (set, frozenset)):
                out[p + ".size"] = ("number", len(v))
            else:
                items = _attrs(v)
                if not items:
                    out[p] = ("object", "<%s>" % type(v).__name__)
                    return
                for i, (k, val) in enumerate(items):
                    if i >= 24:
                        break
                    walk(val, "%s.%s" % (p, k) if p else k, depth + 1)
        finally:
            seen.discard(id(v))

    try:
        walk(root, prefix, 0)
    except Exception:
        pass
    return out


def _display(l):
    if l is None or l is _ABSENT:
        return "(absent)"
    kind, v = l
    if kind == "string":
        return json.dumps(v)
    if kind == "null":
        return "None"
    if kind == "boolean":
        return "True" if v else "False"
    if kind == "number" and isinstance(v, float) and v.is_integer():
        return repr(v)
    return str(v)


def preview(v, depth=0):
    """Bounded, side-effect-free rendering. Never calls a user __repr__."""
    try:
        s = _preview(v, depth)
    except Exception:
        s = "<%s>" % type(v).__name__
    return s if len(s) <= PREVIEW_MAX else s[: PREVIEW_MAX - 1] + "…"


def _preview(v, depth):
    l = _leaf(v)
    if l is not None:
        return _display(l)
    if depth >= 3:
        return "<%s>" % type(v).__name__
    if isinstance(v, dict):
        parts = ["%s: %s" % (json.dumps(str(k)) if isinstance(k, str) else str(k), _preview(x, depth + 1))
                 for k, x in list(v.items())[:8]]
        return "{" + ", ".join(parts) + (", …" if len(v) > 8 else "") + "}"
    if isinstance(v, (list, tuple, set, frozenset)):
        items = list(v)[:8]
        body = ", ".join(_preview(x, depth + 1) for x in items) + (", …" if len(v) > 8 else "")
        return ("[%s]" if isinstance(v, list) else "(%s)") % body
    attrs = _attrs(v)[:8]
    return "%s(%s)" % (type(v).__name__, ", ".join("%s=%s" % (k, _preview(x, depth + 1)) for k, x in attrs))


def _outcome_shape(returned):
    if returned is None or returned == "None":
        return "none"
    c = returned[:1]
    if c == "{":
        return "dict"
    if c in "[(":
        return "sequence"
    if c == '"':
        return "string"
    if returned in ("True", "False"):
        return "bool:" + returned
    try:
        float(returned)
        return "number"
    except ValueError:
        pass
    return "object:" + returned.split("(")[0][:40]


MAX_NODES = 60
NODE_DEPTH = 5
NODE_FIELDS = 48


def _leaf_text(v):
    l = _leaf(v)
    return _display(l) if l is not None else None


def collect_nodes(root, prefix, nodes):
    """Objects reachable from a value, each with its own leaf fields.

    Drift detection recognises the same object on a later call by identity (see
    recorder.cjs collectNodes). A separate walk with its own budget, because
    shared state tends to sit a few objects below the argument.
    """
    seen = set()

    def walk(v, p, depth):
        if len(nodes) >= MAX_NODES or depth > NODE_DEPTH or _leaf(v) is not None:
            return
        if id(v) in seen:
            return
        seen.add(id(v))
        fields = {}
        children = []
        try:
            if isinstance(v, dict):
                items = list(v.items())[:NODE_FIELDS]
            elif isinstance(v, (list, tuple)):
                fields["len"] = str(len(v))
                items = [("[%d]" % i, x) for i, x in enumerate(v[:8])]
            elif isinstance(v, (set, frozenset)):
                fields["len"] = str(len(v))
                items = []
            else:
                items = _attrs(v)[:NODE_FIELDS]
            for k, child in items:
                key = str(k)
                t = _leaf_text(child)
                if t is not None:
                    fields[key] = t
                elif child is not None:
                    sep = "" if key.startswith("[") else "."
                    children.append(("%s%s%s" % (p, sep, key), child))
        except Exception:
            return
        if fields:
            nodes.append((v, p, fields))
        for cp, c in children:
            walk(c, cp, depth + 1)

    try:
        walk(root, prefix, 0)
    except Exception:
        pass


class PathStats:
    __slots__ = ("count", "kind", "first", "last", "min", "max", "non_dec", "non_inc", "changes",
                 "series", "tail", "distinct", "overflow", "last_num")

    def __init__(self):
        self.count = 0
        self.kind = None
        self.first = None
        self.last = None
        self.min = None
        self.max = None
        self.non_dec = True
        self.non_inc = True
        self.changes = 0
        self.series = []
        self.tail = []
        self.distinct = {}
        self.overflow = False
        self.last_num = None

    def add(self, l):
        self.count += 1
        d = _display(l)
        k = l[0] if l is not None else "absent"
        if self.kind is None:
            self.kind = k
        elif self.kind != k and self.kind != "mixed":
            self.kind = "mixed"
        if self.count > 1 and d != self.last:
            self.changes += 1
        if l is not None and l[0] == "number" and isinstance(l[1], (int, float)):
            n = l[1]
            if self.count > 1 and self.last_num is not None:
                if n < self.last_num:
                    self.non_dec = False
                if n > self.last_num:
                    self.non_inc = False
            self.last_num = n
            self.min = n if self.min is None else min(self.min, n)
            self.max = n if self.max is None else max(self.max, n)
        if self.first is None:
            self.first = d
        self.last = d
        if len(self.series) < SERIES_KEEP:
            self.series.append(d)
        self.tail.append(d)
        if len(self.tail) > 3:
            self.tail.pop(0)
        if d in self.distinct:
            self.distinct[d] += 1
        elif len(self.distinct) < DISTINCT_KEEP:
            self.distinct[d] = 1
        else:
            self.overflow = True

    def to_json(self):
        numeric = self.kind == "number"
        if numeric and self.changes > 0:
            trend = "increasing" if self.non_dec else "decreasing" if self.non_inc else "varying"
        else:
            trend = "varying" if self.changes > 0 else "constant"
        doc = {
            "kind": self.kind,
            "count": self.count,
            "changes": self.changes,
            "distinct": ("%d+" % DISTINCT_KEEP) if self.overflow else len(self.distinct),
            "first": self.first,
            "last": self.last,
            "trend": trend,
            "series": self.series,
        }
        if numeric:
            doc["min"] = self.min
            doc["max"] = self.max
        if self.count > SERIES_KEEP:
            doc["tail"] = self.tail
        if len(self.distinct) <= 8 and not self.overflow:
            doc["top"] = [{"value": k, "n": n} for k, n in sorted(self.distinct.items(), key=lambda x: -x[1])]
        return doc


class WatchRecord:
    def __init__(self, file, symbol, line):
        self.file = file
        self.symbol = symbol
        self.line = line
        self.calls = 0
        self.errors = 0
        self.total_ms = 0.0
        self.head = []
        self.tail = []
        self.novel = []
        self.shapes = set()
        self.paths = {}
        self.mutations = {}
        self.exceptions = {}
        self.returns = PathStats()
        self.seen_objects = {}  # id -> (weak marker object, first call)
        self.shared = {}
        self.last_args = None
        self.repeats = 0
        self.repeat_example = None
        self.objects = {}  # id -> (object, path, call, fields); objects kept alive for the run
        self.drift = {}

    def observe(self, p, l):
        st = self.paths.get(p)
        if st is None:
            if len(self.paths) >= 400:
                return
            st = self.paths[p] = PathStats()
        st.add(l)

    def observe_args(self, call, names, values, fingerprint, args_preview):
        for name, v in zip(names, values):
            if _leaf(v) is not None:
                continue
            key = id(v)
            known = self.seen_objects.get(key)
            # ids are reused after garbage collection; keep the object alive
            # for the run so an id always means the same object.
            if known is None or known[0] is not v:
                self.seen_objects[key] = (v, call)
            else:
                st = self.shared.setdefault(name, {"param": name, "calls": 0, "firstCall": known[1]})
                st["calls"] += 1
        if self.last_args is not None and fingerprint == self.last_args and names:
            self.repeats += 1
            if self.repeat_example is None:
                self.repeat_example = {"call": call, "args": args_preview}
        self.last_args = fingerprint

    def check_drift(self, nodes, call):
        for obj, path, fields in nodes:
            parts = path.replace("[", ".[").split(".")
            if parts[0] in ("self", "cls") and len(parts) <= 2:
                continue  # the receiver's own state is expected to change
            prev = self.objects.get(id(obj))
            if prev is not None and prev[0] is obj and prev[2] != call:
                changes = []
                for k in list(dict.fromkeys(list(prev[3]) + list(fields))):
                    a = prev[3].get(k, "(absent)")
                    b = fields.get(k, "(absent)")
                    if a != b:
                        changes.append({"key": k, "before": a, "after": b})
                if changes:
                    d = self.drift.get(path)
                    if d is None and len(self.drift) < 20:
                        d = self.drift[path] = {"calls": 0, "examples": []}
                    if d is not None:
                        d["calls"] += 1
                        if len(d["examples"]) < 4:
                            d["examples"].append({"fromCall": prev[2], "toCall": call, "changes": changes[:4]})
            self.objects[id(obj)] = (obj, path, call, fields)

    def sample(self, s):
        # First example of each kind of outcome, wherever it happens (see
        # recorder.cjs): rare outcomes are usually the interesting ones.
        shape = ("threw:" + s["threw"].split(":")[0]) if s.get("threw") else _outcome_shape(s.get("returned"))
        known = shape in self.shapes
        if not known and len(self.shapes) < 8:
            self.shapes.add(shape)
        if len(self.head) < SAMPLE_HEAD:
            self.head.append(s)
            return
        if not known and len(self.novel) < 6:
            self.novel.append(s)
            return
        self.tail.append(s)
        if len(self.tail) > SAMPLE_TAIL:
            self.tail.pop(0)

    def to_json(self):
        return {
            "file": self.file,
            "symbol": self.symbol,
            "line": self.line,
            "calls": self.calls,
            "errors": self.errors,
            "avgMs": round(self.total_ms / self.calls, 3) if self.calls else 0,
            "samples": sorted(self.head + self.novel + self.tail, key=lambda x: x["call"]),
            "values": {k: v.to_json() for k, v in self.paths.items()},
            "mutations": [{"path": p, "calls": m["calls"], "examples": m["examples"]} for p, m in self.mutations.items()],
            "exceptions": [{"what": w, "n": n} for w, n in self.exceptions.items()],
            "returns": self.returns.to_json(),
            "shared": list(self.shared.values()),
            "repeats": self.repeats,
            "repeatExample": self.repeat_example,
            "drift": [{"path": p, "calls": d["calls"], "examples": d["examples"]} for p, d in self.drift.items()],
        }


class Recorder:
    def __init__(self, directory, run_id, root, watches):
        self.dir = directory
        self.run_id = run_id
        self.root = _norm(root) if root else None
        self.started = int(time.time() * 1000)
        self.functions = {}  # code -> [file, name, line, calls, errors, ms]
        self.edges = {}
        self.edges_dropped = 0
        self.watch_specs = {}
        self.watched = {}  # code -> WatchRecord | None
        self.uncaught = []
        self.frames = {}  # id(frame) -> frame state
        self.in_workspace = {}
        self.lock = threading.Lock()
        self.last_written = -1
        for w in watches:
            path = w.get("absPath") or w.get("file") or ""
            if not path:
                continue
            self.watch_specs.setdefault(_norm(path), []).append({
                "symbol": w.get("symbol") or "*",
                "lineStart": int(w.get("lineStart") or 0),
                "lineEnd": int(w.get("lineEnd") or 0),
            })

    # ── classification ─────────────────────────────────────────────────────

    def _workspace(self, filename):
        hit = self.in_workspace.get(filename)
        if hit is not None:
            return hit
        ok = False
        if filename and not filename.startswith("<") and self.root:
            path = _norm(filename)
            if path.startswith(self.root + os.sep):
                rel = path[len(self.root) + 1:]
                ok = not any(part in _EXCLUDE_PARTS for part in rel.split(os.sep))
        self.in_workspace[filename] = ok
        return ok

    def _fn(self, code):
        f = self.functions.get(code)
        if f is None:
            if len(self.functions) >= MAX_FUNCTIONS:
                return None
            f = [code.co_filename, code.co_name, code.co_firstlineno, 0, 0, 0.0]
            self.functions[code] = f
        return f

    def _watch_for(self, code):
        if code in self.watched:
            return self.watched[code]
        specs = self.watch_specs.get(_norm(code.co_filename))
        rec = None
        if specs:
            hit = None
            line = code.co_firstlineno
            for s in specs:
                if s["symbol"] == "*":
                    hit = s
                    break
                if s["symbol"] != code.co_name:
                    continue
                # Decorators put co_firstlineno on the decorator line, which the
                # indexer may place a line or two before the def.
                if not s["lineStart"] or s["lineStart"] - 3 <= line <= max(s["lineEnd"], s["lineStart"]):
                    hit = s
                    break
            if hit is None:
                named = [s for s in specs if s["symbol"] == code.co_name]
                if len(named) == 1:
                    hit = named[0]
            if hit is not None:
                rec = WatchRecord(code.co_filename, code.co_name, code.co_firstlineno)
        self.watched[code] = rec
        return rec

    # ── tracing ──────────────────────────────────────────────────────────────

    def global_trace(self, frame, event, arg):
        if event != "call":
            return None
        code = frame.f_code
        if not self._workspace(code.co_filename):
            return None
        try:
            self._on_call(frame, code)
        except Exception:
            return None
        frame.f_trace_lines = False
        return self.local_trace

    def _on_call(self, frame, code):
        with self.lock:
            f = self._fn(code)
            if f is None:
                return
            f[3] += 1
            caller = frame.f_back
            hops = 0
            while caller is not None and hops < 8 and not self._workspace(caller.f_code.co_filename):
                caller = caller.f_back
                hops += 1
            if caller is not None and caller.f_code is not code and caller.f_code in self.functions:
                key = (caller.f_code, code)
                n = self.edges.get(key)
                if n is not None:
                    self.edges[key] = n + 1
                elif len(self.edges) < MAX_EDGES:
                    self.edges[key] = 1
                else:
                    self.edges_dropped += 1
            state = {"f": f, "t0": time.perf_counter(), "w": None, "exc": None}
            w = self._watch_for(code)
            if w is not None:
                w.calls += 1
                nargs = code.co_argcount + code.co_kwonlyargcount
                names = list(code.co_varnames[:nargs])
                if code.co_flags & 0x04:  # *args
                    names.append(code.co_varnames[nargs])
                    nargs += 1
                if code.co_flags & 0x08:  # **kwargs
                    names.append(code.co_varnames[nargs])
                values = [frame.f_locals.get(n) for n in names]
                before = {}
                nodes = []
                for n, v in zip(names, values):
                    for p, l in flatten(v, n).items():
                        before[p] = l
                        w.observe("arg." + p, l)
                    collect_nodes(v, n, nodes)
                w.check_drift(nodes, w.calls)
                args_preview = preview(dict(zip(names, values)))
                fingerprint = "|".join("%s=%s" % (p, _display(l)) for p, l in before.items())
                w.observe_args(w.calls, names, values, fingerprint, args_preview)
                state["w"] = {"rec": w, "names": names, "values": values, "before": before,
                              "call": w.calls, "args": args_preview}
            self.frames[id(frame)] = state

    def local_trace(self, frame, event, arg):
        if event == "exception":
            st = self.frames.get(id(frame))
            if st is not None:
                st["exc"] = arg
        elif event == "return":
            try:
                self._on_return(frame, arg)
            except Exception:
                pass
        return self.local_trace

    def _on_return(self, frame, value):
        with self.lock:
            st = self.frames.pop(id(frame), None)
            if st is None:
                return
            ms = (time.perf_counter() - st["t0"]) * 1000.0
            f = st["f"]
            f[5] += ms
            # A frame unwinding because of an exception returns None after an
            # exception event. (A function that catches an exception and then
            # returns None looks the same; rare enough to accept.)
            threw = None
            if st["exc"] is not None and value is None:
                etype, evalue = st["exc"][0], st["exc"][1]
                threw = "%s: %s" % (getattr(etype, "__name__", "Exception"), str(evalue)[:200])
                f[4] += 1
            w = st["w"]
            if w is None:
                return
            rec = w["rec"]
            rec.total_ms += ms
            if threw:
                rec.errors += 1
                if len(rec.exceptions) < MAX_EXCEPTIONS or threw in rec.exceptions:
                    rec.exceptions[threw] = rec.exceptions.get(threw, 0) + 1
            else:
                whole = preview(value)
                rec.returns.add(("number", value) if isinstance(value, (int, float)) and not isinstance(value, bool)
                                else ("text", whole if len(whole) <= 80 else whole[:79] + "…"))
                for p, l in flatten(value, "return").items():
                    rec.observe(p, l)
            changed = []
            nodes = []
            for n, v in zip(w["names"], w["values"]):
                after = flatten(v, n)
                collect_nodes(v, n, nodes)
                keys = [k for k in w["before"] if k == n or k.startswith(n + ".") or k.startswith(n + "[")]
                keys += [k for k in after if k not in w["before"]]
                for k in keys:
                    b = _display(w["before"].get(k))
                    a = _display(after.get(k))
                    if a != b:
                        changed.append((k, b, a))
            rec.check_drift(nodes, w["call"])
            real = [c for c in changed if not (
                c[1] in ("{}", "(absent)") or c[2] in ("{}", "(absent)")
            ) or not any(o is not c and (o[0].startswith(c[0] + ".") or o[0].startswith(c[0] + "[")) for o in changed)]
            for path, b, a in real[:20]:
                m = rec.mutations.get(path)
                if m is None:
                    if len(rec.mutations) >= 40:
                        continue
                    m = rec.mutations[path] = {"calls": 0, "examples": []}
                m["calls"] += 1
                if len(m["examples"]) < MUTATION_EXAMPLES:
                    m["examples"].append({"call": w["call"], "before": b, "after": a})
            sample = {"call": w["call"], "args": w["args"], "ms": round(ms, 3)}
            if threw:
                sample["threw"] = threw
            else:
                sample["returned"] = preview(value)
            if real:
                sample["mutated"] = ["%s: %s → %s" % c for c in real[:4]]
            rec.sample(sample)

    # ── crashes and output ──────────────────────────────────────────────────

    def uncaught_exception(self, etype, value, tb):
        if len(self.uncaught) >= 5:
            return
        import traceback
        stack = "".join(traceback.format_exception(etype, value, tb))
        # Node-style frames so archd's stack parser can place the crash.
        frames = []
        for fs in traceback.extract_tb(tb)[::-1][:12]:
            frames.append("    at %s (%s:%d:1)" % (fs.name, fs.filename, fs.lineno or 0))
        self.uncaught.append({
            "what": "%s: %s" % (getattr(etype, "__name__", "Exception"), str(value)[:300]),
            "stack": "\n".join(frames) or stack[-2000:],
        })

    def write(self):
        if not self.dir:
            return
        with self.lock:
            total = sum(f[3] for f in self.functions.values()) + len(self.uncaught)
            if total == self.last_written:
                return
            self.last_written = total
            if not self.functions and not self.uncaught:
                return
            functions = [{"file": f[0], "name": f[1], "line": f[2], "calls": f[3], "errors": f[4], "ms": round(f[5], 3)}
                         for f in self.functions.values()]
            edges = []
            for (a, b), n in self.edges.items():
                edges.append({
                    "from": {"file": a.co_filename, "name": a.co_name, "line": a.co_firstlineno},
                    "to": {"file": b.co_filename, "name": b.co_name, "line": b.co_firstlineno},
                    "calls": n,
                })
            watched = [r.to_json() for r in self.watched.values() if r is not None]
            doc = {
                "version": 1,
                "runId": self.run_id,
                "pid": os.getpid(),
                "argv": [os.path.basename(a) for a in sys.argv[:3]],
                "startedAt": self.started,
                "endedAt": int(time.time() * 1000),
                "functions": functions,
                "edges": edges,
                "edgesDropped": self.edges_dropped,
                "watched": watched,
                "uncaught": self.uncaught,
            }
        try:
            os.makedirs(self.dir, exist_ok=True)
            tmp = os.path.join(self.dir, "%d.json.tmp" % os.getpid())
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(doc, fh, default=str)
            os.replace(tmp, os.path.join(self.dir, "%d.json" % os.getpid()))
        except Exception:
            pass


_recorder = None


def start():
    """Start recording if archd launched this process as a run. Never raises."""
    global _recorder
    if _recorder is not None:
        return _recorder
    directory = os.environ.get("AXIOM_EVIDENCE_DIR")
    if not directory:
        return None
    try:
        watches = json.loads(os.environ.get("AXIOM_WATCHES") or "[]")
    except Exception:
        watches = []
    try:
        rec = Recorder(directory, os.environ.get("AXIOM_RUN_ID", ""),
                       os.environ.get("AXIOM_WORKSPACE_ROOT") or os.getcwd(), watches)
    except Exception:
        return None
    _recorder = rec

    previous_hook = sys.excepthook

    def hook(etype, value, tb):
        try:
            rec.uncaught_exception(etype, value, tb)
            rec.write()
        except Exception:
            pass
        previous_hook(etype, value, tb)

    sys.excepthook = hook
    atexit.register(rec.write)

    # A killed process (timeout) skips atexit; flush periodically instead of
    # installing signal handlers that would override the program's own.
    def flusher():
        while True:
            time.sleep(1.0)
            rec.write()

    threading.Thread(target=flusher, name="axiom-recorder-flush", daemon=True).start()
    threading.settrace(rec.global_trace)
    sys.settrace(rec.global_trace)
    return rec

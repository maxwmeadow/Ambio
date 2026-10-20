package dev.ambio.agent.rt;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Everything recorded about one watched method (WatchRecord in recorder.py). */
final class Watch {
    static final int SAMPLE_HEAD = 6;
    static final int SAMPLE_TAIL = 4;
    static final int SERIES_KEEP = 12;
    static final int DISTINCT_KEEP = 24;
    static final int MUTATION_EXAMPLES = 6;
    static final int MAX_EXCEPTIONS = 20;

    /** How one value path behaved across calls. */
    static final class PathStats {
        int count;
        String kind;
        String first;
        String last;
        Double min;
        Double max;
        boolean nonDec = true;
        boolean nonInc = true;
        int changes;
        final List<String> series = new ArrayList<String>();
        final List<String> tail = new ArrayList<String>();
        final LinkedHashMap<String, Integer> distinct = new LinkedHashMap<String, Integer>();
        boolean overflow;
        Double lastNum;

        void add(Values.Leaf l) {
            add(Values.display(l), l == null ? "absent" : l.kind, l != null && l.numeric() ? ((Number) l.v).doubleValue() : null);
        }

        void addText(String text) {
            add(text, "text", null);
        }

        private void add(String d, String k, Double n) {
            count++;
            if (kind == null) {
                kind = k;
            } else if (!kind.equals(k) && !kind.equals("mixed")) {
                kind = "mixed";
            }
            if (count > 1 && !d.equals(last)) {
                changes++;
            }
            if (n != null) {
                if (count > 1 && lastNum != null) {
                    if (n < lastNum) {
                        nonDec = false;
                    }
                    if (n > lastNum) {
                        nonInc = false;
                    }
                }
                lastNum = n;
                min = min == null ? n : Math.min(min, n);
                max = max == null ? n : Math.max(max, n);
            }
            if (first == null) {
                first = d;
            }
            last = d;
            if (series.size() < SERIES_KEEP) {
                series.add(d);
            }
            tail.add(d);
            if (tail.size() > 3) {
                tail.remove(0);
            }
            Integer seen = distinct.get(d);
            if (seen != null) {
                distinct.put(d, seen + 1);
            } else if (distinct.size() < DISTINCT_KEEP) {
                distinct.put(d, 1);
            } else {
                overflow = true;
            }
        }

        void json(StringBuilder b) {
            boolean numeric = "number".equals(kind);
            String trend;
            if (numeric && changes > 0) {
                trend = nonDec ? "increasing" : nonInc ? "decreasing" : "varying";
            } else {
                trend = changes > 0 ? "varying" : "constant";
            }
            b.append("{\"kind\":");
            Json.str(b, kind);
            b.append(",\"count\":").append(count).append(",\"changes\":").append(changes).append(",\"distinct\":");
            if (overflow) {
                Json.str(b, DISTINCT_KEEP + "+");
            } else {
                b.append(distinct.size());
            }
            b.append(",\"first\":");
            Json.str(b, first);
            b.append(",\"last\":");
            Json.str(b, last);
            b.append(",\"trend\":");
            Json.str(b, trend);
            b.append(",\"series\":");
            strings(b, series);
            if (numeric && min != null) {
                b.append(",\"min\":");
                Json.num(b, min);
                b.append(",\"max\":");
                Json.num(b, max);
            }
            if (count > SERIES_KEEP) {
                b.append(",\"tail\":");
                strings(b, tail);
            }
            if (distinct.size() <= 8 && !overflow) {
                List<Map.Entry<String, Integer>> top = new ArrayList<Map.Entry<String, Integer>>(distinct.entrySet());
                Collections.sort(top, new Comparator<Map.Entry<String, Integer>>() {
                    public int compare(Map.Entry<String, Integer> x, Map.Entry<String, Integer> y) {
                        return y.getValue() - x.getValue();
                    }
                });
                b.append(",\"top\":[");
                for (int i = 0; i < top.size(); i++) {
                    if (i > 0) {
                        b.append(',');
                    }
                    b.append("{\"value\":");
                    Json.str(b, top.get(i).getKey());
                    b.append(",\"n\":").append(top.get(i).getValue()).append('}');
                }
                b.append(']');
            }
            b.append('}');
        }
    }

    static void strings(StringBuilder b, List<String> items) {
        b.append('[');
        for (int i = 0; i < items.size(); i++) {
            if (i > 0) {
                b.append(',');
            }
            Json.str(b, items.get(i));
        }
        b.append(']');
    }

    static final class Sample {
        int call;
        String args;
        double ms;
        String returned;
        String threw;
        List<String> mutated;
    }

    private static final class Seen {
        final String path;
        final int call;
        final LinkedHashMap<String, String> fields;

        Seen(String path, int call, LinkedHashMap<String, String> fields) {
            this.path = path;
            this.call = call;
            this.fields = fields;
        }
    }

    final String file;
    final String symbol;
    final int line;
    int calls;
    int errors;
    double totalMs;
    final List<Sample> head = new ArrayList<Sample>();
    final List<Sample> tail = new ArrayList<Sample>();
    final List<Sample> novel = new ArrayList<Sample>();
    final Set<String> shapes = new HashSet<String>();
    final LinkedHashMap<String, PathStats> paths = new LinkedHashMap<String, PathStats>();
    /** path → [calls, examples json list] */
    final LinkedHashMap<String, List<String>> mutationExamples = new LinkedHashMap<String, List<String>>();
    final LinkedHashMap<String, Integer> mutationCalls = new LinkedHashMap<String, Integer>();
    final LinkedHashMap<String, Integer> exceptions = new LinkedHashMap<String, Integer>();
    final PathStats returns = new PathStats();
    /** Objects passed before, kept for the run so identity stays meaningful. */
    final IdentityHashMap<Object, Integer> seenObjects = new IdentityHashMap<Object, Integer>();
    final LinkedHashMap<String, int[]> shared = new LinkedHashMap<String, int[]>(); // param → [calls, firstCall]
    String lastArgs;
    int repeats;
    String repeatExample;
    final IdentityHashMap<Object, Seen> objects = new IdentityHashMap<Object, Seen>();
    final LinkedHashMap<String, Integer> driftCalls = new LinkedHashMap<String, Integer>();
    final LinkedHashMap<String, List<String>> driftExamples = new LinkedHashMap<String, List<String>>();

    Watch(String file, String symbol, int line) {
        this.file = file;
        this.symbol = symbol;
        this.line = line;
    }

    void observe(String path, Values.Leaf l) {
        PathStats st = paths.get(path);
        if (st == null) {
            if (paths.size() >= 400) {
                return;
            }
            st = new PathStats();
            paths.put(path, st);
        }
        st.add(l);
    }

    void observeArgs(int call, String[] names, Object[] values, String fingerprint, String argsPreview) {
        for (int i = 0; i < names.length; i++) {
            Object v = values[i];
            if (Values.leaf(v) != null) {
                continue;
            }
            Integer first = seenObjects.get(v);
            if (first == null) {
                seenObjects.put(v, call);
            } else {
                int[] st = shared.get(names[i]);
                if (st == null) {
                    st = new int[] {0, first};
                    shared.put(names[i], st);
                }
                st[0]++;
            }
        }
        if (lastArgs != null && fingerprint.equals(lastArgs) && names.length > 0) {
            repeats++;
            if (repeatExample == null) {
                StringBuilder b = new StringBuilder("{\"call\":").append(call).append(",\"args\":");
                Json.str(b, argsPreview);
                repeatExample = b.append('}').toString();
            }
        }
        lastArgs = fingerprint;
    }

    /** The same object, seen on an earlier call with different contents. */
    void checkDrift(List<Values.Node> nodes, int call) {
        for (Values.Node node : nodes) {
            String[] parts = node.path.replace("[", ".[").split("\\.");
            if (parts[0].equals("this") && parts.length <= 2) {
                continue; // the receiver's own state is expected to change
            }
            Seen prev = objects.get(node.obj);
            if (prev != null && prev.call != call) {
                LinkedHashSet<String> keys = new LinkedHashSet<String>(prev.fields.keySet());
                keys.addAll(node.fields.keySet());
                List<String> changes = new ArrayList<String>();
                for (String k : keys) {
                    String a = prev.fields.containsKey(k) ? prev.fields.get(k) : "(absent)";
                    String b = node.fields.containsKey(k) ? node.fields.get(k) : "(absent)";
                    if (!a.equals(b) && changes.size() < 4) {
                        StringBuilder c = new StringBuilder("{\"key\":");
                        Json.str(c, k);
                        c.append(",\"before\":");
                        Json.str(c, a);
                        c.append(",\"after\":");
                        Json.str(c, b);
                        changes.add(c.append('}').toString());
                    }
                }
                if (!changes.isEmpty()) {
                    Integer n = driftCalls.get(node.path);
                    if (n != null || driftCalls.size() < 20) {
                        driftCalls.put(node.path, n == null ? 1 : n + 1);
                        List<String> examples = driftExamples.get(node.path);
                        if (examples == null) {
                            examples = new ArrayList<String>();
                            driftExamples.put(node.path, examples);
                        }
                        if (examples.size() < 4) {
                            examples.add("{\"fromCall\":" + prev.call + ",\"toCall\":" + call + ",\"changes\":" + changes + "}");
                        }
                    }
                }
            }
            objects.put(node.obj, new Seen(node.path, call, node.fields));
        }
    }

    void mutation(String path, String before, String after, int call) {
        Integer n = mutationCalls.get(path);
        if (n == null && mutationCalls.size() >= 40) {
            return;
        }
        mutationCalls.put(path, n == null ? 1 : n + 1);
        List<String> examples = mutationExamples.get(path);
        if (examples == null) {
            examples = new ArrayList<String>();
            mutationExamples.put(path, examples);
        }
        if (examples.size() < MUTATION_EXAMPLES) {
            StringBuilder b = new StringBuilder("{\"call\":").append(call).append(",\"before\":");
            Json.str(b, before);
            b.append(",\"after\":");
            Json.str(b, after);
            examples.add(b.append('}').toString());
        }
    }

    void exception(String what) {
        errors++;
        Integer n = exceptions.get(what);
        if (n != null || exceptions.size() < MAX_EXCEPTIONS) {
            exceptions.put(what, n == null ? 1 : n + 1);
        }
    }

    /** Keeps the first calls, the last calls, and the first of each kind of outcome. */
    void sample(Sample s) {
        String shape = s.threw != null ? "threw:" + s.threw.split(":")[0] : Values.outcomeShape(s.returned);
        boolean known = shapes.contains(shape);
        if (!known && shapes.size() < 8) {
            shapes.add(shape);
        }
        if (head.size() < SAMPLE_HEAD) {
            head.add(s);
            return;
        }
        if (!known && novel.size() < 6) {
            novel.add(s);
            return;
        }
        tail.add(s);
        if (tail.size() > SAMPLE_TAIL) {
            tail.remove(0);
        }
    }

    void json(StringBuilder b) {
        b.append("{\"file\":");
        Json.str(b, file);
        b.append(",\"symbol\":");
        Json.str(b, symbol);
        b.append(",\"line\":").append(line).append(",\"calls\":").append(calls).append(",\"errors\":").append(errors);
        b.append(",\"avgMs\":");
        Json.num(b, calls == 0 ? 0 : Math.round(totalMs / calls * 1000.0) / 1000.0);
        List<Sample> all = new ArrayList<Sample>(head);
        all.addAll(novel);
        all.addAll(tail);
        Collections.sort(all, new Comparator<Sample>() {
            public int compare(Sample x, Sample y) {
                return x.call - y.call;
            }
        });
        b.append(",\"samples\":[");
        for (int i = 0; i < all.size(); i++) {
            Sample s = all.get(i);
            if (i > 0) {
                b.append(',');
            }
            b.append("{\"call\":").append(s.call).append(",\"args\":");
            Json.str(b, s.args);
            b.append(",\"ms\":");
            Json.num(b, Math.round(s.ms * 1000.0) / 1000.0);
            if (s.threw != null) {
                b.append(",\"threw\":");
                Json.str(b, s.threw);
            } else {
                b.append(",\"returned\":");
                Json.str(b, s.returned);
            }
            if (s.mutated != null) {
                b.append(",\"mutated\":");
                strings(b, s.mutated);
            }
            b.append('}');
        }
        b.append("],\"values\":{");
        int i = 0;
        for (Map.Entry<String, PathStats> e : paths.entrySet()) {
            if (i++ > 0) {
                b.append(',');
            }
            Json.str(b, e.getKey());
            b.append(':');
            e.getValue().json(b);
        }
        b.append("},\"mutations\":[");
        i = 0;
        for (Map.Entry<String, Integer> e : mutationCalls.entrySet()) {
            if (i++ > 0) {
                b.append(',');
            }
            b.append("{\"path\":");
            Json.str(b, e.getKey());
            b.append(",\"calls\":").append(e.getValue()).append(",\"examples\":").append(mutationExamples.get(e.getKey())).append('}');
        }
        b.append("],\"exceptions\":[");
        i = 0;
        for (Map.Entry<String, Integer> e : exceptions.entrySet()) {
            if (i++ > 0) {
                b.append(',');
            }
            b.append("{\"what\":");
            Json.str(b, e.getKey());
            b.append(",\"n\":").append(e.getValue()).append('}');
        }
        b.append("],\"returns\":");
        returns.json(b);
        b.append(",\"shared\":[");
        i = 0;
        for (Map.Entry<String, int[]> e : shared.entrySet()) {
            if (i++ > 0) {
                b.append(',');
            }
            b.append("{\"param\":");
            Json.str(b, e.getKey());
            b.append(",\"calls\":").append(e.getValue()[0]).append(",\"firstCall\":").append(e.getValue()[1]).append('}');
        }
        b.append("],\"repeats\":").append(repeats).append(",\"repeatExample\":").append(repeatExample == null ? "null" : repeatExample);
        b.append(",\"drift\":[");
        i = 0;
        for (Map.Entry<String, Integer> e : driftCalls.entrySet()) {
            if (i++ > 0) {
                b.append(',');
            }
            b.append("{\"path\":");
            Json.str(b, e.getKey());
            b.append(",\"calls\":").append(e.getValue()).append(",\"examples\":").append(driftExamples.get(e.getKey())).append('}');
        }
        b.append("]}");
    }
}

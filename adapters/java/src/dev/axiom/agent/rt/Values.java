package dev.axiom.agent.rt;

import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collection;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Value flattening and previews, mirroring recorder.py. Nothing here runs the
 * user's code: no toString, hashCode, equals or getters. Objects are read
 * field by field through reflection, and only the JDK's own collections are
 * iterated (a lazy ORM collection would otherwise load itself).
 */
final class Values {
    private Values() {}

    static final int FLATTEN_DEPTH = 4;
    static final int FLATTEN_LEAVES = 160;
    static final int PREVIEW_MAX = 240;
    static final int MAX_NODES = 60;
    static final int NODE_DEPTH = 5;
    static final int NODE_FIELDS = 48;

    /** A value with no parts worth walking. kind is one of the recorder kinds. */
    static final class Leaf {
        final String kind;
        final Object v;

        Leaf(String kind, Object v) {
            this.kind = kind;
            this.v = v;
        }

        boolean numeric() {
            return "number".equals(kind) && v instanceof Number;
        }
    }

    /** An object reachable from a value, with its own leaf fields (drift). */
    static final class Node {
        final Object obj;
        final String path;
        final LinkedHashMap<String, String> fields;

        Node(Object obj, String path, LinkedHashMap<String, String> fields) {
            this.obj = obj;
            this.path = path;
            this.fields = fields;
        }
    }

    private static boolean jdk(String className) {
        return className.startsWith("java.") || className.startsWith("javax.") || className.startsWith("jdk.")
            || className.startsWith("sun.") || className.startsWith("com.sun.");
    }

    /** JDK and Kotlin collections are safe to iterate; anything else is read as an object. */
    private static boolean plainCollection(Object v) {
        String n = v.getClass().getName();
        return n.startsWith("java.") || n.startsWith("kotlin.");
    }

    static Leaf leaf(Object v) {
        if (v == null) {
            return new Leaf("null", null);
        }
        if (v instanceof Boolean) {
            return new Leaf("boolean", v);
        }
        if (v instanceof Float || v instanceof Double) {
            double d = ((Number) v).doubleValue();
            return Double.isNaN(d) || Double.isInfinite(d) ? new Leaf("special", String.valueOf(d)) : new Leaf("number", v);
        }
        if (v instanceof Number) {
            String n = v.getClass().getName();
            if (n.startsWith("java.lang.") || n.startsWith("java.math.") || n.startsWith("java.util.concurrent.atomic.")) {
                return new Leaf("number", v);
            }
            return null;
        }
        if (v instanceof String) {
            String s = (String) v;
            return new Leaf("string", s.length() <= 120 ? s : s.substring(0, 119) + "…");
        }
        if (v instanceof Character) {
            return new Leaf("string", v.toString());
        }
        if (v instanceof byte[]) {
            return new Leaf("bytes", "<" + ((byte[]) v).length + " bytes>");
        }
        if (v instanceof Enum) {
            return new Leaf("enum", simpleName(((Enum<?>) v).getDeclaringClass()) + "." + ((Enum<?>) v).name());
        }
        if (v instanceof Class) {
            return new Leaf("class", "<class " + simpleName((Class<?>) v) + ">");
        }
        Class<?> c = v.getClass();
        String n = c.getName();
        if (c.isSynthetic() || n.contains("$$Lambda") || n.contains("$Lambda$")) {
            return new Leaf("function", "<lambda>");
        }
        // Immutable JDK values whose toString is their value.
        if (n.startsWith("java.time.") || n.equals("java.util.UUID") || n.equals("java.util.Date")
            || n.equals("java.net.URI") || n.equals("java.io.File") || n.equals("java.util.regex.Pattern")
            || n.equals("java.util.Locale") || n.equals("java.util.Currency") || n.startsWith("java.sql.")
            || (n.startsWith("sun.nio.fs.") && n.endsWith("Path"))) {
            try {
                String s = v.toString();
                return new Leaf("value", s.length() <= 120 ? s : s.substring(0, 119) + "…");
            } catch (Throwable t) {
                return new Leaf("value", "<" + simpleName(c) + ">");
            }
        }
        return null;
    }

    static String display(Leaf l) {
        if (l == null) {
            return "(absent)";
        }
        if ("string".equals(l.kind)) {
            return Json.quote((String) l.v);
        }
        if ("null".equals(l.kind)) {
            return "null";
        }
        if (l.v instanceof BigDecimal) {
            return ((BigDecimal) l.v).toPlainString();
        }
        return String.valueOf(l.v);
    }

    static String simpleName(Class<?> c) {
        String n = c.getName();
        int dot = n.lastIndexOf('.');
        String s = dot >= 0 ? n.substring(dot + 1) : n;
        int dollar = s.lastIndexOf('$');
        return dollar >= 0 && dollar < s.length() - 1 ? s.substring(dollar + 1) : s;
    }

    private static final ConcurrentHashMap<Class<?>, Field[]> FIELDS = new ConcurrentHashMap<Class<?>, Field[]>();

    /** An object's own data: instance fields of its non-JDK classes. */
    static Field[] fieldsOf(Class<?> type) {
        Field[] hit = FIELDS.get(type);
        if (hit != null) {
            return hit;
        }
        List<Field> out = new ArrayList<Field>();
        for (Class<?> k = type; k != null && k != Object.class && !jdk(k.getName()); k = k.getSuperclass()) {
            try {
                for (Field f : k.getDeclaredFields()) {
                    if (Modifier.isStatic(f.getModifiers()) || f.isSynthetic()) {
                        continue;
                    }
                    try {
                        f.setAccessible(true);
                        out.add(f);
                    } catch (Throwable t) {
                        // not open to reflection: leave it out
                    }
                }
            } catch (Throwable t) {
                break;
            }
        }
        hit = out.toArray(new Field[0]);
        FIELDS.put(type, hit);
        return hit;
    }

    private static Object get(Field f, Object v) {
        try {
            return f.get(v);
        } catch (Throwable t) {
            return null;
        }
    }

    private static String keyText(Object k) {
        Leaf l = leaf(k);
        String s = l == null ? "<" + simpleName(k.getClass()) + ">" : "string".equals(l.kind) ? (String) l.v : display(l);
        return s.length() <= 40 ? s : s.substring(0, 40);
    }

    private static Object[] head(Object listOrArray, int n) {
        if (listOrArray instanceof List) {
            List<?> l = (List<?>) listOrArray;
            Object[] out = new Object[Math.min(n, l.size())];
            for (int i = 0; i < out.length; i++) {
                out[i] = l.get(i);
            }
            return out;
        }
        Object[] out = new Object[Math.min(n, Array.getLength(listOrArray))];
        for (int i = 0; i < out.length; i++) {
            out[i] = Array.get(listOrArray, i);
        }
        return out;
    }

    private static int length(Object listOrArray) {
        return listOrArray instanceof List ? ((List<?>) listOrArray).size() : Array.getLength(listOrArray);
    }

    private static boolean sequence(Object v) {
        return v.getClass().isArray() || (v instanceof List && plainCollection(v));
    }

    static LinkedHashMap<String, Leaf> flatten(Object root, String prefix) {
        LinkedHashMap<String, Leaf> out = new LinkedHashMap<String, Leaf>();
        try {
            walk(root, prefix, 0, out, new IdentityHashMap<Object, Boolean>());
        } catch (Throwable t) {
            // keep what was read
        }
        return out;
    }

    private static void walk(Object v, String p, int depth, Map<String, Leaf> out, IdentityHashMap<Object, Boolean> seen) {
        if (out.size() >= FLATTEN_LEAVES) {
            return;
        }
        Leaf l = leaf(v);
        if (l != null) {
            out.put(p, l);
            return;
        }
        if (seen.containsKey(v)) {
            out.put(p, new Leaf("ref", "<circular>"));
            return;
        }
        if (depth >= FLATTEN_DEPTH) {
            out.put(p, new Leaf("object", "<" + simpleName(v.getClass()) + ">"));
            return;
        }
        seen.put(v, Boolean.TRUE);
        try {
            if (v instanceof Optional) {
                Optional<?> o = (Optional<?>) v;
                if (o.isPresent()) {
                    walk(o.get(), p, depth + 1, out, seen);
                } else {
                    out.put(p, new Leaf("value", "Optional.empty"));
                }
            } else if (v instanceof Map && plainCollection(v)) {
                Map<?, ?> m = (Map<?, ?>) v;
                if (m.isEmpty()) {
                    out.put(p, new Leaf("object", "{}"));
                    return;
                }
                int i = 0;
                for (Map.Entry<?, ?> e : m.entrySet()) {
                    if (i++ >= 24) {
                        break;
                    }
                    String k = e.getKey() == null ? "null" : keyText(e.getKey());
                    walk(e.getValue(), p.isEmpty() ? k : p + "." + k, depth + 1, out, seen);
                }
            } else if (sequence(v)) {
                out.put(p + ".length", new Leaf("number", length(v)));
                Object[] items = head(v, 8);
                for (int i = 0; i < items.length; i++) {
                    walk(items[i], p + "[" + i + "]", depth + 1, out, seen);
                }
            } else if (v instanceof Collection && plainCollection(v)) {
                out.put(p + ".size", new Leaf("number", ((Collection<?>) v).size()));
            } else {
                Field[] fields = fieldsOf(v.getClass());
                if (fields.length == 0) {
                    out.put(p, new Leaf("object", "<" + simpleName(v.getClass()) + ">"));
                    return;
                }
                for (int i = 0; i < fields.length && i < 24; i++) {
                    String k = fields[i].getName();
                    walk(get(fields[i], v), p.isEmpty() ? k : p + "." + k, depth + 1, out, seen);
                }
            }
        } finally {
            seen.remove(v);
        }
    }

    /** Bounded, side-effect-free rendering. */
    static String preview(Object v) {
        String s;
        try {
            s = preview(v, 0);
        } catch (Throwable t) {
            s = "<" + (v == null ? "null" : simpleName(v.getClass())) + ">";
        }
        return s.length() <= PREVIEW_MAX ? s : s.substring(0, PREVIEW_MAX - 1) + "…";
    }

    private static String preview(Object v, int depth) {
        Leaf l = leaf(v);
        if (l != null) {
            return display(l);
        }
        if (depth >= 3) {
            return "<" + simpleName(v.getClass()) + ">";
        }
        StringBuilder b = new StringBuilder();
        if (v instanceof Optional) {
            Optional<?> o = (Optional<?>) v;
            return o.isPresent() ? preview(o.get(), depth) : "Optional.empty";
        }
        if (v instanceof Map && plainCollection(v)) {
            Map<?, ?> m = (Map<?, ?>) v;
            b.append('{');
            int i = 0;
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (i >= 8) {
                    break;
                }
                if (i++ > 0) {
                    b.append(", ");
                }
                Object k = e.getKey();
                b.append(k instanceof String ? Json.quote((String) k) : k == null ? "null" : keyText(k));
                b.append(": ").append(preview(e.getValue(), depth + 1));
            }
            return b.append(m.size() > 8 ? ", …}" : "}").toString();
        }
        if (sequence(v) || (v instanceof Collection && plainCollection(v))) {
            int size;
            List<Object> items = new ArrayList<Object>();
            if (sequence(v)) {
                size = length(v);
                for (Object o : head(v, 8)) {
                    items.add(o);
                }
            } else {
                size = ((Collection<?>) v).size();
                for (Object o : (Collection<?>) v) {
                    if (items.size() >= 8) {
                        break;
                    }
                    items.add(o);
                }
            }
            b.append('[');
            for (int i = 0; i < items.size(); i++) {
                if (i > 0) {
                    b.append(", ");
                }
                b.append(preview(items.get(i), depth + 1));
            }
            return b.append(size > 8 ? ", …]" : "]").toString();
        }
        Field[] fields = fieldsOf(v.getClass());
        b.append(simpleName(v.getClass())).append('(');
        for (int i = 0; i < fields.length && i < 8; i++) {
            if (i > 0) {
                b.append(", ");
            }
            b.append(fields[i].getName()).append('=').append(preview(get(fields[i], v), depth + 1));
        }
        return b.append(')').toString();
    }

    static String outcomeShape(String returned) {
        if (returned == null || returned.equals("null") || returned.equals("void")) {
            return "none";
        }
        char c = returned.isEmpty() ? ' ' : returned.charAt(0);
        if (c == '{') {
            return "dict";
        }
        if (c == '[') {
            return "sequence";
        }
        if (c == '"') {
            return "string";
        }
        if (returned.equals("true") || returned.equals("false")) {
            return "bool:" + returned;
        }
        try {
            Double.parseDouble(returned);
            return "number";
        } catch (NumberFormatException e) {
            int paren = returned.indexOf('(');
            String head = paren >= 0 ? returned.substring(0, paren) : returned;
            return "object:" + (head.length() <= 40 ? head : head.substring(0, 40));
        }
    }

    /** Objects reachable from a value, each with its own leaf fields. */
    static void collectNodes(Object root, String prefix, List<Node> nodes) {
        try {
            nodes(root, prefix, 0, nodes, new IdentityHashMap<Object, Boolean>());
        } catch (Throwable t) {
            // keep what was read
        }
    }

    private static void nodes(Object v, String p, int depth, List<Node> nodes, IdentityHashMap<Object, Boolean> seen) {
        if (nodes.size() >= MAX_NODES || depth > NODE_DEPTH || leaf(v) != null || seen.containsKey(v)) {
            return;
        }
        seen.put(v, Boolean.TRUE);
        LinkedHashMap<String, String> fields = new LinkedHashMap<String, String>();
        List<Object[]> items = new ArrayList<Object[]>();
        if (v instanceof Optional) {
            Optional<?> o = (Optional<?>) v;
            if (o.isPresent()) {
                nodes(o.get(), p, depth + 1, nodes, seen);
            }
            return;
        } else if (v instanceof Map && plainCollection(v)) {
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (items.size() >= NODE_FIELDS) {
                    break;
                }
                items.add(new Object[] {e.getKey() == null ? "null" : keyText(e.getKey()), e.getValue()});
            }
        } else if (sequence(v)) {
            fields.put("len", String.valueOf(length(v)));
            Object[] head = head(v, 8);
            for (int i = 0; i < head.length; i++) {
                items.add(new Object[] {"[" + i + "]", head[i]});
            }
        } else if (v instanceof Collection && plainCollection(v)) {
            fields.put("len", String.valueOf(((Collection<?>) v).size()));
        } else {
            Field[] fs = fieldsOf(v.getClass());
            for (int i = 0; i < fs.length && i < NODE_FIELDS; i++) {
                items.add(new Object[] {fs[i].getName(), get(fs[i], v)});
            }
        }
        List<Object[]> children = new ArrayList<Object[]>();
        for (Object[] item : items) {
            String key = (String) item[0];
            Leaf l = leaf(item[1]);
            if (l != null) {
                fields.put(key, display(l));
            } else {
                children.add(new Object[] {p + (key.startsWith("[") ? "" : ".") + key, item[1]});
            }
        }
        if (!fields.isEmpty()) {
            nodes.add(new Node(v, p, fields));
        }
        for (Object[] child : children) {
            nodes((Object) child[1], (String) child[0], depth + 1, nodes, seen);
        }
    }
}

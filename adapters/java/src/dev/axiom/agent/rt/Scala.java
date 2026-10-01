package dev.axiom.agent.rt;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;

/**
 * Scala's collections do not implement java.util's, so read as plain objects
 * they would show their internals (a hash table's buckets, a list's cons
 * cells). This reads the strict ones through Scala's own iterator interface
 * into a bounded java.util copy the rest of the recorder understands.
 *
 * It calls only the Scala library, never the program. Lazy collections
 * (LazyList, Stream, views, iterators) are not touched: reading one would
 * run the program's code and could change what it does.
 */
final class Scala {
    private Scala() {}

    static final int KEEP = 64;

    /** A copied head of a longer sequence that still reports the real length. */
    static final class Seq extends ArrayList<Object> {
        int total;

        @Override
        public int size() {
            return total;
        }
    }

    static final class Dict extends LinkedHashMap<Object, Object> {
        int total;

        @Override
        public int size() {
            return total;
        }
    }

    private static final class Handles {
        Class<?> iterable, map, iterator, tuple;
        Method iteratorOf, hasNext, next, size, first, second;
    }

    private static volatile Handles handles;
    private static volatile ClassLoader failedFor;

    static boolean lazy(Object v) {
        String n = v.getClass().getName();
        return n.startsWith("scala.collection.") && (n.contains("LazyList") || n.contains("Stream") || n.contains("View") || n.contains("Iterator"));
    }

    private static Handles handles(ClassLoader loader) {
        Handles h = handles;
        if (h != null || loader == failedFor) {
            return h;
        }
        try {
            h = new Handles();
            h.iterable = Class.forName("scala.collection.Iterable", false, loader);
            h.map = Class.forName("scala.collection.Map", false, loader);
            h.iterator = Class.forName("scala.collection.Iterator", false, loader);
            h.tuple = Class.forName("scala.Tuple2", false, loader);
            h.iteratorOf = h.iterable.getMethod("iterator");
            h.size = h.iterable.getMethod("size");
            h.hasNext = h.iterator.getMethod("hasNext");
            h.next = h.iterator.getMethod("next");
            h.first = h.tuple.getMethod("_1");
            h.second = h.tuple.getMethod("_2");
            handles = h;
            return h;
        } catch (Throwable t) {
            failedFor = loader;
            return null;
        }
    }

    /** A Seq or Dict holding the head of a strict Scala collection, or null when v is not one. */
    static Object contents(Object v) {
        String n = v.getClass().getName();
        if (!n.startsWith("scala.collection.") || lazy(v)) {
            return null;
        }
        try {
            Handles h = handles(v.getClass().getClassLoader());
            if (h == null || !h.iterable.isInstance(v)) {
                return null;
            }
            int total = (Integer) h.size.invoke(v);
            Object it = h.iteratorOf.invoke(v);
            if (h.map.isInstance(v)) {
                Dict out = new Dict();
                out.total = total;
                for (int i = 0; i < KEEP && (Boolean) h.hasNext.invoke(it); i++) {
                    Object entry = h.next.invoke(it);
                    out.put(h.first.invoke(entry), h.second.invoke(entry));
                }
                return out;
            }
            Seq out = new Seq();
            out.total = total;
            for (int i = 0; i < KEEP && (Boolean) h.hasNext.invoke(it); i++) {
                out.add(h.next.invoke(it));
            }
            return out;
        } catch (Throwable t) {
            return null;
        }
    }
}

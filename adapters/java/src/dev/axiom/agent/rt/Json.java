package dev.axiom.agent.rt;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** The little JSON the recorder needs: writing strings, reading AXIOM_WATCHES. */
final class Json {
    private Json() {}

    static String quote(String s) {
        StringBuilder b = new StringBuilder(s.length() + 2);
        str(b, s);
        return b.toString();
    }

    static void str(StringBuilder b, String s) {
        if (s == null) {
            b.append("null");
            return;
        }
        b.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        b.append(String.format("\\u%04x", (int) c));
                    } else {
                        b.append(c);
                    }
            }
        }
        b.append('"');
    }

    static void num(StringBuilder b, double d) {
        if (d == Math.rint(d) && Math.abs(d) < 9.0e15) {
            b.append((long) d);
        } else if (Double.isNaN(d) || Double.isInfinite(d)) {
            b.append("null");
        } else {
            b.append(d);
        }
    }

    /** Parses objects, arrays, strings, numbers, booleans and null. */
    static Object parse(String text) {
        try {
            return new Json.Reader(text).value();
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static final class Reader {
        private final String s;
        private int i;

        Reader(String s) {
            this.s = s;
        }

        private void ws() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) {
                i++;
            }
        }

        Object value() {
            ws();
            char c = s.charAt(i);
            if (c == '{') {
                i++;
                Map<String, Object> m = new LinkedHashMap<String, Object>();
                ws();
                if (s.charAt(i) == '}') {
                    i++;
                    return m;
                }
                while (true) {
                    ws();
                    String k = string();
                    ws();
                    i++; // :
                    m.put(k, value());
                    ws();
                    if (s.charAt(i++) == '}') {
                        return m;
                    }
                }
            }
            if (c == '[') {
                i++;
                List<Object> l = new ArrayList<Object>();
                ws();
                if (s.charAt(i) == ']') {
                    i++;
                    return l;
                }
                while (true) {
                    l.add(value());
                    ws();
                    if (s.charAt(i++) == ']') {
                        return l;
                    }
                }
            }
            if (c == '"') {
                return string();
            }
            if (s.startsWith("true", i)) {
                i += 4;
                return Boolean.TRUE;
            }
            if (s.startsWith("false", i)) {
                i += 5;
                return Boolean.FALSE;
            }
            if (s.startsWith("null", i)) {
                i += 4;
                return null;
            }
            int start = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) {
                i++;
            }
            return Double.valueOf(s.substring(start, i));
        }

        private String string() {
            StringBuilder b = new StringBuilder();
            i++; // opening quote
            while (true) {
                char c = s.charAt(i++);
                if (c == '"') {
                    return b.toString();
                }
                if (c != '\\') {
                    b.append(c);
                    continue;
                }
                char e = s.charAt(i++);
                switch (e) {
                    case 'n': b.append('\n'); break;
                    case 't': b.append('\t'); break;
                    case 'r': b.append('\r'); break;
                    case 'b': b.append('\b'); break;
                    case 'f': b.append('\f'); break;
                    case 'u':
                        b.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                        i += 4;
                        break;
                    default: b.append(e);
                }
            }
        }
    }
}

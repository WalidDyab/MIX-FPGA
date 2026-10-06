using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;

namespace NexysVhdl.Launcher
{
    /// <summary>
    /// A small JSON reader/writer (objects, arrays, strings, numbers, true/false/null)
    /// so the launcher has no dependency beyond the base class library.
    /// Objects are Dictionary&lt;string, object&gt;, arrays are List&lt;object&gt;.
    /// </summary>
    public static class Json
    {
        public static object Parse(string text)
        {
            int i = 0;
            object v = ReadValue(text, ref i);
            SkipSpace(text, ref i);
            if (i != text.Length) throw new FormatException("unexpected text after the JSON value");
            return v;
        }

        /// <summary>Parses, returning null instead of throwing.</summary>
        public static object TryParse(string text)
        {
            try { return Parse(text); } catch (FormatException) { return null; }
        }

        static void SkipSpace(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n' || s[i] == '﻿')) i++;
        }

        static object ReadValue(string s, ref int i)
        {
            SkipSpace(s, ref i);
            if (i >= s.Length) throw new FormatException("unexpected end");
            char c = s[i];
            if (c == '{')
            {
                Dictionary<string, object> o = new Dictionary<string, object>();
                i++;
                SkipSpace(s, ref i);
                if (i < s.Length && s[i] == '}') { i++; return o; }
                for (;;)
                {
                    SkipSpace(s, ref i);
                    if (i >= s.Length || s[i] != '"') throw new FormatException("object key expected");
                    string key = ReadString(s, ref i);
                    SkipSpace(s, ref i);
                    if (i >= s.Length || s[i] != ':') throw new FormatException("':' expected");
                    i++;
                    o[key] = ReadValue(s, ref i);
                    SkipSpace(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    if (i < s.Length && s[i] == '}') { i++; return o; }
                    throw new FormatException("',' or '}' expected");
                }
            }
            if (c == '[')
            {
                List<object> a = new List<object>();
                i++;
                SkipSpace(s, ref i);
                if (i < s.Length && s[i] == ']') { i++; return a; }
                for (;;)
                {
                    a.Add(ReadValue(s, ref i));
                    SkipSpace(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    if (i < s.Length && s[i] == ']') { i++; return a; }
                    throw new FormatException("',' or ']' expected");
                }
            }
            if (c == '"') return ReadString(s, ref i);
            if (Literal(s, ref i, "true")) return true;
            if (Literal(s, ref i, "false")) return false;
            if (Literal(s, ref i, "null")) return null;
            int start = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            if (start == i) throw new FormatException("value expected");
            return double.Parse(s.Substring(start, i - start), System.Globalization.CultureInfo.InvariantCulture);
        }

        static bool Literal(string s, ref int i, string word)
        {
            if (string.CompareOrdinal(s, i, word, 0, word.Length) != 0) return false;
            i += word.Length;
            return true;
        }

        static string ReadString(string s, ref int i)
        {
            StringBuilder b = new StringBuilder();
            i++; // opening quote
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') return b.ToString();
                if (c != '\\') { b.Append(c); continue; }
                if (i >= s.Length) break;
                char e = s[i++];
                switch (e)
                {
                    case 'n': b.Append('\n'); break;
                    case 'r': b.Append('\r'); break;
                    case 't': b.Append('\t'); break;
                    case 'b': b.Append('\b'); break;
                    case 'f': b.Append('\f'); break;
                    case 'u':
                        if (i + 4 > s.Length) throw new FormatException("bad \\u escape");
                        b.Append((char)Convert.ToInt32(s.Substring(i, 4), 16));
                        i += 4;
                        break;
                    default: b.Append(e); break;
                }
            }
            throw new FormatException("unterminated string");
        }

        public static string Write(object value)
        {
            StringBuilder b = new StringBuilder();
            Write(b, value, 0);
            return b.ToString();
        }

        static void Indent(StringBuilder b, int level) { b.Append('\n'); b.Append(' ', level * 2); }

        static void Write(StringBuilder b, object v, int level)
        {
            if (v == null) { b.Append("null"); return; }
            if (v is bool) { b.Append((bool)v ? "true" : "false"); return; }
            if (v is string) { WriteString(b, (string)v); return; }
            if (v is int || v is long || v is double)
            {
                b.Append(Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture));
                return;
            }
            IDictionary d = v as IDictionary;
            if (d != null)
            {
                if (d.Count == 0) { b.Append("{}"); return; }
                b.Append('{');
                bool first = true;
                foreach (DictionaryEntry e in d)
                {
                    if (!first) b.Append(',');
                    first = false;
                    Indent(b, level + 1);
                    WriteString(b, (string)e.Key);
                    b.Append(": ");
                    Write(b, e.Value, level + 1);
                }
                Indent(b, level);
                b.Append('}');
                return;
            }
            IEnumerable list = v as IEnumerable;
            if (list != null)
            {
                bool any = false;
                foreach (object x in list) { any = true; break; }
                if (!any) { b.Append("[]"); return; }
                b.Append('[');
                bool first = true;
                foreach (object x in list)
                {
                    if (!first) b.Append(',');
                    first = false;
                    Indent(b, level + 1);
                    Write(b, x, level + 1);
                }
                Indent(b, level);
                b.Append(']');
                return;
            }
            WriteString(b, v.ToString());
        }

        static void WriteString(StringBuilder b, string s)
        {
            b.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': b.Append("\\\""); break;
                    case '\\': b.Append("\\\\"); break;
                    case '\n': b.Append("\\n"); break;
                    case '\r': b.Append("\\r"); break;
                    case '\t': b.Append("\\t"); break;
                    default:
                        if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
                        else b.Append(c);
                        break;
                }
            }
            b.Append('"');
        }
    }
}

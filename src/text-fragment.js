// parseDecorated(text, colorsMap, sourceLine) -> TextFragment[]
//
// Reads a string with inline decorator codes and returns an array of
// TextFragment objects. A TextFragment is a small object that
// describes one chunk of the rendered output. Three kinds:
//
//   { kind: 'text',     text, style? }   plain text with optional style
//   { kind: 'binding',  path, style? }   {path} placeholder
//   { kind: 'function', name, style? }   {@fnName} placeholder
//
// Style is replaced (not merged) on each backtick span. So a string
// like  `b`bold text`i`italic text  starts a bold region, then a
// new backtick span replaces the active style with italic. The two
// regions do not stack: the second span is italic only, not bold and
// italic together. There's no nesting; each span declares the full
// active style on its own.
//
// Codes that can appear inside the backticks:
//
//   b  bold      i  italic     u  underline    s  strike-through
//   +  size +1   -  size -1    r  reset (also empty `` ``)
//   #RGB / #RRGGBB              foreground hex color
//   bg#RGB / bg#RRGGBB          background hex color
//   :name                       foreground named color (looked up in colorsMap)
//   bg:name                     background named color (looked up in colorsMap)
//
// Codes can run together; whitespace and commas between codes are
// ignored.
//
// Inline {path} and {@functionName} placeholders are extracted as
// binding or function fragments with the currently-active style
// attached.

import { ParseError, ERR } from './tuple-response.js';
import { isReservedObjectKey } from './safe-keys.js';
import { resolvePlaceholder } from './placeholder.js';

const HEX_RX  = /^#(?<hex>[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})/;
const NAME_RX = /^[A-Za-z_][A-Za-z0-9_-]*/;
// Each path segment must be a non-empty identifier. Single dots
// separate segments. So `customer.name` and `a.b.c` work; `a..b`,
// `foo.`, and a leading dot do not. The `(?!\.)` at the end says
// "and the next character must NOT be a dot" — without it, a
// trailing dot like `foo.` would match `foo` and silently leave
// the dot for the next parse step to choke on.
const PATH_RX = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?!\.)/;

/**
 * @param {string | null | undefined} text
 * @param {Record<string, string>} [colorsMap]
 * @param {number} [sourceLine] defaults to 0 when omitted. Pass the
 *        real source line so any {@link ParseError} this function
 *        throws can point back to the DSL text by line and column.
 *        Passing 0 (or omitting it) suppresses location info in
 *        `ParseError.toMessage()`.
 * @throws {ParseError} on a malformed decorator span, an unterminated
 *         backtick, or a binding/function placeholder that doesn't close.
 */
export function parseDecorated(text, colorsMap = {}, sourceLine = 0) {
    if (text == null || text === '') return [];

    const fragments = [];
    let style = {};
    let buffer = '';
    let pos = 0;

    const flushText = () => {
        if (buffer.length === 0) return;
        const f = { kind: 'text', text: buffer };
        if (Object.keys(style).length > 0) f.style = { ...style };
        fragments.push(f);
        buffer = '';
    };

    const fail = (code, message) => {
        throw new ParseError(code, message, sourceLine, 0);
    };

    while (pos < text.length) {
        const ch = text[pos];

        // Backslash escapes inside the running text. Six cases:
        //   \\   one literal backslash
        //   \`   one literal backtick (so the next char doesn't open
        //        a decorator span)
        //   \[   one literal `[`  (label text reserves bare `[` for
        //        a new declaration; this lets a label include `[1]`
        //        without confusing the parser)
        //   \]   one literal `]`  (symmetric with `\[`)
        //   \{   one literal `{`  (label text reserves `{` for an
        //        inline binding placeholder; this lets a label
        //        include a literal `{x}` without the parser trying
        //        to read x as a binding identifier)
        //   \}   one literal `}`  (symmetric with `\{`)
        // Any other `\x` sequence passes through as the two characters
        // it already is. This matches the outer DSL string-literal
        // grammar so authors learn one rule for backslash handling
        // across the whole document.
        if (ch === '\\' && text[pos + 1] === '\\') {
            buffer += '\\';
            pos += 2;
            continue;
        }
        if (ch === '\\' && text[pos + 1] === '`') {
            buffer += '`';
            pos += 2;
            continue;
        }
        if (ch === '\\' && (text[pos + 1] === '[' || text[pos + 1] === ']'
                         || text[pos + 1] === '{' || text[pos + 1] === '}')) {
            buffer += text[pos + 1];
            pos += 2;
            continue;
        }

        // Decorator span
        if (ch === '`') {
            flushText();
            pos++;
            const codeStart = pos;
            while (pos < text.length && text[pos] !== '`') pos++;
            if (pos >= text.length) fail(ERR.PARSE_ERROR, 'Unterminated decorator backtick');
            const codes = text.slice(codeStart, pos).trim();
            pos++;
            style = applyCodes(codes, colorsMap, fail);
            continue;
        }

        // Inline binding or function placeholder
        if (ch === '{') {
            flushText();
            pos++;
            const isFn = text[pos] === '@';
            if (isFn) pos++;
            const m = text.slice(pos).match(PATH_RX);
            if (!m) fail(ERR.PARSE_ERROR, 'Malformed binding in text');
            const ident = m[0];
            pos += ident.length;
            if (text[pos] !== '}') fail(ERR.PARSE_ERROR, "Expected '}' to close binding");
            pos++;
            // `this` is reserved across the language. Mirror the
            // parser-side rule: a bare `{this}` binding has no
            // meaning (it names neither an object nor a primitive).
            // The dotted form `{this.field}` stays legal because
            // it names a field on the current item inside a
            // repeater scope. `{@this}` is also rejected (a
            // function registry keyed on `this` would be a typo).
            if (ident === 'this') {
                fail(ERR.PARSE_ERROR, isFn
                    ? "'@this' is not a valid function binding; 'this' is reserved"
                    : "'this' is reserved and cannot be a bare binding name; use 'this.field' inside a repeater for the current item's field");
            }
            // Prototype-walking names get the same screen the
            // parser-side identifier producers run. `{@constructor}`
            // and `{__proto__}` would be benign at read-time
            // (renderFragments / interpolate refuse via the
            // hasOwnProperty / resolveSafePath guards), but the
            // safety story is "one rule across all surfaces" and
            // skipping the parse-time screen here would break the
            // symmetry. Each segment of a dotted path is checked.
            for (const seg of ident.split('.')) {
                if (isReservedObjectKey(seg)) {
                    fail(ERR.PARSE_ERROR, isFn
                        ? `'@${ident}' contains reserved name '${seg}'; cannot be a function binding`
                        : `'{${ident}}' contains reserved name '${seg}'; cannot be a data binding`);
                }
            }
            const f = isFn
                ? { kind: 'function', name: ident }
                : { kind: 'binding',  path: ident };
            if (Object.keys(style).length > 0) f.style = { ...style };
            fragments.push(f);
            continue;
        }

        buffer += ch;
        pos++;
    }

    flushText();
    return fragments;
}

// The returned style object is treated as immutable by the caller:
// each fragment that captures the active style does `{ ...style }`
// (see the binding / function fragment branches above). A future
// edit that mutates the returned object after handing it off would
// silently change the style of every fragment that already captured
// the prior state. Don't mutate; return fresh.
function applyCodes(codes, colorsMap, fail) {
    if (codes === '' || codes === 'r') return {};

    let style = {};
    let pos = 0;

    while (pos < codes.length) {
        const c = codes[pos];

        if (c === ' ' || c === ',' || c === '\t') { pos++; continue; }

        if (c === 'b') {
            // Disambiguate 'b' (bold) from 'bg#...' / 'bg:...' (background)
            if (codes[pos + 1] === 'g') {
                pos += 2;
                pos = consumeColor(codes, pos, style, 'bg', colorsMap, fail);
                continue;
            }
            style.bold = true; pos++; continue;
        }
        if (c === 'i') { style.italic = true;        pos++; continue; }
        if (c === 'u') { style.underline = true;     pos++; continue; }
        if (c === 's') { style.strikethrough = true; pos++; continue; }
        if (c === '+') { style.sizeStep = (style.sizeStep ?? 0) + 1; pos++; continue; }
        if (c === '-') { style.sizeStep = (style.sizeStep ?? 0) - 1; pos++; continue; }
        if (c === 'r') {
            // 'r' resets the running style. Documented in the
            // header comment as both the lone "reset" form and a
            // mid-stream reset. So `b r i` reads as italic only:
            // bold is set, the r drops it, italic is then set.
            style = {};
            pos++; continue;
        }
        if (c === '#' || c === ':') {
            pos = consumeColor(codes, pos, style, 'fg', colorsMap, fail);
            continue;
        }
        fail(ERR.PARSE_ERROR, `Unknown decorator code '${c}' in '\`${codes}\`'`);
    }

    return style;
}

function consumeColor(codes, pos, style, role, colorsMap, fail) {
    if (codes[pos] === '#') {
        const m = codes.slice(pos).match(HEX_RX);
        if (!m) fail(ERR.PARSE_ERROR, `Bad hex color near '${codes.slice(pos)}'`);
        style[role] = { name: null, resolved: normalizeHex(m[0]) };
        return pos + m[0].length;
    }
    if (codes[pos] === ':') {
        pos++;
        const m = codes.slice(pos).match(NAME_RX);
        if (!m) fail(ERR.PARSE_ERROR, `Expected color name after ':'`);
        const name = m[0];
        // Unresolved names are passed through; the renderer / compiler
        // is responsible for mapping them to actual color values.
        // Own-property lookup only: a caller-supplied colorsMap
        // (parseDecorated is exported as a public helper) might
        // carry an unusual prototype, and the trust rule the rest
        // of the package follows is that we only read what we own.
        const resolved = Object.prototype.hasOwnProperty.call(colorsMap, name)
            ? colorsMap[name]
            : null;
        style[role] = { name, resolved };
        return pos + name.length;
    }
    fail(ERR.PARSE_ERROR, `Expected '#' or ':' for color, got '${codes[pos]}'`);
    // unreachable: `fail` always throws. Kept here so a static
    // analyser that follows the function signature sees a return
    // (or throw) on every path.
}

function normalizeHex(h) {
    let body = h.slice(1);
    if (body.length === 3) body = body.split('').map(c => c + c).join('');
    return '#' + body.toUpperCase();
}

// renderFragments(fragments, data, functions, opts)
// Helper for consumers that just want a flat string. Renderers can
// walk fragments themselves for structured output.
//
// Options:
//   mode:   'plain' (default). Flat text output.
//           'html'.            Emits a <span> per styled fragment.
//   strict: false (default). Missing bindings render as `{path}`,
//                            missing or throwing functions render as
//                            `{@name}`. Symmetric with interpolate().
//           true.             Throws on a missing binding, an unknown
//                            function, or a function that itself
//                            throws.
export function renderFragments(fragments, data = {}, functions = {}, opts = {}) {
    const mode = opts.mode ?? 'plain';
    const strict = opts.strict === true;
    if (mode === 'plain') {
        return fragments.map(f => fragmentToText(f, data, functions, strict)).join('');
    }
    if (mode === 'html') {
        return fragments.map(f => fragmentToHtml(f, data, functions, strict)).join('');
    }
    // Unknown mode lands as a ParseError (INVALID_PARAM) rather
    // than a generic Error so a consumer who passes a typo'd value
    // (e.g. `mode: 'plaintext'` instead of `'plain'`) sees the same
    // error envelope every other failure surface uses.
    throw new ParseError(
        ERR.INVALID_PARAM,
        `renderFragments: unknown mode '${mode}'; expected 'plain' or 'html'`,
        0, 0
    );
}

function fragmentToText(f, data, functions, strict) {
    if (f.kind === 'text')     return f.text;
    if (f.kind === 'binding') {
        // Same shared core as interpolate. Lenient miss renders the
        // literal `{path}` text; strict throws with the uniform
        // "missing data for {path}" message. The two helpers cannot
        // drift now that they share resolvePlaceholder.
        return resolvePlaceholder(
            { name: f.path, isFunction: false },
            { data, functions, strict, literalPlaceholder: () => `{${f.path}}` }
        );
    }
    if (f.kind === 'function') {
        return resolvePlaceholder(
            { name: f.name, isFunction: true },
            { data, functions, strict, literalPlaceholder: () => `{@${f.name}}` }
        );
    }
    return '';
}

function fragmentToHtml(f, data, functions, strict) {
    // Lenient mode renders an unresolved binding or function as the
    // literal `{path}` / `{@name}` text (the same string a sink
    // author wrote). The HTML pass escapes that string the same way
    // it escapes any other content, so an unresolved `{x}` in the
    // output reads as a literal `{x}` to the browser, not as a
    // start-of-template-tag. That keeps the lenient mode visually
    // honest in either output target.
    const inner = escapeHtml(fragmentToText(f, data, functions, strict));
    if (!f.style) return inner;
    const parts = [];
    if (f.style.bold)      parts.push('font-weight:bold');
    if (f.style.italic)    parts.push('font-style:italic');

    // CSS only allows one `text-decoration` value per declaration;
    // setting it twice (once for underline, once for line-through)
    // would cause the second to override the first. Combine the two
    // into a single space-separated value when both apply.
    const decorations = [];
    if (f.style.underline)     decorations.push('underline');
    if (f.style.strikethrough) decorations.push('line-through');
    if (decorations.length > 0) parts.push(`text-decoration:${decorations.join(' ')}`);

    if (typeof f.style.sizeStep === 'number' && f.style.sizeStep !== 0) {
        const em = (1 + 0.15 * f.style.sizeStep).toFixed(2);
        parts.push(`font-size:${em}em`);
    }
    if (f.style.fg?.resolved)  parts.push(`color:${f.style.fg.resolved}`);
    if (f.style.bg?.resolved)  parts.push(`background-color:${f.style.bg.resolved}`);
    return `<span style="${parts.join(';')}">${inner}</span>`;
}

function escapeHtml(s) {
    // Escape every metacharacter that would change parsing in any HTML
    // attribute or element-content context. The current caller uses
    // double-quoted attributes only, but escaping `'` keeps the helper
    // safe-by-default for any future caller that emits single-quoted
    // attributes (e.g. <span title='…'>).
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

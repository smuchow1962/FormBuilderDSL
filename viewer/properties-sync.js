// viewer/properties-sync.js — pure helpers for the viewer's auto-sync
// of the __properties block.
//
// Auto-sync's job is to keep the source's __properties block in step
// with what the parser actually sees: insert the block when it's
// missing, refresh it when controls add or rename a binding. What it
// must NOT do is rewrite a block that already parses to the same
// property dictionary just because the canonical text shape happens
// to differ from the user's typed shape.
//
// The classic case: an int-typed property with `default: "30"` (string
// literal). The parser coerces "30" to 30 (round-25 numeric-string
// default), so the canonical text comes back as `default: 30`. Without
// this gate, every Process pass would silently rewrite the user's
// "30" to 30 — the user reads that as their edit being "stale-reverted".
//
// The gate runs the source's existing block through the parser in
// isolation (a minimal columns + container stub). If the dict the
// block produces standalone equals the dict the canonical block
// would produce, the rewrite is suppressed. Any real divergence —
// missing key, init= override, structural change — falls through to
// the canonical rewrite as before.

import { TextFormBuilder, ERR } from '../src/index.js';

// Locate the __properties block in `source`. Returns { start, end,
// text } where start/end are character offsets bracketing the block
// (start at the keyword's column 0, end after the closing `]`'s
// trailing same-line whitespace), and text is the raw substring.
// Returns null when no block exists or the block is malformed
// (unterminated brackets, no `=`, no opening `[`).
//
// The walker handles the same three shapes the strip path handles:
//   - canonical multi-line `__properties = [\n  "name" = {...},\n]`
//   - single-line `__properties = ["name" = {...}]`
//   - empty `__properties = []`
// String literals (single or double-quoted, with backslash escapes)
// are skipped wholesale so a `]` inside a quoted default doesn't
// close the block early.
export function locatePropertiesBlock(source) {
    if (typeof source !== 'string' || source.length === 0) return null;

    const kw = '__properties';
    let kwIdx = -1;
    for (let i = 0; i < source.length; i++) {
        if (i > 0 && source[i - 1] !== '\n') continue;
        if (source.slice(i, i + kw.length) !== kw) continue;
        const after = source[i + kw.length];
        if (after !== ' ' && after !== '\t' && after !== '=') continue;
        kwIdx = i;
        break;
    }
    if (kwIdx === -1) return null;

    let p = kwIdx + kw.length;
    while (p < source.length && (source[p] === ' ' || source[p] === '\t')) p++;
    if (source[p] !== '=') return null;
    p++;
    while (p < source.length && (source[p] === ' ' || source[p] === '\t' || source[p] === '\n')) p++;
    if (source[p] !== '[') return null;
    p++;

    let depth = 1;
    while (p < source.length && depth > 0) {
        const c = source[p];
        if (c === '"' || c === "'") {
            const quote = c;
            p++;
            while (p < source.length && source[p] !== quote) {
                if (source[p] === '\\' && p + 1 < source.length) { p += 2; continue; }
                p++;
            }
            p++;
            continue;
        }
        if (c === '[') depth++;
        else if (c === ']') depth--;
        p++;
    }
    if (depth !== 0) return null;

    // Eat any trailing comment / whitespace on the closing line so
    // callers see one block boundary, not a half-line tail.
    while (p < source.length && source[p] !== '\n' && source[p] !== '\r') p++;

    return { start: kwIdx, end: p, text: source.slice(kwIdx, p) };
}

// True when the source's existing __properties block parses, in
// isolation, to a dictionary that equals `canonicalProps`. That's
// the precondition for skipping an auto-sync rewrite — the user's
// typed text already says exactly what the parser would emit, and
// the rewrite would only churn whitespace and literal-token shape.
//
// Returns false in every other case (no block, malformed block,
// parse error in the mini-doc, semantic difference). The caller
// treats false as "rewrite needed", so a defensive false on any
// edge case keeps the existing behaviour unchanged.
export function arePropertiesSemanticallyEqual(source, canonicalProps) {
    if (canonicalProps == null) return false;
    const loc = locatePropertiesBlock(source);
    if (!loc) return false;

    // Parse the block as a standalone document. The columns + empty
    // container stub keeps the parser happy; no controls means no
    // inferred properties get injected, so the resulting dict is
    // exactly what the user's block declared.
    const miniDoc = `columns: 1\n\n${loc.text}\n\n[container("X")]\n`;
    let result;
    try {
        result = new TextFormBuilder({ schemaText: miniDoc }).process();
    } catch {
        return false;
    }
    if (result.error !== ERR.OK) return false;

    return propertiesEqual(result.payload.__properties, canonicalProps);
}

// Stable deep-equal for the property dictionary. Object.keys ordering
// is insertion-order in JS, and the two parses may have visited keys
// in different orders, so a naive JSON.stringify comparison would
// false-negative on key-order differences. Sorting keys at every
// level normalises that out.
function propertiesEqual(a, b) {
    return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value) {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
    if (value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(sortKeys);
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
}

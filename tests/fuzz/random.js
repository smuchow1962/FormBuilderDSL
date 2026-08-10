// Deterministic fuzz harness — shared PRNG, corpus, and case runner.
//
// Every fuzz property in tests/fuzz/ draws from this file. Two rules keep
// the suite useful rather than merely noisy:
//
//   1. Fixed seeds. A fuzz run that can't be reproduced is a bug report
//      nobody can act on. Each property names its own seed constant, so a
//      failure is replayable by running the same file. New seeds are added
//      alongside old ones rather than rotating them, which keeps every
//      historical failure permanently in the suite.
//
//   2. Failures report the input. `forEachCase` catches, then rethrows with
//      the iteration number, the seed, and a printable form of the offending
//      input attached. Without that a red fuzz test tells you only that
//      something, somewhere, broke.
//
// No dependencies beyond Jest itself — the PRNG is a 4-line mulberry32.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

/**
 * mulberry32 — small, fast, well-distributed 32-bit PRNG. Same seed always
 * yields the same stream, which is the whole point here.
 */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Convenience wrapper over mulberry32 with the draws the generators need. */
export function makeRng(seed) {
    const next = mulberry32(seed);
    const int = (n) => Math.floor(next() * n);
    return {
        seed,
        next,
        int,
        /** Integer in [lo, hi]. */
        between: (lo, hi) => lo + int(hi - lo + 1),
        pick: (arr) => arr[int(arr.length)],
        bool: (p = 0.5) => next() < p,
        /** Draw `n` picks from `arr` and join them. */
        repeat: (n, fn) => {
            let out = '';
            for (let i = 0; i < n; i++) out += fn(i);
            return out;
        }
    };
}

// ─── Character pools ─────────────────────────────────────────────────────
//
// DSL_PUNCT is deliberately weighted toward the grammar's own delimiters:
// uniform random bytes almost never produce a `[` next to a `(`, so a purely
// random corpus would spend its whole budget in the tokenizer's first reject
// branch and never reach the parser's nesting and pairing logic.

export const DSL_PUNCT = '[](){}<>,:=->#|."\'\\*+/?!&%$@^~`;';
export const ASCII_PRINTABLE =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \t';

/** Codepoints chosen to poke at UTF-16 handling, not just Latin-1. */
export const UNICODE_SAMPLES = [
    '\u0000', '\u0001', '\u001b', '\u007f',  // control chars
    '\u00a0', '\u2028', '\u2029',            // exotic whitespace / line seps
    '\u200b', '\ufeff',                      // zero-width, BOM
    '\u00e9', '\u4e2d', '\u0416',            // multi-byte letters
    '\ud83d\ude00', '\ud83c\udff3',          // astral (surrogate pairs)
    '\ud800', '\udfff',                      // LONE surrogates — malformed UTF-16
    '\uffff', '\ufffd'
];

/** A random junk string mixing punctuation, ASCII, and unicode hazards. */
export function randomJunk(rng, maxLen = 200) {
    const len = rng.between(0, maxLen);
    return rng.repeat(len, () => {
        const roll = rng.next();
        if (roll < 0.45) return rng.pick(DSL_PUNCT);
        if (roll < 0.85) return rng.pick(ASCII_PRINTABLE);
        if (roll < 0.95) return rng.pick(UNICODE_SAMPLES);
        return '\n';
    });
}

// ─── Corpus ──────────────────────────────────────────────────────────────

/**
 * Every real .mmpform / .dsl source in the repo. Mutation fuzzing needs a
 * valid starting point: random bytes test the reject path, mutated-valid
 * input tests the far more interesting almost-right path.
 */
export function loadCorpus() {
    const sources = [];
    const fixture = join(repoRoot, 'tests', 'fixtures', 'full-example.dsl.txt');
    if (existsSync(fixture)) {
        sources.push({ name: 'fixtures/full-example.dsl.txt', text: readFileSync(fixture, 'utf8') });
    }
    const samples = join(repoRoot, 'editor', 'samples');
    if (existsSync(samples)) {
        for (const f of readdirSync(samples).filter((n) => n.endsWith('.mmpform')).sort()) {
            sources.push({ name: `editor/samples/${f}`, text: readFileSync(join(samples, f), 'utf8') });
        }
    }
    if (sources.length === 0) throw new Error('fuzz corpus is empty — fixtures missing');
    return sources;
}

// ─── Mutation operators ──────────────────────────────────────────────────

const KEYWORD_CORRUPTIONS = [
    ['columns', 'colunms'], ['container', 'contaner'], ['select', 'selct'],
    ['textfield', 'textfeild'], ['toggle', 'togle'], ['panels', 'panls'],
    ['when', 'wehn'], ['tooltips', 'tooltip'], ['number', 'numbr'],
    ['check', 'chek'], ['combo', 'cmbo'], ['label', 'lable']
];

/**
 * Apply one random structural edit to a source. Kept line-oriented on
 * purpose: the DSL is line-structured, so line-level damage lands in the
 * parser's recovery and position-reporting code rather than being rejected
 * by the tokenizer on character one.
 */
export function mutateOnce(rng, text) {
    const lines = text.split('\n');
    const op = rng.int(7);

    if (op === 0 && lines.length > 1) {                    // delete a line
        lines.splice(rng.int(lines.length), 1);
    } else if (op === 1 && lines.length > 0) {             // duplicate a line
        const i = rng.int(lines.length);
        lines.splice(i, 0, lines[i]);
    } else if (op === 2 && lines.length > 1) {             // swap two lines
        const i = rng.int(lines.length);
        const j = rng.int(lines.length);
        [lines[i], lines[j]] = [lines[j], lines[i]];
    } else if (op === 3) {                                  // corrupt a keyword
        const [from, to] = rng.pick(KEYWORD_CORRUPTIONS);
        return text.includes(from) ? text.replace(from, to) : text + '\n' + to;
    } else if (op === 4 && text.length > 0) {              // delete a char span
        const at = rng.int(text.length);
        const n = rng.between(1, 8);
        return text.slice(0, at) + text.slice(at + n);
    } else if (op === 5 && text.length > 0) {              // splice in junk
        const at = rng.int(text.length);
        return text.slice(0, at) + randomJunk(rng, 12) + text.slice(at);
    } else if (lines.length > 0) {                          // truncate
        return lines.slice(0, rng.int(lines.length)).join('\n');
    }
    return lines.join('\n');
}

/** Apply between 1 and `maxEdits` mutations. */
export function mutate(rng, text, maxEdits = 4) {
    let out = text;
    const n = rng.between(1, maxEdits);
    for (let i = 0; i < n; i++) out = mutateOnce(rng, out);
    return out;
}

// ─── Case runner ─────────────────────────────────────────────────────────

/** Short, escaped, length-capped rendering of an input for failure output. */
export function preview(value, max = 300) {
    // JSON.stringify returns undefined (not a string) for undefined, symbols,
    // and functions, and throws on a cyclic value — String() covers all four.
    let s;
    if (typeof value === 'string') {
        s = value;
    } else {
        try {
            s = JSON.stringify(value) ?? String(value);
        } catch {
            s = String(value);
        }
    }
    const shown = s.length > max ? `${s.slice(0, max)}… (${s.length} chars total)` : s;
    return JSON.stringify(shown);
}

/**
 * Run `body(input, i)` for each generated case. On the first failure, rethrow
 * with the seed, iteration, and input attached so the case is reproducible.
 */
export function forEachCase(seed, iterations, generate, body) {
    const rng = makeRng(seed);
    for (let i = 0; i < iterations; i++) {
        const input = generate(rng, i);
        try {
            body(input, i);
        } catch (err) {
            err.message =
                `fuzz failure [seed=${seed} iteration=${i}/${iterations}]\n` +
                `input: ${preview(input)}\n\n${err.message}`;
            throw err;
        }
    }
}

// ─── Prototype-pollution probe ───────────────────────────────────────────

/**
 * Snapshot the shared intrinsics a `__proto__` / `constructor` escape would
 * touch. Compared before and after a fuzz batch: any new key means untrusted
 * input reached a prototype.
 */
export function protoSnapshot() {
    return {
        object: Object.getOwnPropertyNames(Object.prototype).sort().join(','),
        array: Object.getOwnPropertyNames(Array.prototype).sort().join(','),
        string: Object.getOwnPropertyNames(String.prototype).sort().join(','),
        function: Object.getOwnPropertyNames(Function.prototype).sort().join(',')
    };
}

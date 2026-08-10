// Fuzz properties for interpolate() — placeholder substitution over
// host-supplied data and functions.
//
// interpolate shares safe-keys.js with the expression evaluator, so it shares
// the same trust boundary: a `{__proto__.x}` placeholder in label text must
// not become a prototype walk. It also owns a subtler hazard the evaluator
// does not: PLACEHOLDER is a module-level /g regex reused across calls, so a
// leaked lastIndex would make interpolation depend on call history. F-I5
// exists to catch precisely that.
//
//   F-I1  Random text + payloads return a string or a ParseError.
//   F-I2  Interpolation never mutates an intrinsic prototype.
//   F-I3  Non-strict throws only for a reserved segment; strict rejects only
//         with one of the five documented miss-case failures.
//   F-I5  Interpolation is history-independent (no leaked regex lastIndex).
//   F-I6  A throwing host function does not corrupt later calls.
//   F-I7  Interpolation never mutates the caller's data.
//
// Seeds are fixed; see tests/fuzz/random.js for why.

import assert from 'node:assert/strict';

import { interpolate } from '../../src/interpolate.js';
import { FORBIDDEN_PATH_SEGMENTS } from '../../src/expression.js';
import { ParseError } from '../../src/tuple-response.js';
import { forEachCase, makeRng, randomJunk, protoSnapshot, ASCII_PRINTABLE } from './random.js';
import { runUnderContract, THREW_PARSE_ERROR } from './contract.js';

const DATA = Object.freeze({
    name: 'Ada', count: 3, nested: Object.freeze({ deep: 'value' }), empty: '', zero: 0
});
const FUNCTIONS = Object.freeze({
    upper: (s) => String(s).toUpperCase(),
    boom: () => { throw new Error('host function exploded'); }
});

const PLACEHOLDER_NAMES = [
    'name', 'count', 'nested.deep', 'empty', 'zero', 'missing', 'a.b.c.d',
    '__proto__', 'constructor', 'prototype', '__proto__.polluted',
    'nested.__proto__.x', 'upper(name)', 'boom()', '', ' ', '{', '}'
];

// Strict mode's error contract is wider than ParseError, and deliberately so:
// src/placeholder.js documents five miss cases that throw a plain Error, one
// of which is rethrowing the host function's own error — which can be any type
// the host chose. So "strict threw" cannot be the whole assertion, or a genuine
// internal TypeError would pass unnoticed.
//
// Instead the failure must match one of the documented shapes. Anything else —
// "Cannot read properties of undefined", a RangeError from a runaway recursion —
// fails the property.
const DOCUMENTED_STRICT_FAILURES = [
    /^missing data for \{.*\}$/s,
    /^no function registered for \{@.*\}$/s,
    /^\{@.*\} returned null or undefined$/s,
    /^host function exploded$/   // FUNCTIONS.boom, rethrown verbatim
];

const THREW_EXPECTED = Symbol('threw a documented strict-mode failure');

function runStrict(text) {
    try {
        return interpolate(text, DATA, FUNCTIONS, { strict: true });
    } catch (err) {
        if (err instanceof ParseError) return THREW_EXPECTED;
        const message = err?.message ?? String(err);
        if (err instanceof Error && DOCUMENTED_STRICT_FAILURES.some((re) => re.test(message))) {
            return THREW_EXPECTED;
        }
        const kind = err?.constructor?.name ?? typeof err;
        throw new Error(
            `strict interpolation threw an undocumented ${kind}: ${message}\n` +
            `expected a ParseError or one of the five documented miss-case messages\n` +
            `${err?.stack ?? ''}`
        );
    }
}

/** Text with a realistic density of placeholders rather than uniform noise. */
function randomTemplate(rng) {
    return rng.repeat(rng.between(0, 14), () => {
        const roll = rng.next();
        if (roll < 0.45) return `{${rng.pick(PLACEHOLDER_NAMES)}}`;
        if (roll < 0.75) return rng.pick(ASCII_PRINTABLE);
        if (roll < 0.9) return rng.pick(['{', '}', '{{', '}}', '\\{', '{ ']);
        return randomJunk(rng, 8);
    });
}

// ─── F-I1 / F-I4: the return contract ────────────────────────────────────

test('F-I1 placeholder-dense text returns a string or throws ParseError (6000 cases)', () => {
    forEachCase(
        0x5eed_0301, 6000,
        (rng) => randomTemplate(rng),
        (input) => {
            const result = runUnderContract(() => interpolate(input, DATA, FUNCTIONS));
            if (result === THREW_PARSE_ERROR) return;
            assert.equal(typeof result, 'string',
                `interpolate must return a string, got ${typeof result}`);
        }
    );
});

test('F-I1b random junk returns a string or throws ParseError (5000 cases)', () => {
    forEachCase(
        0x5eed_0302, 5000,
        (rng) => randomJunk(rng, 150),
        (input) => {
            const result = runUnderContract(() => interpolate(input, DATA, FUNCTIONS));
            if (result === THREW_PARSE_ERROR) return;
            assert.equal(typeof result, 'string',
                `interpolate must return a string, got ${typeof result}`);
        }
    );
});

test('F-I1c non-string inputs coerce rather than crash', () => {
    for (const value of [null, undefined, 0, 1, true, false, {}, [], Symbol.iterator]) {
        // Symbols cannot be String()-coerced implicitly, so a throw is fine;
        // silently returning a non-string would not be.
        const result = runUnderContract(() => interpolate(value, DATA, FUNCTIONS));
        if (result === THREW_PARSE_ERROR) continue;
        assert.equal(typeof result, 'string',
            `interpolate should coerce ${String(value)} to a string result`);
    }
});

// ─── F-I2: the sandbox ───────────────────────────────────────────────────

test('F-I2 hazardous placeholders never mutate an intrinsic prototype', () => {
    const before = protoSnapshot();
    const rng = makeRng(0x5eed_0303);

    const HAZARDS = [
        '{__proto__}', '{__proto__.polluted}', '{constructor}',
        '{constructor.prototype.polluted}', '{nested.__proto__.polluted}',
        '{nested.constructor.name}', '{__defineGetter__}', '{toString}',
        '{a.__proto__.__proto__.x}', '{prototype.polluted}'
    ];

    for (let i = 0; i < 4000; i++) {
        const text = rng.repeat(rng.between(1, 4), () => rng.pick(HAZARDS)) + randomTemplate(rng);
        const strict = rng.bool(0.5);
        try {
            interpolate(text, DATA, FUNCTIONS, { strict });
        } catch { /* rejection is acceptable */ }
    }

    assert.deepEqual(protoSnapshot(), before,
        'interpolation must not add properties to any intrinsic prototype');
    assert.equal(({}).polluted, undefined, 'Object.prototype.polluted must not exist');
});

// ─── F-I3: strict mode ───────────────────────────────────────────────────

test('F-I3 non-strict interpolation throws only for a reserved segment (5000 cases)', () => {
    // Non-strict mode is "total except for the security rule". The reserved-key
    // pre-scan in interpolate() is deliberately unconditional — a
    // `{__proto__.x}` placeholder is refused whether or not the caller asked
    // for strict mode, because that one is a trust-boundary violation rather
    // than a missing-value convenience.
    //
    // So the property is not "non-strict never throws". It is the sharper
    // claim: if non-strict throws, a reserved segment must actually appear in
    // the input. That would fail if some unrelated malformed placeholder ever
    // started throwing on the lenient path.
    const RESERVED = [...FORBIDDEN_PATH_SEGMENTS];

    forEachCase(
        0x5eed_0304, 5000,
        (rng) => randomTemplate(rng),
        (input) => {
            const lenient = runUnderContract(() => interpolate(input, DATA, FUNCTIONS, { strict: false }));
            if (lenient === THREW_PARSE_ERROR) {
                assert.ok(RESERVED.some((seg) => input.includes(seg)),
                    'non-strict interpolation should only reject input carrying a reserved segment');
            } else {
                assert.equal(typeof lenient, 'string', 'non-strict otherwise returns a string');
            }

            // Strict mode may reject strictly more inputs, never fewer. When it
            // does reject, the failure must be one of the five documented miss
            // cases — not an internal crash.
            const strictResult = runStrict(input);
            if (strictResult === THREW_EXPECTED) return;
            assert.equal(typeof strictResult, 'string', 'a successful strict run returns a string');
            assert.notEqual(lenient, THREW_PARSE_ERROR,
                'strict mode must not succeed on input the lenient path rejected');
        }
    );
});

// ─── F-I5: no cross-call state ───────────────────────────────────────────

test('F-I5 interpolation is history-independent (3000 cases)', () => {
    // PLACEHOLDER is a module-level /g regex. If any path leaves lastIndex
    // non-zero, the NEXT call silently skips placeholders before that offset.
    // Interleaving a throwing call between two identical calls is the shape
    // that exposes it.
    const rng = makeRng(0x5eed_0305);

    for (let i = 0; i < 3000; i++) {
        const text = randomTemplate(rng);
        const first = runUnderContract(() => interpolate(text, DATA, FUNCTIONS));

        // Perturb global state: a strict rejection and a throwing host function.
        try { interpolate('{definitely.missing.path}', DATA, FUNCTIONS, { strict: true }); } catch { /* expected */ }
        try { interpolate('{boom()}', DATA, FUNCTIONS); } catch { /* expected */ }

        const second = runUnderContract(() => interpolate(text, DATA, FUNCTIONS));
        assert.deepEqual(second, first,
            `interpolation of ${JSON.stringify(text.slice(0, 120))} changed after an ` +
            `intervening failed call — module-level regex state is leaking between calls`);
    }
});

// ─── F-I6: a throwing host function is contained ─────────────────────────

test('F-I6 a throwing host function does not corrupt later interpolations', () => {
    const control = interpolate('{name} has {count}', DATA, FUNCTIONS);
    for (let i = 0; i < 500; i++) {
        try { interpolate('{boom()}', DATA, FUNCTIONS); } catch { /* expected */ }
    }
    assert.equal(interpolate('{name} has {count}', DATA, FUNCTIONS), control,
        'a host function that throws must not change what later calls produce');
});

// ─── F-I7: read-only over caller data ────────────────────────────────────

test('F-I7 interpolation never mutates the caller data (4000 cases)', () => {
    forEachCase(
        0x5eed_0306, 4000,
        (rng) => ({ text: randomTemplate(rng), strict: rng.bool(0.5) }),
        ({ text, strict }) => {
            const data = { name: 'Ada', count: 3, nested: { deep: 'value' }, empty: '', zero: 0 };
            const before = JSON.stringify(data);
            try { interpolate(text, data, FUNCTIONS, { strict }); } catch { /* rejection is acceptable */ }
            assert.equal(JSON.stringify(data), before,
                'interpolate must treat the data object as read-only');
        }
    );
});

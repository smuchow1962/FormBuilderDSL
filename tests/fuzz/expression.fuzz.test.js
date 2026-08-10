// Fuzz properties for the `when=` expression evaluator.
//
// This is the library's sharpest trust boundary. `when=` source is authored
// in a .mmpform file, which in a multi-tenant host is data, not code — the
// evaluator's whole job is to compute a boolean from it without ever
// becoming an execution vector. docs/expression-trust.md sets out the threat
// model; these properties fuzz it.
//
//   F-E1  Random expression text yields a boolean or a ParseError, nothing else.
//   F-E2  Evaluation never mutates any intrinsic prototype.
//   F-E3  Reserved path segments are rejected however they are spelled.
//   F-E4  The evaluator never reads a real property off a prototype chain.
//   F-E5  Source-length and token caps hold under adversarial input.
//   F-E6  Evaluation never mutates the caller's data object.
//   F-E7  parseWhen / evaluateAst agree with evaluateWhen.
//
// Seeds are fixed; see tests/fuzz/random.js for why.

import assert from 'node:assert/strict';

import {
    evaluateWhen, parseWhen, evaluateAst,
    FORBIDDEN_PATH_SEGMENTS,
    DEFAULT_MAX_WHEN_SOURCE_LENGTH, DEFAULT_MAX_WHEN_TOKENS
} from '../../src/expression.js';
import { forEachCase, makeRng, randomJunk, protoSnapshot, preview } from './random.js';
import { runUnderContract, THREW_PARSE_ERROR } from './contract.js';

const IDENTS = ['a', 'b', 'flag', 'nonDomestic', 'highExposure', 'x.y', 'deep.a.b.c', 'missing'];
const OPERATORS = ['&&', '||', '==', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/'];
const LITERALS = ['0', '1', '42', '-1', '1e308', '"s"', "'t'", 'true', 'false', 'null', '0.5'];

const DATA = Object.freeze({
    a: 1, b: 0, flag: true, nonDomestic: false, highExposure: true,
    x: Object.freeze({ y: 'yes' }),
    deep: Object.freeze({ a: Object.freeze({ b: Object.freeze({ c: 7 }) }) })
});

/** Build a plausible-looking expression from the grammar's own vocabulary. */
function randomExpression(rng, depth = 0) {
    if (depth > 3 || rng.bool(0.35)) {
        return rng.bool(0.5) ? rng.pick(IDENTS) : rng.pick(LITERALS);
    }
    const left = randomExpression(rng, depth + 1);
    const right = randomExpression(rng, depth + 1);
    const op = rng.pick(OPERATORS);
    const joined = `${left} ${op} ${right}`;
    if (rng.bool(0.3)) return `(${joined})`;
    if (rng.bool(0.15)) return `!${joined}`;
    return joined;
}

// ─── F-E1: the return contract ───────────────────────────────────────────

test('F-E1 grammar-shaped expressions return a boolean or throw ParseError (6000 cases)', () => {
    forEachCase(
        0x5eed_0201, 6000,
        (rng) => randomExpression(rng),
        (input) => {
            const result = runUnderContract(() => evaluateWhen(input, DATA));
            if (result === THREW_PARSE_ERROR) return;
            assert.equal(typeof result, 'boolean',
                `evaluateWhen must return a boolean, got ${typeof result}`);
        }
    );
});

test('F-E1b random junk returns a boolean or throws ParseError (5000 cases)', () => {
    forEachCase(
        0x5eed_0202, 5000,
        (rng) => randomJunk(rng, 120),
        (input) => {
            const result = runUnderContract(() => evaluateWhen(input, DATA));
            if (result === THREW_PARSE_ERROR) return;
            assert.equal(typeof result, 'boolean',
                `evaluateWhen must return a boolean, got ${typeof result}`);
        }
    );
});

test('F-E1c a non-string or empty source means "always render"', () => {
    for (const source of [null, undefined, '', '   ', '\t\n']) {
        assert.equal(evaluateWhen(source, DATA), true,
            `an absent condition should read as always-true, source=${preview(source)}`);
    }
});

// ─── F-E2 / F-E3 / F-E4: the sandbox ─────────────────────────────────────

test('F-E2 evaluating hazardous expressions never mutates an intrinsic prototype', () => {
    const before = protoSnapshot();
    const rng = makeRng(0x5eed_0203);

    // Payloads a real attacker would reach for, plus fuzzed spellings.
    const TEMPLATES = [
        '__proto__.polluted == 1',
        'constructor.constructor("return 1")()',
        'a.constructor.prototype.polluted == 1',
        'x.__proto__.polluted',
        'x.constructor.name == "Object"',
        '__defineGetter__ == 1',
        'a.__proto__.__proto__.polluted',
        'toString.constructor("return process")()',
        'a["__proto__"]["polluted"]',
        'valueOf.constructor == 1'
    ];

    for (let i = 0; i < 4000; i++) {
        const source = rng.bool(0.6)
            ? rng.pick(TEMPLATES)
            : `${rng.pick(TEMPLATES)} ${rng.pick(['&&', '||'])} ${randomExpression(rng)}`;
        // The outcome does not matter here; only that nothing leaks. A throw
        // is a perfectly good answer, so it is swallowed rather than asserted.
        try { evaluateWhen(source, DATA); } catch { /* rejection is acceptable */ }
    }

    assert.deepEqual(protoSnapshot(), before,
        'expression evaluation must not add properties to any intrinsic prototype');
    assert.equal(({}).polluted, undefined, 'Object.prototype.polluted must not exist');
    assert.equal([].polluted, undefined, 'Array.prototype.polluted must not exist');
});

test('F-E3 every reserved path segment is rejected wherever it appears (3000 cases)', () => {
    // FORBIDDEN_PATH_SEGMENTS is the library's own list, so this stays correct
    // if the list grows — the property is "whatever you declared reserved is
    // actually enforced", not a hardcoded copy of today's names.
    const segments = [...FORBIDDEN_PATH_SEGMENTS];
    assert.ok(segments.length > 0, 'the reserved-segment list should not be empty');

    forEachCase(
        0x5eed_0204, 3000,
        (rng) => {
            const seg = rng.pick(segments);
            const shape = rng.int(4);
            if (shape === 0) return `${seg} == 1`;
            if (shape === 1) return `a.${seg} == 1`;
            if (shape === 2) return `a.${seg}.b == 1`;
            return `deep.a.${seg}.c == 1`;
        },
        (input) => {
            const result = runUnderContract(() => evaluateWhen(input, DATA));
            // Rejection or a falsy resolve are both safe; resolving to a real
            // prototype object is not. `true` would mean the path walked
            // somewhere it should not have.
            if (result === THREW_PARSE_ERROR) return;
            assert.equal(result, false,
                `a reserved segment must not resolve to a truthy value (source: ${input})`);
        }
    );
});

test('F-E4 inherited properties are invisible to path resolution', () => {
    // A path must read own data only. If `toString` or a custom prototype
    // property resolves, the evaluator is walking the prototype chain and the
    // reserved-name list is only a partial defence.
    const parent = { inheritedSecret: 'leaked', toStringy: 1 };
    const child = Object.create(parent);
    child.own = 'fine';

    assert.equal(evaluateWhen('own == "fine"', child), true, 'own properties still resolve');

    for (const source of [
        'inheritedSecret == "leaked"',
        'toStringy == 1',
        'hasOwnProperty != null',
        'toString != null',
        'valueOf != null'
    ]) {
        const result = runUnderContract(() => evaluateWhen(source, child));
        if (result === THREW_PARSE_ERROR) continue;
        assert.equal(result, false,
            `inherited property should not resolve (source: ${source})`);
    }
});

// ─── F-E5: the caps hold ─────────────────────────────────────────────────

test('F-E5 source-length and token caps reject oversized expressions', () => {
    const overLong = 'a'.repeat(DEFAULT_MAX_WHEN_SOURCE_LENGTH + 1);
    assert.equal(runUnderContract(() => evaluateWhen(overLong, DATA)), THREW_PARSE_ERROR,
        'a source past DEFAULT_MAX_WHEN_SOURCE_LENGTH should be rejected');

    const manyTokens = Array.from({ length: DEFAULT_MAX_WHEN_TOKENS + 50 }, () => 'a').join(' && ');
    const result = runUnderContract(() => evaluateWhen(manyTokens, DATA));
    assert.equal(result, THREW_PARSE_ERROR,
        'a source past DEFAULT_MAX_WHEN_TOKENS should be rejected');
});

test('F-E5b deeply nested parens terminate rather than blowing the stack', () => {
    for (const depth of [32, 256, 1024, 8192]) {
        const source = '('.repeat(depth) + 'a' + ')'.repeat(depth);
        runUnderContract(() => evaluateWhen(source, DATA));
    }
});

// ─── F-E6: evaluation is read-only ───────────────────────────────────────

test('F-E6 evaluation never mutates the caller data object (4000 cases)', () => {
    forEachCase(
        0x5eed_0205, 4000,
        (rng) => randomExpression(rng),
        (input) => {
            const data = { a: 1, b: 0, flag: true, x: { y: 'yes' }, deep: { a: { b: { c: 7 } } } };
            const before = JSON.stringify(data);
            try { evaluateWhen(input, data); } catch { /* rejection is acceptable */ }
            assert.equal(JSON.stringify(data), before,
                'evaluateWhen must treat the data object as read-only');
        }
    );
});

// ─── F-E7: the parse/evaluate split agrees with the one-shot call ────────

test('F-E7 parseWhen + evaluateAst matches evaluateWhen (4000 cases)', () => {
    // evaluateAst is the documented AST-caching escape hatch. If the two
    // paths ever disagree, a consumer that caches gets different visibility
    // than one that does not — a bug that only shows in production.
    forEachCase(
        0x5eed_0206, 4000,
        (rng) => randomExpression(rng),
        (input) => {
            const direct = runUnderContract(() => evaluateWhen(input, DATA));
            const viaAst = runUnderContract(() => {
                const ast = parseWhen(input);
                return evaluateAst(ast, DATA);
            });
            assert.equal(direct, viaAst,
                'the cached-AST path must agree with the one-shot path');
        }
    );
});

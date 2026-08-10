// Fuzz properties for the parser: TextFormBuilder.parse() under mutated and
// random input.
//
// The parser's public contract is that it does not throw — every failure
// comes back as a TupleResponse with a numeric code and messages. That makes
// two things fuzzable that a throwing API could not express:
//
//   • parse() never throws at all, for any input.
//   • parse() never returns INTERNAL_ERROR. That code means "unexpected
//     exception inside the parser; not a user-input problem" (see
//     src/tuple-response.js), so on fuzz input it is a bug signal, not an
//     acceptable outcome. This is the sharpest assertion in the suite:
//     a malformed source must be diagnosed, not merely survived.
//
//   F-P1  Mutated real sources parse or fail cleanly.
//   F-P2  Random junk parses or fails cleanly.
//   F-P3  Reported line/col land inside the input's real bounds.
//   F-P4  Failures carry at least one message.
//   F-P5  Parsing is deterministic and free of cross-call state.
//   F-P6  A reused builder behaves like a fresh one.
//   F-P7  Untrusted source text never reaches a prototype.
//
// Seeds are fixed; see tests/fuzz/random.js for why.

import assert from 'node:assert/strict';

import { TextFormBuilder, ERR, errorName } from '../../src/index.js';
import { forEachCase, randomJunk, loadCorpus, mutate, makeRng, protoSnapshot } from './random.js';
import { assertEnvelope } from './contract.js';

const CORPUS = loadCorpus();

/** Parse without letting anything escape; the throw itself is the finding. */
function parseSafely(source) {
    let result;
    try {
        result = new TextFormBuilder({ schemaText: source }).parse();
    } catch (err) {
        const kind = err?.constructor?.name ?? typeof err;
        throw new Error(
            `parse() threw ${kind} instead of returning a failure envelope: ` +
            `${err?.message ?? err}\n${err?.stack ?? ''}`
        );
    }
    assertEnvelope(result);
    assert.notEqual(
        result.error, ERR.INTERNAL_ERROR,
        `parse() reported INTERNAL_ERROR, which means an unhandled exception inside ` +
        `the parser rather than a diagnosed input problem: ${result.messages.join(' | ')}`
    );
    return result;
}

// ─── F-P1 / F-P2: the parser never throws and never goes INTERNAL ────────

test('F-P1 mutated real sources always come back as a clean envelope (4000 cases)', () => {
    forEachCase(
        0x5eed_0101, 4000,
        (rng) => mutate(rng, rng.pick(CORPUS).text, 4),
        (input) => { parseSafely(input); }
    );
});

test('F-P2 random junk always comes back as a clean envelope (3000 cases)', () => {
    forEachCase(
        0x5eed_0102, 3000,
        (rng) => randomJunk(rng, 400),
        (input) => { parseSafely(input); }
    );
});

test('F-P2b heavily mutated sources (up to 20 edits) stay clean (1500 cases)', () => {
    // Light mutation mostly produces "almost valid"; heavy mutation reaches
    // the states where partial structures are half-built, which is where an
    // undefined-property read tends to hide.
    forEachCase(
        0x5eed_0103, 1500,
        (rng) => mutate(rng, rng.pick(CORPUS).text, 20),
        (input) => { parseSafely(input); }
    );
});

// ─── F-P3: reported positions stay inside the input ──────────────────────

// Error messages are prefixed by ParseError.toMessage() as
// "line N, col M: ..." — the repo requires named capture groups.
const POSITION = /line (?<line>\d+)(?:, col (?<col>\d+))?/g;

test('F-P3 every reported line/col lands inside the input (4000 cases)', () => {
    // A diagnostic pointing past the end of the file sends an editor's error
    // marker somewhere the user cannot see, which is worse than no marker.
    forEachCase(
        0x5eed_0104, 4000,
        (rng) => (rng.bool(0.7)
            ? mutate(rng, rng.pick(CORPUS).text, 6)
            : randomJunk(rng, 300)),
        (input) => {
            const result = parseSafely(input);
            if (result.error === ERR.OK) return;

            const physicalLines = input.split('\n');
            for (const message of result.messages) {
                POSITION.lastIndex = 0;
                let m;
                while ((m = POSITION.exec(message)) !== null) {
                    const line = Number(m.groups.line);
                    assert.ok(line >= 1 && line <= physicalLines.length,
                        `reported line ${line} is outside the input's 1..${physicalLines.length} ` +
                        `(message: ${message})`);
                    if (m.groups.col !== undefined) {
                        const col = Number(m.groups.col);
                        assert.ok(col >= 1,
                            `reported col ${col} should be 1-based (message: ${message})`);
                        // The bound is length + 1, not length: a caret pointing
                        // one past the final character is the legal way to say
                        // "unexpected end of line". Anything beyond that is a
                        // position the editor cannot render.
                        const width = physicalLines[line - 1].length;
                        assert.ok(col <= width + 1,
                            `reported col ${col} exceeds line ${line}'s length ${width} + 1 ` +
                            `(message: ${message})`);
                    }
                }
            }
        }
    );
});

// ─── F-P4: failures are diagnosed, not silent ────────────────────────────

test('F-P4 a failing parse always explains itself (3000 cases)', () => {
    // A failure code with no message is a silent drop wearing a number.
    forEachCase(
        0x5eed_0105, 3000,
        (rng) => mutate(rng, rng.pick(CORPUS).text, 8),
        (input) => {
            const result = parseSafely(input);
            if (result.error === ERR.OK) {
                assert.notEqual(result.payload, null, 'a successful parse carries a payload');
                return;
            }
            assert.ok(result.messages.length > 0,
                `parse failed with ${errorName(result.error)} but produced no message`);
            assert.equal(result.payload, null,
                'a failed parse should not also hand back a payload');
        }
    );
});

// ─── F-P5 / F-P6: determinism and builder reuse ──────────────────────────

test('F-P5 parsing the same source twice yields the same result (1500 cases)', () => {
    // Catches module-level mutable state — a shared /g regex whose lastIndex
    // survives a call is the classic instance, and this library has several.
    forEachCase(
        0x5eed_0106, 1500,
        (rng) => mutate(rng, rng.pick(CORPUS).text, 5),
        (input) => {
            const a = parseSafely(input);
            const b = parseSafely(input);
            assert.equal(a.error, b.error, 'error code is stable across identical parses');
            assert.deepEqual(a.messages, b.messages, 'messages are stable across identical parses');
            assert.deepEqual(
                JSON.parse(JSON.stringify(a.payload ?? null)),
                JSON.parse(JSON.stringify(b.payload ?? null)),
                'payload is stable across identical parses'
            );
        }
    );
});

test('F-P6 a reused builder matches a fresh one for the same source (1500 cases)', () => {
    // setSchemaText is the documented reuse path; it must fully reset state,
    // not leave the previous source's leftovers in place.
    const rng = makeRng(0x5eed_0107);
    const builder = new TextFormBuilder({ schemaText: '' });

    for (let i = 0; i < 1500; i++) {
        const input = mutate(rng, rng.pick(CORPUS).text, 5);
        builder.setSchemaText(input);
        let reused;
        try {
            reused = builder.parse();
            const fresh = parseSafely(input);
            assert.equal(reused.error, fresh.error,
                'a reused builder should agree with a fresh one on the error code');
            assert.deepEqual(reused.messages, fresh.messages,
                'a reused builder should agree with a fresh one on the messages');
        } catch (err) {
            err.message =
                `fuzz failure [seed=0x5eed0107 iteration=${i}/1500]\n` +
                `input: ${JSON.stringify(input.slice(0, 300))}\n\n${err.message}`;
            throw err;
        }
    }
});

// ─── F-P7: no prototype pollution from source text ───────────────────────

test('F-P7 source text carrying __proto__ / constructor never reaches a prototype', () => {
    const before = protoSnapshot();
    const rng = makeRng(0x5eed_0108);
    const HAZARDS = ['__proto__', 'constructor', 'prototype', '__defineGetter__'];

    for (let i = 0; i < 2000; i++) {
        const hazard = rng.pick(HAZARDS);
        const source = rng.pick([
            `columns: 10\n[container({${hazard}})]\n  - [textfield(5,{${hazard}})] X`,
            `columns: 10\nopts = ["a"] -> {${hazard}}\n[container({t})]\n  - [select(5,#opts,{${hazard}})] X`,
            `columns: 10\ntooltips = [\n  "${hazard}" = "boom"\n]\n[container({t})]\n  - [label(5,tt="${hazard}")] X`,
            `columns: 10\n[container({t})]\n  - [textfield(5,{a.${hazard}.b})] X`,
            `columns: 10\n[container({t})]\n  - [>container(when="${hazard} == 1")] [label(4)] X`
        ]);
        parseSafely(source);
    }

    assert.deepEqual(protoSnapshot(), before,
        'parsing source text containing prototype-hazard names must not mutate any intrinsic prototype');
});

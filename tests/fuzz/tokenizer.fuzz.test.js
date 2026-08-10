// Fuzz properties for the lexical layer: LineSplitter, LineTokenizer, and
// stripTrailingLineComment.
//
// The tokenizer is the library's outermost boundary — it is the first code
// to touch a byte a consumer did not write. The properties below pin what it
// owes a caller no matter what those bytes are:
//
//   F-T1  Random junk never escapes as anything but a ParseError.
//   F-T2  Every prefix of a valid source is handled (truncation / partial save).
//   F-T3  Oversized single tokens are rejected or lexed, never hung on.
//   F-T4  Token positions always point inside the input.
//   F-T5  stripTrailingLineComment is total, shrinking, and never throws.
//   F-T6  Comment-vs-quote edge cases keep quoted `#` intact.
//   F-T7  Lone surrogates and other malformed UTF-16 don't break lexing.
//
// Seeds are fixed; see tests/fuzz/random.js for why.

import assert from 'node:assert/strict';

import { LineSplitter, LineTokenizer, stripTrailingLineComment } from '../../src/tokenizer.js';
import {
    forEachCase, randomJunk, loadCorpus,
    UNICODE_SAMPLES, DSL_PUNCT, ASCII_PRINTABLE
} from './random.js';
import { runUnderContract, THREW_PARSE_ERROR } from './contract.js';

const CORPUS = loadCorpus();

/** Split, then tokenize every logical line. The full lexical pipeline. */
function lexAll(source) {
    const lines = new LineSplitter(source).split();
    const out = [];
    for (const line of lines) {
        const tk = new LineTokenizer(line.content, line.line, line.breaks);
        out.push(tk);
    }
    return out;
}

// ─── F-T1: random junk ───────────────────────────────────────────────────

test('F-T1 lexing random junk throws nothing but ParseError (4000 cases)', () => {
    forEachCase(
        0x5eed_0001, 4000,
        (rng) => randomJunk(rng, 300),
        (input) => {
            const result = runUnderContract(() => lexAll(input));
            assert.ok(result === THREW_PARSE_ERROR || Array.isArray(result),
                'lexing returns tokenizers or throws ParseError');
        }
    );
});

// ─── F-T2: truncated valid sources ───────────────────────────────────────

test('F-T2 every prefix of a real source lexes or reports a ParseError (2000 cases)', () => {
    // A half-written file is the single most common malformed input a live
    // editor hands a parser — every keystroke produces one.
    forEachCase(
        0x5eed_0002, 2000,
        (rng) => {
            const src = rng.pick(CORPUS).text;
            return src.slice(0, rng.int(src.length + 1));
        },
        (input) => {
            runUnderContract(() => lexAll(input));
        }
    );
});

// ─── F-T3: giant tokens ──────────────────────────────────────────────────

test('F-T3 oversized identifiers, strings, and numbers terminate (600 cases)', () => {
    // Guards against a scanner whose inner loop is quadratic in token length:
    // the assertion is that the whole batch finishes, which it cannot do if
    // any single case degenerates.
    forEachCase(
        0x5eed_0003, 600,
        (rng) => {
            const size = rng.pick([1024, 8192, 65536]);
            const body = rng.repeat(size, () => rng.pick('abcdefghij0123456789'));
            switch (rng.int(4)) {
                case 0: return `[label(10,{${body}})]`;
                case 1: return `[label(10,"${body}")]`;
                case 2: return `columns: ${rng.repeat(size, () => rng.pick('0123456789'))}`;
                default: return `x = ["${body}"] -> {y}`;
            }
        },
        (input) => {
            runUnderContract(() => lexAll(input));
        }
    );
});

test('F-T3b an unterminated quote spanning a huge input still terminates', () => {
    const input = `[label(10,"${'a'.repeat(500000)}`;
    runUnderContract(() => lexAll(input));
});

// ─── F-T4: token positions stay inside the input ─────────────────────────

test('F-T4 every emitted token reports a position inside the source (2000 cases)', () => {
    forEachCase(
        0x5eed_0004, 2000,
        (rng) => {
            const src = rng.pick(CORPUS).text;
            const cut = rng.int(src.length + 1);
            return rng.bool(0.5) ? src.slice(0, cut) : randomJunk(rng, 200);
        },
        (input) => {
            const result = runUnderContract(() => lexAll(input));
            if (result === THREW_PARSE_ERROR) return;

            const physicalLines = input.split('\n');
            for (const tk of result) {
                for (const token of tk.tokens) {
                    if (token.line === undefined) continue;
                    assert.ok(Number.isInteger(token.line) && token.line >= 1,
                        `token.line should be a positive integer, got ${token.line}`);
                    assert.ok(token.line <= physicalLines.length,
                        `token.line ${token.line} exceeds the input's ${physicalLines.length} lines`);
                    if (token.col !== undefined) {
                        assert.ok(Number.isInteger(token.col) && token.col >= 1,
                            `token.col should be a positive integer, got ${token.col}`);
                    }
                }
            }
        }
    );
});

// ─── F-T5 / F-T6: comment stripping ──────────────────────────────────────

test('F-T5 stripTrailingLineComment is total and never grows its input (5000 cases)', () => {
    forEachCase(
        0x5eed_0005, 5000,
        (rng) => randomJunk(rng, 160),
        (input) => {
            const out = stripTrailingLineComment(input);
            assert.equal(typeof out, 'string', 'always returns a string');
            assert.ok(out.length <= input.length, 'stripping never lengthens the line');
            assert.ok(input.startsWith(out), 'the result is a prefix of the input');
            assert.equal(stripTrailingLineComment(out), out,
                'stripping is idempotent — a stripped line has no comment left to cut');
        }
    );
});

test('F-T6 a `#` inside quotes survives stripping (3000 cases)', () => {
    // The rule the tokenizer implements is that only an unquoted `#` starts a
    // comment. This builds lines whose quoted section is known to contain a
    // `#` and asserts it is still there afterwards.
    forEachCase(
        0x5eed_0006, 3000,
        (rng) => {
            const quote = rng.pick(['"', "'"]);
            const inner = rng.repeat(rng.between(1, 20), () =>
                rng.bool(0.3) ? '#' : rng.pick(ASCII_PRINTABLE.replace(/[\t]/g, '')));
            const marker = `${quote}#${inner}#${quote}`;
            const tail = rng.bool(0.5) ? ` # ${randomJunk(rng, 20).replace(/\n/g, ' ')}` : '';
            return { line: `[label(10,${marker})]${tail}`, marker };
        },
        ({ line, marker }) => {
            const out = stripTrailingLineComment(line);
            assert.ok(out.includes(marker),
                `quoted segment ${JSON.stringify(marker)} should survive comment stripping`);
        }
    );
});

// ─── F-T7: malformed UTF-16 ──────────────────────────────────────────────

test('F-T7 lone surrogates and exotic whitespace do not break lexing (2000 cases)', () => {
    forEachCase(
        0x5eed_0007, 2000,
        (rng) => {
            const src = rng.pick(CORPUS).text;
            const at = rng.int(src.length + 1);
            const inject = rng.repeat(rng.between(1, 6), () => rng.pick(UNICODE_SAMPLES));
            return src.slice(0, at) + inject + src.slice(at);
        },
        (input) => {
            runUnderContract(() => lexAll(input));
        }
    );
});

// ─── F-T8: structurally-dense punctuation ────────────────────────────────

test('F-T8 dense bracket soup never escapes as a non-ParseError (3000 cases)', () => {
    // Uniform random bytes rarely produce deep bracket nesting; this pool is
    // punctuation-only so the depth and pairing logic actually gets exercised.
    forEachCase(
        0x5eed_0008, 3000,
        (rng) => rng.repeat(rng.between(1, 400), () => rng.pick(DSL_PUNCT)),
        (input) => {
            runUnderContract(() => lexAll(input));
        }
    );
});

test('F-T8b deeply nested brackets terminate rather than blowing the stack', () => {
    for (const depth of [64, 512, 4096, 32768]) {
        const input = '['.repeat(depth) + ']'.repeat(depth);
        runUnderContract(() => lexAll(input));
    }
});

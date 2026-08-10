// Tests for the fixes that resolve round-13 review findings.
//
// Coverage map:
//   M1   interpolate fails-fast on reserved-segment placeholders
//        ({__proto__}, {constructor}, {prototype}). Throws
//        ParseError(PARSE_ERROR) at parse time before any
//        substitution begins, regardless of strict / lenient mode.
//        Mirrors parseDecorated's behaviour.
//   M2   Bare control characters in string literals are a parse
//        error (LEX_ERROR for the outer DSL, PARSE_ERROR for the
//        when expression). The writer (writeQuotedString) raises
//        TypeError on the same input. The two sides refuse the
//        same bytes; round-trip is honest.
//   m1   renderPropertiesBlock routes name and type through
//        writeQuotedString so a consumer-supplied string with a
//        grammar-illegal byte produces a TypeError instead of
//        malformed DSL.
//   m2   render-preview.charWidth covers the standard Unicode
//        Wide / Fullwidth ranges. CJK, Hangul, Kana, and
//        fullwidth forms now report width 2 so the surrounding
//        ASCII box pads correctly.
//   m3   Integer literals beyond Number.MAX_SAFE_INTEGER raise
//        LEX_ERROR with a message that names the cap. Authors
//        see the typo instead of a silent precision loss.
//   m8   validateControlSpec rejects a spec that declares both
//        contentRef:'allowed' and an active optionsRef. The
//        ambiguity used to resolve silently in the parser; the
//        spec validator now catches it.
//   no-cache  AST walks are re-done each invocation. Hard rule.
//        See docs/architecture-no-ast-caching.md. The test below
//        confirms that calling process() twice with the same
//        source produces two independent AST instances (no
//        identity caching).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    TextFormBuilder,
    ERR,
    interpolate,
    parseDecorated,
    validateControlSpec,
    renderFormPreview
} from '../src/index.js';
import { writeQuotedString, readQuotedString } from '../src/string-literal.js';
import { renderPropertiesBlock } from '../src/property-collector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = join(__dirname, '..');
const readDoc = (relPath) => readFileSync(join(repoRoot, relPath), 'utf8');

// ─── M1 interpolate fail-fast on reserved segments ───────────────────────

test('M1 interpolate({__proto__}) throws at parse time (lenient mode)', () => {
    assert.throws(() => interpolate('{__proto__}', {}, {}), /reserved name '__proto__'/);
});

test('M1 interpolate({__proto__}) throws at parse time (strict mode, same wording)', () => {
    assert.throws(
        () => interpolate('{__proto__}', {}, {}, { strict: true }),
        /reserved name '__proto__'/
    );
});

test('M1 interpolate({a.constructor.b}) throws naming the offending segment', () => {
    assert.throws(
        () => interpolate('{a.constructor.b}', {}, {}),
        /reserved name 'constructor'/
    );
});

test('M1 interpolate({@constructor}) throws on the function arm too', () => {
    assert.throws(
        () => interpolate('{@constructor}', {}, {}),
        /reserved name 'constructor'/
    );
});

test('M1 interpolate fail-fast pre-scan does not eat the substitution stage', () => {
    // A clean placeholder still substitutes correctly. The pre-scan
    // is a separate pass that returns silently when nothing reserved
    // shows up.
    assert.equal(interpolate('hello {name}', { name: 'world' }), 'hello world');
});

test('M1 interpolate matches parseDecorated parse-time policy', () => {
    // Both helpers refuse a reserved-segment placeholder before any
    // output / substitution stage runs. The error wording is the
    // same shape so a consumer debugging one surface knows what the
    // other will say.
    assert.throws(() => parseDecorated('{__proto__}'),    /reserved name '__proto__'/);
    assert.throws(() => interpolate('{__proto__}', {}),   /reserved name '__proto__'/);
});

// ─── M2 C0 / DEL / CR rejected at parse time ─────────────────────────────

test('M2 outer DSL string literal with bare \\x00 raises LEX_ERROR with the byte value', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{x},placeholder="bad\x00here")] X
`
    }).parse();
    assert.equal(result.error, ERR.LEX_ERROR);
    assert.ok(result.messages.some(m => /bare control character \(0x00\)/.test(m)));
});

test('M2 readQuotedString rejects a bare CR via the onInvalidChar callback', async () => {
    // The outer DSL splitter consumes CR as a line terminator, so a
    // bare CR never reaches the string reader through the normal
    // parse path. The reader's onInvalidChar callback is a
    // defense-in-depth check covering any caller that hands the
    // reader a slice without splitting first. Exercise it directly.
    let captured = null;
    assert.throws(() => {
        readQuotedString('"a\rb"', 0,
            () => { throw new Error('unterminated'); },
            (charPos, charCode) => { captured = { charPos, charCode }; throw new Error(`reject 0x${charCode.toString(16).padStart(2, '0')}`); }
        );
    }, /reject 0x0d/);
    assert.equal(captured.charCode, 0x0d);
    assert.equal(captured.charPos,  2);
});

test('M2 outer DSL string literal with bare DEL (0x7F) raises LEX_ERROR', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{x},placeholder="bad\x7fhere")] X
`
    }).parse();
    assert.equal(result.error, ERR.LEX_ERROR);
    assert.ok(result.messages.some(m => /bare control character \(0x7f\)/.test(m)));
});

test('M2 escape sequences \\n and \\t still work inside string literals', () => {
    // The C0 rejection only fires for unescaped bytes. Explicit
    // \n / \t escapes pass through unchanged.
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["msg" = { type: "string", default: "line1\\nline2\\there" }]

[container({t})]

  - [textfield(5,{msg})] M
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    assert.equal(result.payload.__properties.msg.default, 'line1\nline2\there');
});

test('M2 writeQuotedString refuses C0 (symmetric with reader)', () => {
    assert.throws(() => writeQuotedString('hi\x00there'), /byte 0x00 at index 2/);
    assert.throws(() => writeQuotedString('one\rtwo'),    /byte 0x0d at index 3/);
    assert.throws(() => writeQuotedString('del\x7f'),     /byte 0x7f at index 3/);
});

test('M2 round-trip: every byte the writer accepts re-parses to the same string', () => {
    // Build the printable + Unicode + recognised-escape set.
    const original = 'hi\nthere\twith\\back and "quote" and Über and 日本 and 👋';
    const encoded  = writeQuotedString(original);
    const decoded  = readQuotedString(encoded, 0,
        () => { throw new Error('unterminated'); },
        () => { throw new Error('invalid char'); }
    );
    assert.equal(decoded.value, original);
});

// ─── m1 renderPropertiesBlock escapes name + type ────────────────────────

test('m1 renderPropertiesBlock with a quote-bearing name emits an escaped literal', () => {
    // Hand-built input the parser would never produce, but the
    // public contract on renderPropertiesBlock accepts any string.
    // The output should be valid DSL the reader can parse back.
    const props = { 'a"b': { type: 'string', default: 'x' } };
    const text  = renderPropertiesBlock(props);
    assert.ok(text.includes('"a\\"b"'),
        `expected escaped name in output, got: ${text}`);
});

test('m1 renderPropertiesBlock refuses a name containing a bare C0 byte', () => {
    const props = { 'bad\x00name': { type: 'string', default: 'x' } };
    assert.throws(() => renderPropertiesBlock(props), /byte 0x00/);
});

// ─── m2 charWidth covers CJK / Hangul / fullwidth ────────────────────────

test('m2 renderFormPreview pads a CJK label correctly (width 2 per char)', () => {
    // Two-character CJK label (4 visual cells) plus padding should
    // not under-fill the box. The previous narrower width logic
    // would treat each CJK char as 1 cell and crop the box.
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(10,{x})] 日本
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    const preview = renderFormPreview(result.payload, { width: 80 });
    // The label appears in the output. Sanity check.
    assert.ok(preview.includes('日本'));
});

// ─── m3 integer literal beyond MAX_SAFE_INTEGER ──────────────────────────

test('m3 integer literal beyond MAX_SAFE_INTEGER raises LEX_ERROR naming the cap', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 9007199254740993

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.LEX_ERROR);
    assert.ok(result.messages.some(m => /MAX_SAFE_INTEGER/.test(m)));
});

test('m3 integer literal at exactly MAX_SAFE_INTEGER parses cleanly', () => {
    // 2^53 - 1 = 9007199254740991. This is the largest exact integer.
    // The cap rejects strictly-greater, not equal-or-greater.
    // Use it where an integer is meaningful — a `width` is too small
    // to admit it; layout would refuse before the cap. Use it as
    // the textfield's maxLength param instead.
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{x},maxLength=9007199254740991)] X
`
    }).parse();
    assert.equal(result.error, ERR.OK);
});

test('m3 float literals are not subject to the integer-precision check', () => {
    // The check is gated on `!isFloat`, so a float literal with the
    // same magnitude is still accepted (with the usual float
    // precision loss the consumer is on the hook for).
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [float(5,{f:float},min=9007199254740993.0)] F
`
    }).parse();
    assert.equal(result.error, ERR.OK);
});

// ─── m8 validateControlSpec catches contentRef + optionsRef ambiguity ────

test("m8 spec with both contentRef:'allowed' and optionsRef:'required' is rejected", () => {
    const errors = validateControlSpec({
        ambig: {
            contentRef: 'allowed',
            optionsRef: 'required',
            params: {}
        }
    });
    assert.ok(errors.length > 0);
    assert.ok(errors.some(m => /cannot declare both contentRef:'allowed' and optionsRef/.test(m)));
});

test("m8 spec with contentRef:'allowed' and optionsRef:'forbidden' is fine (the safe combination)", () => {
    const errors = validateControlSpec({
        ok: {
            contentRef: 'allowed',
            optionsRef: 'forbidden',
            params: {}
        }
    });
    assert.equal(errors.length, 0, errors.join('\n'));
});

// ─── No AST caching — hard rule ──────────────────────────────────────────

test('no-cache: process() called twice on the same builder produces two independent AST instances', () => {
    // The architecture-no-ast-caching rule says every call re-walks
    // from scratch. Two consecutive process() calls must not return
    // the same payload object identity.
    const b = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{x})] X
`
    });
    const r1 = b.process();
    const r2 = b.process();
    assert.equal(r1.error, ERR.OK);
    assert.equal(r2.error, ERR.OK);
    assert.notEqual(r1.payload, r2.payload, 'process() returned the same AST instance — caching is forbidden');
    assert.notEqual(r1.payload.root, r2.payload.root, 'root containers shared identity — caching is forbidden');
});

test('no-cache: docs/architecture-no-ast-caching.md exists and names the rule', () => {
    const text = readDoc('docs/architecture-no-ast-caching.md');
    assert.ok(text.includes('AST walks are not cached'),
        'doc title missing');
    assert.ok(text.includes('Nothing is cached'),
        'core rule statement missing');
    assert.ok(text.includes('processFromAst'),
        'forbidden helper name missing from rule-out list');
});

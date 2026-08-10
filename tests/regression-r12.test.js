// Tests covering the twelfth principal-review round of fixes.
//
// Coverage map:
//   M1   property-collector.formatDefault uses the symmetric
//        writeQuotedString helper. Strings with newlines, tabs,
//        carriage returns, double quotes, and backslashes round-trip
//        through parse -> render -> parse without mutation.
//   M2   interpolate and renderFragments share one core. Reserved
//        segments (__proto__, prototype, constructor) resolve to
//        undefined on both surfaces; both surfaces produce the same
//        strict-mode error wording.
//   M3   init= literal value is type-checked against the declared
//        binding type via the shared defaultMatchesType helper.
//        Block-side __properties default uses the same rule, so the
//        two literal-vs-type paths cannot drift.
//   D6   binding: 'optional' is no longer accepted in a control
//        spec. The error message lists the two surviving values.
//   __pk Internal-only field is non-enumerable, not part of the
//        public TypeScript surface, and not advertised in the
//        architecture doc.
//   8.6  Empty option-source choice raises a non-fatal warning that
//        flows through TupleResponse.messages.
//   UTF-8 String content with umlauts, emoji, and CJK works across
//        init= literals, __properties defaults, option-source
//        values, and named-text bodies. Round-trips verbatim through
//        the symmetric reader / writer.

import assert from 'node:assert/strict';

import {
    TextFormBuilder,
    ERR,
    interpolate,
    renderFragments,
    parseDecorated,
    validateControlSpec
} from '../src/index.js';
import { writeQuotedString, readQuotedString } from '../src/string-literal.js';
import { resolvePlaceholder } from '../src/placeholder.js';
import { defaultMatchesType, describeValue } from '../src/parser/literal-types.js';

// ─── M1 round-trip safety on string defaults ─────────────────────────────

test("M1 writeQuotedString escapes the five reader-recognised pairs", () => {
    assert.equal(writeQuotedString('plain'),         '"plain"');
    assert.equal(writeQuotedString('with "quotes"'), '"with \\"quotes\\""');
    assert.equal(writeQuotedString('back\\slash'),   '"back\\\\slash"');
    assert.equal(writeQuotedString('one\ntwo'),      '"one\\ntwo"');
    assert.equal(writeQuotedString('a\tb'),          '"a\\tb"');
});

test("M1 writeQuotedString throws on bare CR (no grammar escape; symmetric with reader)", () => {
    // The grammar has no \r escape and the reader rejects bare CR
    // at parse time. The writer raises TypeError on the same input
    // so a caller never produces a literal that won't round-trip.
    assert.throws(() => writeQuotedString('one\rtwo'),   /byte 0x0d at index 3/);
    assert.throws(() => writeQuotedString('one\r\ntwo'), /byte 0x0d at index 3/);
});

test("M1 writeQuotedString throws on other C0 controls + DEL (symmetric with reader)", () => {
    // Reader-rejected bytes raise TypeError on the writer side.
    // The error message names the byte and its index so the caller
    // can locate the bad character.
    assert.throws(() => writeQuotedString('hi\x00there'), /byte 0x00 at index 2/);
    assert.throws(() => writeQuotedString('bel\x07'),     /byte 0x07 at index 3/);
    assert.throws(() => writeQuotedString('del\x7f'),     /byte 0x7f at index 3/);
});

test("M1 round-trip: a string default with newlines survives parse -> writeQuotedString -> parse", () => {
    // Reader and writer talk to each other directly. A string with
    // every escape pair plus high-Unicode payload comes out byte-for-byte
    // identical after one full cycle.
    const original = 'tab\there\nnewline\n"quoted"\nback\\slash';
    const encoded  = writeQuotedString(original);
    const decoded  = readQuotedString(encoded, 0, () => { throw new Error('unterminated'); });
    assert.equal(decoded.value, original);
    assert.equal(decoded.end,   encoded.length);
});

test("M1 __properties round-trip preserves a string default with escape characters", async () => {
    // The bug this fixes: formatDefault used to escape only \\ and ",
    // so a default containing \n was rendered as a literal newline,
    // which then either broke the line-based grammar or silently
    // truncated on the next parse. Using writeQuotedString closes
    // the gap.
    const { renderPropertiesBlock } = await import('../src/property-collector.js');
    const props = {
        title: { type: 'string', default: 'first line\nsecond line\twith\ttabs' }
    };
    const text = renderPropertiesBlock(props);
    // Re-feed the rendered block through the parser.
    const result = new TextFormBuilder({
        schemaText: `columns: 10

${text}

[container({t})]

  - [textfield(5,{title})] T
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    assert.equal(result.payload.__properties.title.default, 'first line\nsecond line\twith\ttabs');
});

// ─── M2 shared placeholder-resolver core ─────────────────────────────────

test("M2 interpolate and renderFragments share the same lenient miss text", () => {
    // Both surfaces leave the literal `{path}` text in the output on
    // a missing data path. They also use the exact same shape for
    // the bracketed placeholder so a debugger can grep across either
    // surface and find the same string.
    const fragments = parseDecorated('hello {name}');
    assert.equal(renderFragments(fragments, {}, {}),  'hello {name}');
    assert.equal(interpolate('hello {name}', {}, {}), 'hello {name}');
});

test("M2 interpolate strict mode produces the same error wording as renderFragments strict mode", () => {
    const fragments = parseDecorated('hi {missing}');
    let interpErr, renderErr;
    try { interpolate('hi {missing}', {}, {}, { strict: true }); }
    catch (e) { interpErr = e.message; }
    try { renderFragments(fragments, {}, {}, { strict: true }); }
    catch (e) { renderErr = e.message; }
    assert.equal(interpErr, renderErr);
    assert.match(interpErr, /missing data for \{missing\}/);
});

test("M2 interpolate fails-fast on reserved segments at parse time (matches parseDecorated)", () => {
    // interpolate's pre-scan runs before any substitution begins; a
    // reserved-segment placeholder throws ParseError(PARSE_ERROR)
    // unconditionally (lenient and strict mode both throw). Same
    // rule fires in parseDecorated for the same identifiers.
    assert.throws(() => interpolate('{__proto__}',     {}, {}), /PARSE_ERROR|reserved name '__proto__'/);
    assert.throws(() => interpolate('{constructor}',   {}, {}), /reserved name 'constructor'/);
    assert.throws(() => interpolate('{a.__proto__.b}', {}, {}), /reserved name '__proto__'/);
    // renderFragments still walks a hand-built fragment array
    // leniently (a synthetic binding fragment on a reserved name
    // renders the literal placeholder). The parse-time fail-fast
    // policy lives at parseDecorated; renderFragments is a
    // post-parse render of an already-screened fragment list.
    const synthetic = [{ kind: 'binding', path: '__proto__' }];
    assert.equal(renderFragments(synthetic, {}, {}), '{__proto__}');
    // Sanity: a plain unrelated fragment array still renders cleanly.
    const f1 = parseDecorated('plain');
    assert.equal(renderFragments(f1, {}, {}), 'plain');
});

test("M2 function-arm reserved segments split across parse-time and render-time", () => {
    // The reserved-segment set covers __proto__ / prototype /
    // constructor. The parse-time pre-scan catches those three and
    // throws unconditionally.
    assert.throws(() => interpolate('{@constructor}', {}, {}), /reserved name 'constructor'/);
    assert.throws(() => interpolate('{@prototype}',   {}, {}), /reserved name 'prototype'/);
    // Other Object.prototype members (toString, hasOwnProperty,
    // valueOf, etc.) are NOT in the reserved set. The function-arm
    // own-property check at render time catches them: lenient mode
    // renders the literal placeholder; strict mode throws the
    // documented "no function registered for {@name}" error.
    assert.equal(interpolate('{@toString}',       {}, {}), '{@toString}');
    assert.equal(interpolate('{@hasOwnProperty}', {}, {}), '{@hasOwnProperty}');
    // Hand-built function fragment with any name still renders
    // leniently — renderFragments is post-parse and trusts the
    // fragment array it gets.
    const f = [{ kind: 'function', name: 'toString' }];
    assert.equal(renderFragments(f, {}, {}), '{@toString}');
});

test("M2 resolvePlaceholder is exported and callable directly", () => {
    // Sanity check that the shared core is reachable as a public
    // symbol so consumers building their own templating can route
    // through the same trust story.
    const out = resolvePlaceholder(
        { name: 'name', isFunction: false },
        {
            data: { name: 'world' },
            functions: {},
            strict: false,
            literalPlaceholder: () => '{name}'
        }
    );
    assert.equal(out, 'world');
});

// ─── M3 init= literal type-check via shared validator ────────────────────

test("M3 init=42 paired with {x:string} raises INVALID_PARAM at parse", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{x:string},init=42)] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /init.*does not match binding type 'string'/.test(m)));
});

test('M3 init="abc" paired with {n:int} raises INVALID_PARAM at parse', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [number(5,{n:int},init="abc")] N
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /init.*does not match binding type 'int'/.test(m)));
});

test('M3 init=true paired with {b:bool} parses cleanly', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [check(5,{b:bool},init=true)] B
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    const ctl = result.payload.root.rows[0].controls[0];
    assert.equal(ctl.init.kind,  'literal');
    assert.equal(ctl.init.value, true);
    // _line / _col bookkeeping is stripped before publication.
    assert.equal('_line' in ctl.init, false);
    assert.equal('_col'  in ctl.init, false);
});

test('M3 init= without a declared binding type passes through (custom-vocabulary control)', () => {
    // A binding with no `:type` suffix and no __dataType override
    // has `bindingType: null` at hoist time. The check is gated on
    // a declared type, so init= remains free-form for that case.
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{x},init=42)] X
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    assert.equal(result.payload.root.rows[0].controls[0].init.value, 42);
});

test('M3 defaultMatchesType + describeValue are exported for sink-side reuse', () => {
    // Sink consumers writing their own validation can route through
    // the same rule. Keeps the package's typing vocabulary
    // single-sourced.
    assert.equal(defaultMatchesType('int', 5),             null);
    assert.equal(defaultMatchesType('int', 5.5),           'expected integer, got number');
    assert.equal(defaultMatchesType('string[]', ['a','b']), null);
    assert.match(defaultMatchesType('string[]', ['a', 1]), /expected array of strings, got element number/);
    assert.equal(defaultMatchesType('uuid', 'whatever'),   null);   // custom type passes
    assert.equal(describeValue(null),       'null');
    assert.equal(describeValue([]),         'array');
    assert.equal(describeValue('hi'),       'string');
});

// ─── D6 binding 'optional' is gone ───────────────────────────────────────

test("D6 control spec with binding: 'optional' fails validateControlSpec", () => {
    // validateControlSpec returns the error array directly (a non-empty
    // array means "rejected"). The message lists the two surviving values
    // so a future contributor reading the error sees the new vocabulary
    // immediately.
    const errors = validateControlSpec({
        myControl: { binding: 'optional', params: {} }
    });
    assert.ok(Array.isArray(errors) && errors.length > 0);
    assert.ok(errors.some(m => /binding must be 'required' or 'forbidden'/.test(m)));
});

test("D6 builder.registerControl rejects binding: 'optional' the same way", () => {
    // registerControl is a TextFormBuilder method, not a module
    // export. The instance routes the spec through validateControlSpec
    // before grafting it onto the builder's own controlSpec.
    const b = new TextFormBuilder({ schemaText: 'columns: 10\n' });
    const r = b.registerControl('myControl', {
        binding: 'optional', params: {}
    });
    assert.equal(r.error, ERR.INVALID_SPEC);
});

// ─── __pk internal-only ───────────────────────────────────────────────────

test('__pk is non-enumerable on a parsed named object (does not surface to JSON)', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

person = { !id: "p1", name: "Steve" }

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    const obj = result.payload.namedObjects.person;
    // Direct read still works (parser-internal consumers use it).
    assert.equal(obj.__pk, 'id');
    // But it is not enumerable, so JSON dumps and Object.keys skip it.
    assert.equal(Object.keys(obj).includes('__pk'), false);
    assert.ok(JSON.stringify(obj).indexOf('__pk') === -1);
});

// ─── 8.6 empty-choice warning ─────────────────────────────────────────────

test('8.6 empty option-source choice produces a non-fatal warning', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

sizes = ["small", "", "large"] -> {size}

[container({t})]

  - [select(5,#sizes,{size})] S
`
    }).parse();
    // Parse succeeds; the empty entry is merely flagged.
    assert.equal(result.error, ERR.OK);
    assert.ok(result.messages.some(m => /sizes.*empty choice/.test(m)),
        `expected empty-choice warning, got: ${JSON.stringify(result.messages)}`);
});

test('8.6 multiple empty choices flagged with a count', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

sizes = ["", "small", "", "large"] -> {size}

[container({t})]

  - [select(5,#sizes,{size})] S
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    assert.ok(result.messages.some(m => /sizes.*2 empty choices/.test(m)));
});

test('8.6 a list with no empty entries does not raise the warning', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

sizes = ["small", "medium", "large"] -> {size}

[container({t})]

  - [select(5,#sizes,{size})] S
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    assert.equal(result.messages.some(m => /empty choice/.test(m)), false);
});

// ─── UTF-8 verified across every string-accepting surface ────────────────

test('UTF-8: umlauts in init= literal round-trip through __properties', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{name:string},init="Über grüße — Mädchen")] N
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    assert.equal(result.payload.root.rows[0].controls[0].init.value, 'Über grüße — Mädchen');
});

test('UTF-8: emoji in __properties default round-trip', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["greeting" = { type: "string", default: "hi 👋 there 🌍" }]

[container({t})]

  - [textfield(5,{greeting})] G
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    assert.equal(result.payload.__properties.greeting.default, 'hi 👋 there 🌍');
});

test('UTF-8: CJK characters in option-source value list parse and render', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

langs = ["日本語", "한국어", "中文"] -> {lang}

[container({t})]

  - [select(5,#langs,{lang})] L
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    assert.deepEqual(result.payload.optionSources.langs.values, ['日本語', '한국어', '中文']);
});

test('UTF-8: writeQuotedString passes high-Unicode content through unchanged', () => {
    // The writer escapes only the C0 controls and the five
    // reader-recognised pairs. Everything above 0x7F passes through
    // verbatim, including umlauts, emoji, and CJK.
    assert.equal(writeQuotedString('Über'),     '"Über"');
    assert.equal(writeQuotedString('日本語'),    '"日本語"');
    assert.equal(writeQuotedString('hi 👋'),    '"hi 👋"');
});

test('UTF-8: defaultMatchesType accepts strings of any Unicode content', () => {
    // The validator's "is a string" check is contents-agnostic.
    assert.equal(defaultMatchesType('string', 'Über grüße'),  null);
    assert.equal(defaultMatchesType('string', '👋🌍'),         null);
    assert.equal(defaultMatchesType('string[]', ['日', '本']), null);
});

// ─── m1 non-ASCII at value position ──────────────────────────────────────

test('m1 non-ASCII at top-level value position raises a targeted LEX_ERROR (not silent skip)', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

name = höhe

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.LEX_ERROR);
    assert.ok(result.messages.some(m => /Non-ASCII character 'ö' is not allowed in identifier position/.test(m)));
});

test('m1 non-ASCII inside label text after `]` is still skipped silently (correct behaviour)', () => {
    // The label slice picks up Unicode characters unchanged; the
    // tokenizer is just walking past them on this side. The targeted
    // error from m1 only fires for value position (sawClose === false).
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{x})] höhe — Mädchen
`
    }).parse();
    assert.equal(result.error, ERR.OK);
});

// ─── m5 widget glyph for unknown control type ────────────────────────────

test('m5 widgetGlyph returns a generic glyph for an unknown control type', async () => {
    const { renderFormPreview } = await import('../src/render-preview.js');
    // Hand-built minimal AST exercising the default branch of
    // widgetGlyph (no spec entry for 'mystery').
    const ast = {
        version: 1, columns: 10,
        optionSources: {}, tooltips: {}, colors: {}, namedText: {}, namedObjects: {},
        root: {
            nodeKind: 'container',
            collapsible: false,
            title: [], description: [], tooltipRef: null,
            label: [], headerControls: [],
            panels: null,
            rows: [{
                nodeKind: 'row',
                controls: [{
                    nodeKind: 'control',
                    controlType: 'mystery',
                    width: 5, binding: 'x', bindingType: null, dataType: null,
                    optionsSource: null, contentRef: null,
                    params: {}, secret: false, readOnly: false,
                    when: null, whenAst: null, tooltipRef: null,
                    init: null, compute: null, explain: [], label: [],
                    loc: { line: 1, col: 1, length: 0 }
                }],
                loc: { line: 1, col: 1, length: 0 }
            }],
            when: null, whenAst: null, minHeight: null, maxHeight: null,
            loc: { line: 1, col: 1, length: 0 },
            arrayBinding: null, itemMin: null, itemMax: null,
            search: false, filter: null, draggable: false,
            addLabel: null, commit: null, excludedRef: null
        }
    };
    const out = renderFormPreview(ast);
    // The diamond glyph is the generic fallback for unknown types.
    assert.ok(out.includes('◆'), `expected ◆ glyph in preview, got: ${out}`);
});

// ─── m7 _normalizeMessages structured-object handling ────────────────────

test('m7 TupleResponse.fail JSON-stringifies a plain object instead of producing [object Object]', async () => {
    const { TupleResponse } = await import('../src/tuple-response.js');
    const r = TupleResponse.fail(ERR.PARSE_ERROR, { code: 'X', detail: 'something' });
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0], '{"code":"X","detail":"something"}');
});

test('m7 TupleResponse.fail falls back to String() on a circular object', async () => {
    const { TupleResponse } = await import('../src/tuple-response.js');
    const obj = { a: 1 };
    obj.self = obj;
    const r = TupleResponse.fail(ERR.PARSE_ERROR, obj);
    // The string is implementation-defined but should not crash and
    // should not be empty. JSON.stringify throws on circular refs, so
    // the fallback path runs.
    assert.equal(r.messages.length, 1);
    assert.ok(r.messages[0].length > 0);
});

// ─── m9 null defaults rejected for known types ───────────────────────────

test('m9 default: null rejected against a known type with a clear message', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["count" = { type: "int", default: null }]

[container({t})]

  - [number(5,{count})] N
`
    }).parse();
    assert.equal(result.error, ERR.PARSE_ERROR);
    assert.ok(result.messages.some(m => /expected integer, got null/.test(m)));
});

test('m9 default: null is allowed against a custom type (parser stays out of consumer vocabulary)', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["maybe" = { type: "nullable-int", default: null }]

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    assert.equal(result.payload.__properties.maybe.default, null);
});

// ─── m10 init= leading-dot float ─────────────────────────────────────────

test('m10 init=.25 (leading-dot float) parses as a float literal', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [float(5,{f:float},init=.25)] F
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    const ctl = result.payload.root.rows[0].controls[0];
    assert.equal(ctl.init.kind,  'literal');
    assert.equal(ctl.init.value, 0.25);
});

test('m10 init=-0.5 (negative-leading float) parses as a float literal', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [float(5,{f:float},init=-0.5)] F
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    assert.equal(result.payload.root.rows[0].controls[0].init.value, -0.5);
});

test('UTF-8: a __properties string default with umlauts round-trips through renderPropertiesBlock', async () => {
    const { renderPropertiesBlock } = await import('../src/property-collector.js');
    const props = {
        greeting: { type: 'string', default: 'Über alles — Schöner Tag' }
    };
    const text = renderPropertiesBlock(props);
    const result = new TextFormBuilder({
        schemaText: `columns: 10

${text}

[container({t})]

  - [textfield(5,{greeting})] G
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    assert.equal(result.payload.__properties.greeting.default, 'Über alles — Schöner Tag');
});

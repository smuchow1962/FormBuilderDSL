// Regression tests for round-25 parser quality-of-life relaxations.
//
// Two surfaces:
//
// L*  Inline quoted-string param on label / display controls.
//     The control's parens already accept #name to point at a named-
//     text body; this round adds direct inline strings as a third
//     equivalent surface (alongside post-bracket text). Mutual-
//     exclusion guards keep "two sources for one slot" from being
//     ambiguous.
//
// N*  int / float defaults accept a numeric-string literal that
//     parses cleanly. The AST stores the canonical number form via
//     coerceLiteral. Affects __properties block defaults and the
//     control-side init= literal hoist.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TextFormBuilder, ERR, errorName } from '../src/index.js';
import { defaultMatchesType, coerceLiteral } from '../src/parser/literal-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = join(__dirname, '..');
const readFixture = (relPath) => readFileSync(join(repoRoot, relPath), 'utf8');

function parse(text) {
    return new TextFormBuilder({ schemaText: text }).process();
}

function firstControl(ast) {
    return ast?.root?.rows?.[0]?.controls?.[0];
}

// ─── L1..L7: inline string on label control ──────────────────────────────

test('L1 inline string on a label sets the label fragments (post-phase-2 text)', () => {
    const r = parse(`columns: 12
[container("X")]
  - [label(12, "Hello world", style=note)]`);
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    const lbl = firstControl(r.payload);
    assert.equal(lbl.controlType, 'label');
    assert.deepEqual(lbl.label, [{ kind: 'text', text: 'Hello world' }]);
});

test('L2 inline string preserves long-form text including em-dash and unicode', () => {
    const r = parse(`columns: 12
[container("X")]
  - [label(12, "Wire this sink via JSON config — see the per-sink README.", style=note)]`);
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    const lbl = firstControl(r.payload);
    assert.equal(lbl.label[0].text, 'Wire this sink via JSON config — see the per-sink README.');
});

test('L3 inline string and post-bracket text together raise INVALID_PARAM (one source per slot)', () => {
    const r = parse(`columns: 12
[container("X")]
  - [label(12, "Inline", style=note)] Post-bracket`);
    assert.equal(r.error, ERR.INVALID_PARAM);
    assert.match(r.messages.join('\n'), /Inline label text and post-bracket label text both supplied/);
});

test('L4 inline string and #ref together raise INVALID_PARAM', () => {
    const r = parse(`columns: 12
myText = "Named text body"
[container("X")]
  - [label(12, "Inline", #myText, style=note)]`);
    assert.equal(r.error, ERR.INVALID_PARAM);
    assert.match(r.messages.join('\n'), /Inline label text and a '#name' reference both supplied/);
});

test('L5 #ref then inline string raises INVALID_PARAM (symmetric to L4)', () => {
    const r = parse(`columns: 12
myText = "Named text body"
[container("X")]
  - [label(12, #myText, "Inline", style=note)]`);
    assert.equal(r.error, ERR.INVALID_PARAM);
    assert.match(r.messages.join('\n'), /Inline label text and a '#name' reference both supplied/);
});

test('L6 duplicate inline strings raise INVALID_PARAM with the dedicated message', () => {
    const r = parse(`columns: 12
[container("X")]
  - [label(12, "first", "second", style=note)]`);
    assert.equal(r.error, ERR.INVALID_PARAM);
    assert.match(r.messages.join('\n'),
        /Duplicate inline label text on 'label'; one quoted string allowed per declaration/);
});

test('L7 inline string on a control without contentRef:allowed raises a friendly error', () => {
    const r = parse(`columns: 12
[container("X")]
  - [textfield(5, {name}, "should not work")] Name`);
    assert.equal(r.error, ERR.INVALID_PARAM);
    const msg = r.messages.join('\n');
    assert.match(msg, /Inline string parameter is not supported on 'textfield'/);
    assert.match(msg, /put the label text after the closing/);
    // The example in the message points the author at the right shape.
    assert.match(msg, /\[textfield\(5,\{name\}\)\]\s+My label text/);
});

// ─── L8: parser-private flag does not leak into the public AST ───────────

test('L8 _inlineLabelLine is a parser-private marker stripped before the AST is returned', () => {
    const r = parse(`columns: 12
[container("X")]
  - [label(12, "Inline", style=note)]`);
    assert.equal(r.error, ERR.OK);
    const lbl = firstControl(r.payload);
    assert.equal('_inlineLabelLine' in lbl, false,
        'parser-private _inlineLabelLine must not appear on the public AST');
});

// ─── L9: bundled simple-label.mmpform sample parses ──────────────────────

test('L9 editor/samples/simple-label.mmpform parses cleanly with inline string', () => {
    const text = readFixture('editor/samples/simple-label.mmpform');
    const r = new TextFormBuilder({ schemaText: text }).process();
    assert.equal(r.error, ERR.OK,
        `simple-label sample should parse; got ${errorName(r.error)}: ${r.messages.join('\n')}`);
});

// ─── N1..N4: defaultMatchesType accepts numeric-string for int / float ───

test('N1 defaultMatchesType("int", "50") returns null (numeric string accepted)', () => {
    assert.equal(defaultMatchesType('int', '50'), null);
    assert.equal(defaultMatchesType('int', '-7'), null);
    assert.equal(defaultMatchesType('int', '  42  '), null,
        'whitespace around the number must be tolerated');
});

test('N2 defaultMatchesType("int", "3.5") still fails (not an integer)', () => {
    const r = defaultMatchesType('int', '3.5');
    assert.match(r ?? '', /expected integer/);
});

test('N3 defaultMatchesType("float", "3.14") returns null', () => {
    assert.equal(defaultMatchesType('float', '3.14'), null);
    assert.equal(defaultMatchesType('float', '0'), null);
    assert.equal(defaultMatchesType('float', '-0.5'), null);
});

test('N4 defaultMatchesType("float", "abc") still fails', () => {
    const r = defaultMatchesType('float', 'abc');
    assert.match(r ?? '', /expected number/);
});

// ─── N5..N7: coerceLiteral canonicalises to the number form ──────────────

test('N5 coerceLiteral("int", "50") returns the number 50', () => {
    assert.equal(coerceLiteral('int', '50'), 50);
    assert.equal(coerceLiteral('int', '-7'), -7);
    assert.equal(coerceLiteral('int', '  42  '), 42);
});

test('N6 coerceLiteral("float", "3.14") returns the number 3.14', () => {
    assert.equal(coerceLiteral('float', '3.14'), 3.14);
});

test('N7 coerceLiteral passes through non-string inputs and unrelated types', () => {
    assert.equal(coerceLiteral('int', 50), 50);
    assert.equal(coerceLiteral('string', '50'), '50',
        'string-typed default must NOT be coerced to a number');
    assert.equal(coerceLiteral('bool', true), true);
    assert.equal(coerceLiteral('uuid', 'abc-123'), 'abc-123',
        'custom types pass through verbatim');
});

// ─── N8..N10: __properties default coercion at parse time ────────────────

test('N8 __properties int default as quoted string is accepted and stored as number', () => {
    const r = parse(`columns: 12
__properties = ["maxRetained" = { type: "int", default: "50" }]
[container("X")]
  - [number(4, {maxRetained})] Max
`);
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    const props = r.payload.__properties;
    assert.equal(props.maxRetained.default, 50,
        'AST must store the canonical number form, not the string');
    assert.equal(typeof props.maxRetained.default, 'number');
});

test('N9 __properties float default as quoted string is accepted and stored as number', () => {
    const r = parse(`columns: 12
__properties = ["ratio" = { type: "float", default: "3.14" }]
[container("X")]
  - [float(4, {ratio})] Ratio
`);
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    assert.equal(r.payload.__properties.ratio.default, 3.14);
});

test('N10 __properties int default with non-numeric string still raises PARSE_ERROR', () => {
    const r = parse(`columns: 12
__properties = ["bad" = { type: "int", default: "abc" }]
[container("X")]
  - [number(4, {bad})] B
`);
    assert.equal(r.error, ERR.PARSE_ERROR);
    assert.match(r.messages.join('\n'), /expected integer, got string/);
});

// ─── N11: control-side init= against a typed binding coerces too ─────────

test('N11 init="50" on a {name:int} binding is accepted and coerced to 50', () => {
    const r = parse(`columns: 12
[container("X")]
  - [number(4, {count:int}, init="50")] N
`);
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    const ctl = firstControl(r.payload);
    assert.equal(ctl.init.value, 50,
        'init.value must be the canonical number form after coercion');
    assert.equal(typeof ctl.init.value, 'number');
});

// ─── N12: bundled full-example.mmpform parses with the new coercion ─────

test('N12 editor/samples/full-example.mmpform parses cleanly', () => {
    const text = readFixture('editor/samples/full-example.mmpform');
    const r = new TextFormBuilder({ schemaText: text }).process();
    assert.equal(r.error, ERR.OK,
        `full-example sample should parse; got ${errorName(r.error)}: ${r.messages.join('\n')}`);
    // Spot-check: the int defaults from the file are stored as numbers.
    const props = r.payload.__properties;
    assert.equal(props.maxRetainedFiles.default, 50);
    assert.equal(typeof props.maxRetainedFiles.default, 'number');
    assert.equal(props.retentionDays.default, 30);
    assert.equal(typeof props.retentionDays.default, 'number');
});

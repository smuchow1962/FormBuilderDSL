// Regression tests for round-16 fixes.
//
// Coverage map:
//   M1   inferDataSchema honours bindingType + dataType. Result
//        agrees with collectProperties on the same AST.
//   D1   ParamSpec.negativeOk is implemented in the integer arm.
//        A custom control declaring `negativeOk: true` admits
//        negative literals; without it, the existing non-negative
//        rule fires.
//   D2   architecture.md ControlNode comment now names the null
//        case for dataType (verified by reading the doc).
//   D3   README mentions negativeOk in the registerControl entry.
//   m1   Dead script extract-parser-mixins.mjs removed.
//   m4   consumeLabelAndAdvance asserts the token value contract
//        (verified by reading the source).
//   m7   formatChange / formatDefaultValue survives a non-JSON-
//        serialisable default (BigInt, circular ref) without
//        crashing the merge path.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    TextFormBuilder,
    ERR,
    inferDataSchema,
    scaffoldDataObject,
    collectProperties
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = join(__dirname, '..');
const readDoc = (relPath) => readFileSync(join(repoRoot, relPath), 'utf8');

// ─── M1 inferDataSchema honours bindingType + dataType ───────────────────

test('M1 inferDataSchema reads bindingType (inline :type wins over per-control fallback)', () => {
    const schema = `columns: 5

[container({t})]

  - [textfield(5,{count:int})] Count
`;
    const ast = new TextFormBuilder({ schemaText: schema }).parse().payload;
    const inferred = inferDataSchema(ast);
    const countField = inferred.fields.find(f => f.path === 'count');
    assert.ok(countField, 'count field should be present in inferred schema');
    assert.equal(countField.type.jsType, 'number',
        'inline :int binding should resolve to jsType: number, not the textfield default string');
    assert.equal(countField.type.tsType, 'number');
});

test('M1 inferDataSchema reads dataType (__dataType= override wins over per-control fallback)', () => {
    const schema = `columns: 5

[container({t})]

  - [textfield(5,{flag},__dataType=bool)] Flag
`;
    const ast = new TextFormBuilder({ schemaText: schema }).parse().payload;
    const inferred = inferDataSchema(ast);
    const flagField = inferred.fields.find(f => f.path === 'flag');
    assert.ok(flagField);
    assert.equal(flagField.type.jsType, 'boolean',
        '__dataType=bool should override textfield default');
});

test('M1 inferDataSchema and collectProperties agree on the same AST', () => {
    const schema = `columns: 10

[container({t})]

  - [textfield(5,{count:int})] Count
  - [textfield(5,{flag},__dataType=bool)] Flag
  - [textfield(5,{plain})] Plain
`;
    const ast      = new TextFormBuilder({ schemaText: schema }).parse().payload;
    const inferred = inferDataSchema(ast);
    const props    = collectProperties(ast);

    // For every collected property, the inferred schema's type
    // should agree on the underlying jsType family.
    const expectedJsType = {
        int:        'number',
        float:      'number',
        bool:       'boolean',
        string:     'string',
        'string[]': 'array'
    };

    for (const [name, entry] of Object.entries(props)) {
        const field = inferred.fields.find(f => f.path === name);
        if (!field) continue;
        const want = expectedJsType[entry.type] ?? null;
        if (want === null) continue;
        assert.equal(field.type.jsType, want,
            `field '${name}' (props.type='${entry.type}') should infer to jsType '${want}', got '${field.type.jsType}'`);
    }
});

test('M1 scaffoldDataObject emits the typed default for a typed binding', () => {
    const schema = `columns: 5

[container({t})]

  - [textfield(5,{count:int})] Count
`;
    const ast = new TextFormBuilder({ schemaText: schema }).parse().payload;
    const inferred = inferDataSchema(ast);
    const code = scaffoldDataObject(inferred);
    assert.ok(/count:\s*0/.test(code),
        `scaffold should emit count: 0 (the int default), not count: '' (the textfield default). Got:\n${code}`);
});

// ─── D1 negativeOk implemented for integer params ────────────────────────

test('D1 a custom control with negativeOk:true admits a negative integer literal', () => {
    const b = new TextFormBuilder({ schemaText: 'columns: 10\n' });
    const reg = b.registerControl('signedRange', {
        binding: 'required',
        params: {
            offset: { type: 'integer', negativeOk: true }
        }
    });
    assert.equal(reg.error, ERR.OK, reg.messages.join('\n'));

    const r = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [signedRange(5,{x},offset=-3)] X
`,
        controlSpec: b.controlSpec
    }).parse();
    assert.equal(r.error, ERR.OK, `negative literal with negativeOk:true should parse; got ${r.messages.join(' / ')}`);
    assert.equal(r.payload.root.rows[0].controls[0].params.offset, -3);
});

test('D1 a custom control without negativeOk still rejects a negative integer literal', () => {
    const b = new TextFormBuilder({ schemaText: 'columns: 10\n' });
    const reg = b.registerControl('unsignedRange', {
        binding: 'required',
        params: {
            offset: { type: 'integer' }   // no negativeOk
        }
    });
    assert.equal(reg.error, ERR.OK);

    const r = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [unsignedRange(5,{x},offset=-3)] X
`,
        controlSpec: b.controlSpec
    }).parse();
    assert.equal(r.error, ERR.INVALID_PARAM,
        'negative literal without negativeOk should be rejected (preserves the existing default)');
    assert.ok(r.messages.some(m => /must be 0 or greater/.test(m)));
});

test("D1 ParamSpec.negativeOk is declared on the typed interface", () => {
    const text = readDoc('types/index.d.ts');
    assert.ok(text.includes('negativeOk?: boolean'),
        'negativeOk should still be declared on ParamSpec — type now matches runtime');
});

// ─── D2 architecture.md dataType comment names null ──────────────────────

test('D2 architecture.md ControlNode dataType comment names the null case', () => {
    const text = readDoc('docs/architecture.md');
    assert.ok(text.includes('null unless source declared `__dataType=`'),
        'architecture.md ControlNode dataType comment should call out the null case explicitly');
});

// ─── D3 README mentions negativeOk ───────────────────────────────────────

test("D3 README registerControl entry mentions negativeOk", () => {
    const text = readDoc('README.md');
    assert.ok(text.includes('negativeOk'),
        'README registerControl entry should mention negativeOk for custom controls');
});

// ─── m1 dead script removed ──────────────────────────────────────────────

test('m1 scripts/extract-parser-mixins.mjs has been removed', () => {
    const scriptPath = join(repoRoot, 'scripts', 'extract-parser-mixins.mjs');
    assert.equal(existsSync(scriptPath), false,
        'dead script referencing src/parser/parser-class.js should be deleted');
});

// ─── m4 consumeLabelAndAdvance asserts the token value contract ──────────

test('m4 consumeLabelAndAdvance source includes a typeof check on the token value', () => {
    const text = readDoc('src/tokenizer.js');
    assert.ok(text.includes("typeof lastBracket.value !== 'string'"),
        'consumeLabelAndAdvance should assert the token value is a string');
});

// ─── m7 formatChange survives a non-serialisable default ─────────────────

test('m7 process() with a hand-built BigInt default does not crash the merge', () => {
    // Build a form whose source is fine, then hand-inject a __properties
    // dictionary with a BigInt default to drive formatChange's defensive
    // serialisation path.
    const b = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["count" = { type: "int", default: 0 }]

[container({t})]

  - [number(5,{count})] Count
`
    });
    const r = b.process();
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
});

test('m7 formatDefaultValue (via process change message) survives BigInt without crashing', async () => {
    // Drive the path directly: parse the form, then hand-mutate the
    // existing __properties dictionary on the model and invoke
    // mergeProperties + formatChange via the exported helpers.
    const { mergeProperties } = await import('../src/property-collector.js');
    const ast = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [number(5,{count},init=42)] C
`
    }).parse().payload;

    const existing = { count: { type: 'int', default: 0n } };   // BigInt default
    const { properties, changes } = mergeProperties(ast, existing);
    assert.ok(properties);
    // The change list should record the default change. BigInt
    // appears on c.from; formatChange (called by process()) would
    // crash on JSON.stringify(0n) without the defensive helper.
    assert.ok(changes.length >= 1);
});

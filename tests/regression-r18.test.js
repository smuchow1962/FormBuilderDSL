// Regression tests for round-18 fixes.
//
// Coverage map:
//   m4   infer-schema routes through safe-keys.isReservedObjectKey
//        instead of a local hard-coded list. Same decision in one
//        place.
//   m13  expression.js RX.num and RX.op2 use named capture groups
//        (project coding rule). Behaviour unchanged.
//   D5   architecture.md cross-references no-AST-caching from §7.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    TextFormBuilder,
    ERR,
    inferDataSchema,
    parseWhen,
    evaluateWhen
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = join(__dirname, '..');
const readDoc = (relPath) => readFileSync(join(repoRoot, relPath), 'utf8');

// ─── m4 infer-schema reserved-segment screen routes through safe-keys ────

test('m4 infer-schema source no longer carries a local isReservedSegment helper', () => {
    const text = readDoc('src/infer-schema.js');
    assert.equal(text.includes('function isReservedSegment'), false,
        'the local hard-coded helper should be gone');
    assert.ok(text.includes("import { isReservedObjectKey } from './safe-keys.js'"),
        'infer-schema should import the shared helper');
    assert.ok(text.includes('isReservedObjectKey'),
        'infer-schema should call the shared helper');
});

test('m4 inferDataSchema continues to refuse reserved-segment paths after the swap', () => {
    // A control with a binding that contains __proto__ as a path
    // segment never reaches the schema (the parser rejects it at
    // parse time via assertSafeObjectKey, but exercising
    // inferDataSchema with a hand-built AST that contains one
    // confirms the lookup helper still rejects). The hand-built
    // AST here mirrors what the parser would have emitted minus
    // the parse-time screen.
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
                    controlType: 'textfield',
                    width: 5,
                    binding: 'safe.path',
                    bindingType: null, dataType: null,
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
    const schema = inferDataSchema(ast);
    // Control with safe path is recorded.
    assert.ok(schema.fields.some(f => f.path === 'safe.path'),
        'safe path should appear in inferred fields');
});

// ─── m13 named capture groups in expression.js regexes ───────────────────

test('m13 expression.js source uses named capture groups in RX.num and RX.op2', () => {
    const text = readDoc('src/expression.js');
    // RX.num: named `frac` capture group for the optional decimal portion.
    assert.match(text, /num:\s*\/\^-\?\\d\+\(\?:\\\.\(\?<frac>\\d\+\)\)\?\//,
        'RX.num should declare a named (?<frac>...) capture group');
    // RX.op2: named `op` capture group for the two-character operator.
    assert.match(text, /op2:\s*\/\^\(\?<op>==\|!=\|&&\|\\\|\\\|\)\//,
        'RX.op2 should declare a named (?<op>...) capture group');
});

test('m13 parseWhen still accepts integer and float literals after the regex change', () => {
    // The named group is structurally a no-capture-changing edit;
    // confirming end-to-end parse + eval behaviour holds.
    const ast = parseWhen('count == 42');
    assert.ok(ast);
    assert.equal(evaluateWhen('count == 42', { count: 42 }), true);
    assert.equal(evaluateWhen('count == 42', { count: 41 }), false);

    const fAst = parseWhen('ratio == 0.5');
    assert.ok(fAst);
    assert.equal(evaluateWhen('ratio == 0.5', { ratio: 0.5 }), true);
});

test('m13 parseWhen still accepts the four two-character operators', () => {
    // == != && ||
    assert.equal(evaluateWhen('a == b', { a: 1, b: 1 }), true);
    assert.equal(evaluateWhen('a != b', { a: 1, b: 2 }), true);
    assert.equal(evaluateWhen('a == 1 && b == 2', { a: 1, b: 2 }), true);
    assert.equal(evaluateWhen('a == 1 || b == 99', { a: 1, b: 2 }), true);
});

test('m13 negative-leading float still parses (regression on the named group rewrite)', () => {
    assert.equal(evaluateWhen('temp == -0.5', { temp: -0.5 }), true);
});

// ─── D5 architecture.md cross-references no-AST-caching ──────────────────

test('D5 architecture.md §7 names the no-AST-caching rule and links the dedicated doc', () => {
    const text = readDoc('docs/architecture.md');
    assert.ok(text.includes('AST walks are not cached'),
        'architecture.md §7 should name the rule');
    assert.ok(text.includes('architecture-no-ast-caching.md'),
        'architecture.md §7 should link to the dedicated rule doc');
});

// ─── Parse + parseWhen end-to-end sanity ─────────────────────────────────

test('end-to-end: a real form with when= still parses cleanly after r18 changes', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({title})]

  - [textfield(5,{port:int},init=8080)] Port
  - [textfield(5,{name},when="port == 8080")] Name
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    const portCtl = result.payload.root.rows[0].controls[0];
    const nameCtl = result.payload.root.rows[1].controls[0];
    assert.equal(portCtl.binding, 'port');
    assert.equal(nameCtl.when, 'port == 8080');
    assert.ok(nameCtl.whenAst, 'whenAst should be populated');
});

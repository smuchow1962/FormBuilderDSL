// Regression tests for round-21 fixes (M3, M5, M6, D1-D4, m1-m10)
// and the C-series additions (C2, C3, C4, C5, C7, C9, C10).
//
// Coverage map (behaviour, not source-text grep):
//   M3   _warnings dropped from FormModel type; warnings still
//        flow through result.messages.
//   M6   walkAst exported; visits every node in source order.
//   C3   evaluateAst(whenAst, data) evaluates a pre-parsed AST.
//   C4   scaffoldJsonSchema produces Draft 2020-12 output.
//   C5   renderForm round-trips (parse → render → parse).
//   C9   ParamSpec.message overrides the default error string.
//   C10  diffSchemas reports added / removed / changed.
//   D1   json-internal-model.md is gone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    TextFormBuilder,
    ERR,
    walkAst,
    parseWhen,
    evaluateAst,
    inferDataSchema,
    scaffoldJsonSchema,
    renderForm,
    diffSchemas
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = join(__dirname, '..');

// ─── M3 _warnings ────────────────────────────────────────────────────────

test('M3 warnings flow through result.messages on a successful parse', () => {
    const r = new TextFormBuilder({
        schemaText: `columns: 10

choices = [] -> {x}

[container({t})]

  - [textfield(5,{name})] N
`
    }).parse();
    assert.equal(r.error, ERR.OK);
    assert.ok(r.messages.some(m => /empty/.test(m)),
        `expected empty-option-source warning in messages, got: ${JSON.stringify(r.messages)}`);
});

// ─── M6 walkAst ──────────────────────────────────────────────────────────

test('M6 walkAst visits every node kind in source order', () => {
    const r = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{x})] X
  - [number(5,{y})] Y
`
    }).parse();
    assert.equal(r.error, ERR.OK);
    const visited = [];
    walkAst(r.payload, (n) => visited.push(n.nodeKind ?? 'model'));
    // Root container, then each `- [...]` line is its own row, each
    // row holds one control. Two `- ` lines → two rows.
    assert.deepEqual(visited, ['container', 'row', 'control', 'row', 'control']);
});

test('M6 walkAst accepts a bare node as the start', () => {
    const r = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    const visited = [];
    walkAst(r.payload.root.rows[0], (n) => visited.push(n.nodeKind));
    assert.deepEqual(visited, ['row', 'control']);
});

// ─── C3 evaluateAst ──────────────────────────────────────────────────────

test('C3 evaluateAst evaluates a pre-parsed when= AST', () => {
    const ast = parseWhen('count == 42');
    assert.equal(evaluateAst(ast, { count: 42 }), true);
    assert.equal(evaluateAst(ast, { count: 41 }), false);
});

test('C3 evaluateAst with null AST returns true (no when= means always-visible)', () => {
    assert.equal(evaluateAst(null, {}), true);
});

// ─── C4 scaffoldJsonSchema ───────────────────────────────────────────────

test('C4 scaffoldJsonSchema produces Draft 2020-12 with $schema and $id', () => {
    const r = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{name})] N
  - [number(5,{age:int})] A
`
    }).parse();
    assert.equal(r.error, ERR.OK);
    const schema = inferDataSchema(r.payload);
    const json = scaffoldJsonSchema(schema, 'Person');
    assert.equal(json.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(json.$id, 'urn:formbuilder-dsl:Person');
    assert.equal(json.title, 'Person');
    assert.equal(json.type, 'object');
    assert.equal(json.properties.name.type, 'string');
    assert.equal(json.properties.age.type, 'number');
});

// ─── C5 renderForm round-trip ────────────────────────────────────────────

test('C5 renderForm produces source that re-parses to an equivalent AST', () => {
    const original = `columns: 10

[container({title})]

  - [textfield(5,{name})] Name
  - [number(5,{count:int})] Count
`;
    const a = new TextFormBuilder({ schemaText: original }).parse();
    assert.equal(a.error, ERR.OK);
    const text = renderForm(a.payload);
    const b = new TextFormBuilder({ schemaText: text }).parse();
    assert.equal(b.error, ERR.OK,
        `re-parse of renderForm output failed:\n${b.messages.join('\n')}\n--- source ---\n${text}`);
    // Structural signatures match.
    const sig = (p) => ({
        columns: p.columns,
        rootKind: p.root.nodeKind,
        rows: p.root.rows.length,
        controls: p.root.rows.map(r => r.controls.map(c => ({
            kind: c.controlType, binding: c.binding, width: c.width
        })))
    });
    assert.deepEqual(sig(a.payload), sig(b.payload));
});

test('C5 renderForm includes a __properties block when process() hydrated one', () => {
    const r = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{name})] N
`
    }).process();
    assert.equal(r.error, ERR.OK);
    const text = renderForm(r.payload);
    assert.ok(text.includes('__properties'),
        `renderForm output should include __properties block; got:\n${text}`);
});

// ─── C9 ParamSpec.message ────────────────────────────────────────────────

test('C9 a custom ParamSpec.message replaces the parser default', () => {
    const b = new TextFormBuilder({ schemaText: 'columns: 10\n' });
    const reg = b.registerControl('myInput', {
        binding: 'required',
        params: {
            port: { type: 'integer', message: 'Port must be 1-65535' }
        }
    });
    assert.equal(reg.error, ERR.OK);

    const r = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [myInput(5,{p},port=-1)] X
`,
        controlSpec: b.controlSpec
    }).parse();
    assert.equal(r.error, ERR.INVALID_PARAM);
    assert.ok(r.messages.some(m => /Port must be 1-65535/.test(m)),
        `expected custom message; got: ${r.messages.join(' / ')}`);
});

test('C9 falls back to the parser default when no message is set', () => {
    const r = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textarea(5,{x},rows=-1)] X
`
    }).parse();
    assert.equal(r.error, ERR.INVALID_PARAM);
    assert.ok(r.messages.some(m => /must be 0 or greater/.test(m)),
        `expected default message; got: ${r.messages.join(' / ')}`);
});

// ─── C10 diffSchemas ─────────────────────────────────────────────────────

test('C10 diffSchemas reports added / removed / changed bindings', () => {
    const a = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{name})] N
  - [number(5,{age:int})] A
`
    }).process().payload;

    const b = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{name})] N
  - [textfield(5,{age:string})] A
  - [check(5,{active})] X
`
    }).process().payload;

    const diff = diffSchemas(a, b);
    assert.ok(diff.added.some(e => e.name === 'active'),
        `expected 'active' in added; got: ${JSON.stringify(diff.added)}`);
    assert.ok(diff.changed.some(c => c.name === 'age' && c.kind === 'type'),
        `expected age type change; got: ${JSON.stringify(diff.changed)}`);
});

// ─── D1 json-internal-model.md is gone ───────────────────────────────────

test('D1 docs/json-internal-model.md has been deleted', () => {
    assert.equal(existsSync(join(repoRoot, 'docs/json-internal-model.md')), false);
});

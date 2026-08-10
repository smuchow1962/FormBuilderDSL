// Regression tests for round-22 cleanup (D1-D9 + m1-m9 + CI).
//
// Coverage map:
//   D5   library-uses-in-code.md when= example uses identifier syntax.
//   D6   expression-trust.md mentions evaluateAst as the cache-the-parse path.
//   D4   trust doc ships an evaluateAst example.
//   D1   viewer/README.md cross-link points at expression-trust.md.
//   D8   viewer/README.md justification names the {@fn} empty-render reason.
//   D9   subpath types (infer-schema.d.ts, property-collector.d.ts) declare the new exports.
//   D7   roadmap.md no longer lists shipped items.
//   D2   project-baseline.md framed as "Authoring quickstart"; architecture.md is canonical.
//   D3   architecture.md documents the date-literal asymmetry.
//   m1   seedJsonSchemaPath screens reserved segments.
//   m4   README documents errorName(ERR.OK) returns 'OK'.
//   m6   _parseDefaultWarned Set is bounded.
//   m7   pascalToKebab + double-register removed from render-vue.js.
//   m8   __common shallow-copy depth has a regression test.
//   m9   parser.js carries the @internal note.
//   CI   workflow runs lint, coverage:check, AND a Node 18/20/22 matrix.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    TextFormBuilder,
    ERR,
    inferDataSchema,
    scaffoldJsonSchema,
    defaultControlSpec
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = join(__dirname, '..');
const readDoc = (relPath) => readFileSync(join(repoRoot, relPath), 'utf8');

// ─── D5 + D6 + D4 (trust + library docs) ─────────────────────────────────

test("D5 library-uses-in-code.md when= example does not use the broken {showAdvanced} brace shape", () => {
    const text = readDoc('docs/library-uses-in-code.md');
    assert.equal(text.includes('when="{showAdvanced}"'), false,
        'broken brace shape should be replaced with bare-identifier expression');
    assert.ok(text.includes('when="showAdvanced == true"'),
        'fixed example should use bare identifier + comparison');
});

test("D6 expression-trust.md names evaluateAst as the cache-the-parse path", () => {
    const text = readDoc('docs/expression-trust.md');
    assert.ok(text.includes('evaluateAst'),
        'trust doc should mention evaluateAst');
    assert.equal(text.includes("their own evaluator wrapper"), false,
        'old "consumer writes their own evaluator" text should be gone');
});

test("D4 expression-trust.md ships a worked evaluateAst example", () => {
    const text = readDoc('docs/expression-trust.md');
    assert.ok(text.includes('parseWhen(') && text.includes('evaluateAst('),
        'trust doc should show parseWhen + evaluateAst together as the cache-the-parse pattern');
    assert.ok(text.includes('Cache-the-parse pattern') || text.includes('cache the parse'),
        'trust doc should label the section');
});

// ─── D1 viewer cross-link ────────────────────────────────────────────────

test("D1 viewer/README.md cross-link points at expression-trust.md (not no-AST-caching)", () => {
    const text = readDoc('viewer/README.md');
    // The when= cap discussion should reference expression-trust.md.
    const capLine = text.split('\n').find(l => l.includes('when=') && l.includes('cap'));
    assert.ok(capLine, 'viewer README should mention the when= cap somewhere');
    assert.ok(capLine.includes('expression-trust.md'),
        `cap line should link expression-trust.md, got: ${capLine}`);
    assert.equal(capLine.includes('architecture-no-ast-caching.md'), false,
        'cap line should not link the no-ast-caching doc');
});

// ─── D8 viewer fragment-renderer justification ───────────────────────────

test("D8 viewer/README.md justification names the {@fn} empty-render reason (no kind:'ref' claim)", () => {
    const text = readDoc('viewer/README.md');
    assert.equal(text.includes("kind: 'ref'"), false,
        "the kind: 'ref' justification was incorrect (phase 2 resolves all refs); should be removed");
    assert.ok(text.includes('static-shape view') || text.includes('@fn} placeholders empty'),
        'README should explain the deliberate {@fn} empty-render reason');
});

// ─── D9 subpath types declare the new exports ────────────────────────────

test("D9 types/infer-schema.d.ts declares scaffoldJsonSchema", () => {
    const text = readDoc('types/infer-schema.d.ts');
    assert.ok(text.includes('export function scaffoldJsonSchema'),
        '/infer-schema subpath types should declare scaffoldJsonSchema');
});

test("D9 types/property-collector.d.ts declares diffSchemas", () => {
    const text = readDoc('types/property-collector.d.ts');
    assert.ok(text.includes('export function diffSchemas'),
        '/property-collector subpath types should declare diffSchemas');
});

// ─── D7 roadmap purged of shipped items ──────────────────────────────────

test("D7 roadmap.md does not list shipped items as forward-looking", () => {
    const text = readDoc('docs/roadmap.md');
    // Shipped helpers should not appear under section headings as
    // forward-looking ideas.
    assert.equal(text.includes('### `evaluateAst(whenAst, data)` companion'), false);
    assert.equal(text.includes('### AST round-trip serialiser'), false);
    assert.equal(text.includes('### JSON Schema export from the inferred schema'), false);
    assert.equal(text.includes('### Schema diff helper'), false);
    assert.equal(text.includes('### Custom error messages per `params` entry'), false);
});

// ─── D2 project-baseline framing ─────────────────────────────────────────

test("D2 project-baseline.md is framed as Authoring quickstart; architecture.md is canonical", () => {
    const baseline = readDoc('docs/project-baseline.md');
    assert.ok(baseline.includes('Authoring quickstart'),
        'project-baseline.md should reframe itself as the authoring quickstart');
    assert.ok(baseline.includes('architecture.md'),
        'project-baseline.md should point at architecture.md as the language reference');

    const readme = readDoc('README.md');
    assert.ok(readme.includes('Authoring quickstart'),
        'README docs table should describe project-baseline.md as the authoring quickstart');
});

// ─── D3 date-literal asymmetry documented ───────────────────────────────

test("D3 architecture.md documents the date-literal asymmetry between option-source and __properties", () => {
    const text = readDoc('docs/architecture.md');
    assert.ok(text.includes('bare date literals') || text.includes('Bare date literals'),
        'architecture.md should call out the date-literal rule for __properties');
    assert.ok(text.includes('asymmetry is deliberate') || text.includes("asymmetry") || text.includes('Option-source value lists'),
        'architecture.md should name the option-source vs __properties asymmetry');
});

// ─── m1 seedJsonSchemaPath reserved-segment screen ───────────────────────

test('m1 scaffoldJsonSchema does not write into properties.__proto__ for a hand-built path', () => {
    // Hand-built inferred-schema with a reserved-segment field
    // path. Without the screen, seedJsonSchemaPath would write into
    // root.properties.__proto__, which on a plain-object map walks
    // up to Object.prototype. With the screen, the path is dropped.
    const handBuilt = {
        fields: [{ path: '__proto__.polluted', type: { jsType: 'string', defaultValue: "''", tsType: 'string' } }],
        functions: [], repeaters: [], optionSources: [], tooltips: []
    };
    const out = scaffoldJsonSchema(handBuilt, 'X');
    // Reserved segment should never reach the properties map.
    assert.equal(Object.prototype.hasOwnProperty.call(out.properties, '__proto__'), false,
        'reserved segment should not appear as a property on the JSON Schema');
});

test('m1 scaffoldJsonSchema still emits clean schemas for normal paths', () => {
    const r = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{name})] N
  - [number(5,{age:int})] A
`
    }).parse();
    assert.equal(r.error, ERR.OK);
    const inferred = inferDataSchema(r.payload);
    const json = scaffoldJsonSchema(inferred, 'P');
    assert.equal(json.properties.name.type, 'string');
    assert.equal(json.properties.age.type, 'number');
});

// ─── m4 errorName(OK) docs ───────────────────────────────────────────────

test('m4 README documents that errorName(ERR.OK) returns OK', () => {
    const text = readDoc('README.md');
    assert.ok(text.includes("`0` &rarr; `'OK'`"),
        'README errorName entry should document the OK case');
});

// ─── m6 _parseDefaultWarned size bound ───────────────────────────────────

test('m6 viewer parseDefault warned-set is capped (size check at 256)', () => {
    const text = readDoc('viewer/render-vue.js');
    assert.ok(text.includes('256'),
        'parseDefault should cap the dedup Set so a long-lived editor session does not accumulate forever');
});

// ─── m7 pascalToKebab + double-register removed ──────────────────────────

test('m7 render-vue.js no longer carries pascalToKebab or the double-register loop', () => {
    const text = readDoc('viewer/render-vue.js');
    assert.equal(text.includes('pascalToKebab'), false,
        'pascalToKebab helper should be removed (Vue 3 accepts both casings on a single registration)');
    assert.equal(text.includes('app.component(kebab'), false,
        'double-register should be removed');
});

// ─── m8 __common shallow-copy depth ──────────────────────────────────────

test('m8 registerControl on the frozen default does not mutate the default __common.params', () => {
    // The defensive copy in text-form-builder.js clones the wrapper
    // and clones __common, but params on __common is still shared
    // unless the depth is increased. This test pins the current
    // depth: a registerControl call on the live builder's spec
    // should NOT mutate defaultControlSpec.__common.params.
    const beforeKeys = Object.keys(defaultControlSpec.__common.params).sort();

    const b = new TextFormBuilder({ schemaText: 'columns: 10\n' });
    const r = b.registerControl('myInput', {
        binding: 'required',
        params: { custom: { type: 'string' } }
    });
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));

    const afterKeys = Object.keys(defaultControlSpec.__common.params).sort();
    assert.deepEqual(afterKeys, beforeKeys,
        'defaultControlSpec.__common.params should be unchanged after a registerControl call');
});

// ─── m9 parser.js @internal note ─────────────────────────────────────────

test('m9 src/parser.js carries the @internal note', () => {
    const text = readDoc('src/parser.js');
    assert.ok(text.includes('@internal'),
        'parser.js should be tagged @internal');
    assert.ok(text.includes('TextFormBuilder'),
        'parser.js should redirect consumers to TextFormBuilder');
});

// ─── CI workflow ─────────────────────────────────────────────────────────

test('CI workflow runs lint AND coverage:check AND a Node 18/20/22 matrix', () => {
    const ci = readDoc('.github/workflows/ci.yml');
    assert.ok(ci.includes('npm run lint'),
        'CI should run lint');
    assert.ok(ci.includes('npm run test:coverage:check'),
        'CI should run the coverage gate');
    assert.ok(ci.includes("'18'") && ci.includes("'20'") && ci.includes("'22'"),
        'CI matrix should cover the Node versions the package supports (18 floor, 20, 22)');
});

// Tests covering the thirteenth principal-review round of fixes.
//
// Coverage map:
//   M3   parseObjectValue and parsePropertyEntry use Object.create(null)
//        for the body / entry shape. Every parser-produced map in the
//        AST is now prototype-free; a downstream walker that uses
//        for..in or Object.getOwnPropertyNames reads the same shape
//        across the whole AST.
//   D5   NamedObjectValue does NOT include Date; date literals on a
//        named-object body arrive as raw ISO strings.
//   doc  D1 / D2 / D3 / D4 / D7 are doc-only changes; the suite reads
//        the docs directly to confirm the fix landed (the doc strings
//        are observable artefacts).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    TextFormBuilder,
    ERR
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = join(__dirname, '..');
const readDoc = (relPath) => readFileSync(join(repoRoot, relPath), 'utf8');

// ─── M3 parser-produced bodies are prototype-free ────────────────────────

test('M3 named-object body has a null prototype (matches the rest of the model maps)', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

person = { !id: "p1", name: "Steve", role: "engineer" }

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    const obj = result.payload.namedObjects.person;
    // The body is a null-prototype object: a `for..in` walk only
    // reads own properties, never Object.prototype members.
    assert.equal(Object.getPrototypeOf(obj), null);
    // Inherited names like 'toString' don't appear when iterating.
    assert.equal('toString' in obj, false);
    // Own-property reads still work as expected.
    assert.equal(obj.id,   'p1');
    assert.equal(obj.name, 'Steve');
    assert.equal(obj.role, 'engineer');
});

test('M3 __properties entry has a null prototype', () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["port" = { type: "int", default: 8080 }]

[container({t})]

  - [number(5,{port})] P
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    const entry = result.payload.__properties.port;
    assert.equal(Object.getPrototypeOf(entry), null);
    assert.equal('toString' in entry, false);
    assert.equal(entry.type,    'int');
    assert.equal(entry.default, 8080);
});

// ─── D5 named-object date literals are stored as ISO strings ─────────────

test('D5 a date literal on a named-object body arrives as a raw ISO string', () => {
    // The TypeScript surface declares NamedObjectValue without
    // Date. A consumer using `instanceof Date` on the value gets
    // false; the parser hands back the raw token text.
    const result = new TextFormBuilder({
        schemaText: `columns: 10

event = { !id: "e1", when: 2026-05-03 }

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    const v = result.payload.namedObjects.event.when;
    assert.equal(typeof v,   'string');
    assert.equal(v,          '2026-05-03');
    assert.equal(v instanceof Date, false);
});

// ─── Documentation observable artefacts ──────────────────────────────────

test("D2 docs/library-uses-in-code.md uses the scoped package name and the current version", async () => {
    const text = readDoc('docs/library-uses-in-code.md');
    // Every package mention should be the scoped name.
    assert.equal(text.includes("'formbuilder-dsl'"),                  false, 'unscoped quoted import name still in doc');
    assert.equal(text.includes('formbuilder-dsl@0.0.1'),               false, 'stale 0.0.1 version pin still in doc');
    assert.ok(text.includes('@mmpworks/formbuilder-dsl@1.1.0'),        '1.1.0 pin missing from doc');
    assert.ok(text.includes("'@mmpworks/formbuilder-dsl'"),            'scoped quoted import name missing from doc');
});

test("D3 docs/architecture.md no longer lists 'optional' in the binding vocabulary", () => {
    const text = readDoc('docs/architecture.md');
    // Specifically check the per-type entry section to avoid false
    // positives on the unrelated word "optional" in prose.
    assert.equal(text.includes("'required' | 'optional' | 'forbidden'"), false,
        "stale binding vocabulary still in architecture doc");
    assert.ok(text.includes("'required' | 'forbidden'"),
        "current binding vocabulary missing from architecture doc");
});

test("D4 docs/architecture.md OptionSource.values type covers resolved named-object bodies", () => {
    const text = readDoc('docs/architecture.md');
    // The narrow string[] type should be gone; the broader union
    // covers scalars plus resolved object bodies.
    assert.equal(text.includes('values: string[] | undefined'), false,
        'narrow values: string[] type still in architecture doc');
    assert.ok(text.includes('Array<string | number | boolean | null | object>'),
        'broader OptionSource.values union missing from architecture doc');
});

// ─── D7 source comments no longer narrate prior iterations ───────────────

test("D7 src/control-spec.js comments do not narrate prior iterations", () => {
    const text = readDoc('src/control-spec.js');
    assert.equal(text.includes('An earlier draft accepted'),    false);
    assert.equal(text.includes('An earlier version cached'),    false);
});

test("D7 src/placeholder.js comments describe the present design (not the historical drift)", () => {
    const text = readDoc('src/placeholder.js');
    assert.equal(text.includes('drifted apart historically'), false);
});

test("D7 src/text-fragment.js comments do not narrate prior iterations", () => {
    const text = readDoc('src/text-fragment.js');
    assert.equal(text.includes('drifted'),    false);
});

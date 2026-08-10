// Auto-discovered tests for editor/samples/*.mmpform.
//
// Every .mmpform file in editor/samples/ must:
//   1. parse to ERR.OK
//   2. infer a data schema without throwing
//
// New samples added to the directory are picked up on the next test
// run — there is no hand-maintained list to keep in sync. The viewer's
// bundled-sample loader (viewer.js: fetch('../editor/samples/*.mmpform'))
// reads from this same directory, so the tests gate exactly what the
// editor will hand the parser at startup. A regression that breaks
// any sample also breaks the editor's first-paint experience, which is
// what this suite is designed to catch.
//
// The discovery runs at module load (synchronously, via readdirSync)
// so each file gets its own top-level node:test entry in the output —
// failures name the offending sample directly instead of hiding behind
// a single rolled-up assertion.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TextFormBuilder, ERR, errorName, inferDataSchema } from '../src/index.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const samplesDir = join(__dirname, '..', 'editor', 'samples');

// Discover every .mmpform file at module load. Sorting keeps the
// reported test order stable across operating systems (readdirSync
// returns insertion order on some filesystems and lexical on others;
// pinning here means CI output is reproducible).
const SAMPLES = readdirSync(samplesDir)
    .filter((name) => name.endsWith('.mmpform'))
    .sort();

// A defensive guard: if the samples directory ever empties out, the
// suite would silently pass with zero tests registered. That's the
// kind of "green for the wrong reason" outcome a CI gate is supposed
// to catch, so register one assertion that fails if there are no
// samples to test.
test('editor/samples contains at least one .mmpform fixture', () => {
    assert.ok(SAMPLES.length > 0,
        `expected one or more *.mmpform files in ${samplesDir}, found 0`);
});

for (const name of SAMPLES) {
    test(`sample ${name} parses cleanly + infers a data schema`, () => {
        const text = readFileSync(join(samplesDir, name), 'utf8');
        const result = new TextFormBuilder({ schemaText: text }).process();

        // Parse failures dump every diagnostic into the assertion
        // message so a CI log shows the actual reason without making
        // the developer re-run the file locally to see what broke.
        assert.equal(
            result.error,
            ERR.OK,
            `${name}: parse failed (${errorName(result.error)})\n  ${result.messages.join('\n  ')}`
        );

        // inferDataSchema is the contract the editor relies on the
        // moment a parse succeeds (the Object View tab calls it on
        // every Process pass). A throw here means the form parses but
        // the editor would crash on render — exactly the regression
        // class this suite is designed to catch.
        let schema;
        assert.doesNotThrow(
            () => { schema = inferDataSchema(result.payload); },
            `${name}: inferDataSchema threw on a successful parse`
        );

        // The shape contract is small: fields and functions arrays
        // must exist. The viewer's renderer iterates them and would
        // throw on undefined; pinning the shape here surfaces the
        // schema-builder regression at the schema layer instead of
        // at the renderer.
        assert.ok(Array.isArray(schema.fields),
            `${name}: inferDataSchema did not return fields[]`);
        assert.ok(Array.isArray(schema.functions),
            `${name}: inferDataSchema did not return functions[]`);
    });
}

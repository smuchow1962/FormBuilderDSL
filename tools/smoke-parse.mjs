#!/usr/bin/env node
//
// smoke-parse.mjs — verify a folder of .mmpform files parses cleanly
// through the FormBuilderDSL public API and reports per-file tooltip
// counts so a maintainer can confirm tooltip blocks survived a
// round-trip.
//
// Usage:
//
//   node tools/smoke-parse.mjs <dir>
//
// The directory argument is required. Resolves the FormBuilderDSL
// import via the package's own `src/` so the tool runs against the
// in-tree source — no install needed. Exits non-zero if any file
// fails to parse, so it's safe to wire into a pre-commit hook or CI
// check next to a manifest folder.
//
// Field reference (per src/parser/parse.js):
//   result.payload.tooltips           — resolved tooltip text by key
//   result.payload.optionSources      — `name = [...]` declarations
//   result.payload.namedText          — `name = "literal"` declarations
//   result.payload.controls / nodes   — the form tree
//
// `_rawTooltips` is a parser scratch field and is deleted before the
// model is returned; do not probe it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// tools/ sits inside the package; the public API is reachable through
// the package's own src/index.js without going through node_modules.
const PKG_INDEX = resolve(HERE, '..', 'src', 'index.js');
const FB = await import(pathToFileURL(PKG_INDEX).href);

const targetArg = process.argv[2];
if (!targetArg) {
    console.error('usage: node tools/smoke-parse.mjs <dir>');
    process.exit(2);
}

const target = resolve(process.cwd(), targetArg);
let stat;
try {
    stat = statSync(target);
} catch (e) {
    console.error('not a directory: ' + target);
    process.exit(2);
}
if (!stat.isDirectory()) {
    console.error('not a directory: ' + target);
    process.exit(2);
}

const manifests = readdirSync(target)
    .filter(function (n) { return n.endsWith('.mmpform'); })
    .sort();

if (manifests.length === 0) {
    console.error('no .mmpform files found in ' + target);
    process.exit(2);
}

let okCount = 0;
let failCount = 0;
let withTooltips = 0;

for (const name of manifests) {
    const text = readFileSync(join(target, name), 'utf8');
    const result = new FB.TextFormBuilder({ schemaText: text }).parse();

    if (result.error !== FB.ERR.OK) {
        failCount++;
        const errName = (FB.errorName && FB.errorName(result.error)) || result.error;
        console.error('FAIL ' + name + ': ' + errName);
        for (const m of result.messages) {
            console.error('  ' + m);
        }
        continue;
    }

    okCount++;
    const tipMap = result.payload && result.payload.tooltips;
    const tipCount = tipMap ? Object.keys(tipMap).length : 0;
    if (tipCount > 0) withTooltips++;
    console.log('OK   ' + name + '  tooltips=' + tipCount);
}

console.log('');
console.log(okCount + ' ok, ' + failCount + ' fail, ' + withTooltips + ' with tooltips');
process.exit(failCount > 0 ? 1 : 0);

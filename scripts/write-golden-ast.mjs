import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TextFormBuilder, ERR } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const smokePath = path.join(root, 'tests', 'smoke.js');
const smoke = fs.readFileSync(smokePath, 'utf8');
const start = smoke.indexOf('const FULL_EXAMPLE = `');
if (start < 0) throw new Error('FULL_EXAMPLE not found');
const from = start + 'const FULL_EXAMPLE = `'.length;
const end = smoke.indexOf('`;', from);
if (end < 0) throw new Error('FULL_EXAMPLE end not found');
const dsl = smoke.slice(from, end);

const fixtures = path.join(root, 'tests', 'fixtures');
fs.mkdirSync(fixtures, { recursive: true });
fs.writeFileSync(path.join(fixtures, 'full-example.dsl.txt'), dsl, 'utf8');

const result = new TextFormBuilder({ schemaText: dsl }).parse();
if (result.error !== ERR.OK) {
    console.error(result.messages);
    process.exit(1);
}

function sortDeep(v) {
    if (v == null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(sortDeep);
    const out = {};
    for (const k of Object.keys(v).sort()) {
        out[k] = sortDeep(v[k]);
    }
    return out;
}

const golden = sortDeep(result.payload);
fs.writeFileSync(
    path.join(fixtures, 'full-example-ast.golden.json'),
    JSON.stringify(golden, null, 2) + '\n',
    'utf8'
);
console.log('Wrote tests/fixtures/full-example.dsl.txt and full-example-ast.golden.json');

import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TextFormBuilder, ERR } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sortDeep(v) {
    if (v == null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(sortDeep);
    const out = {};
    for (const k of Object.keys(v).sort()) {
        out[k] = sortDeep(v[k]);
    }
    return out;
}

describe('golden parse (Full Example fixture)', () => {
    it('matches stable AST snapshot', () => {
        const dsl = fs.readFileSync(path.join(__dirname, 'fixtures', 'full-example.dsl.txt'), 'utf8');
        const goldenRaw = fs.readFileSync(
            path.join(__dirname, 'fixtures', 'full-example-ast.golden.json'),
            'utf8'
        );
        const expected = JSON.parse(goldenRaw);
        const result = new TextFormBuilder({ schemaText: dsl }).parse();
        assert.equal(result.error, ERR.OK, result.messages?.join('\n'));
        const actual = sortDeep(result.payload);
        assert.deepEqual(actual, expected);
    });
});

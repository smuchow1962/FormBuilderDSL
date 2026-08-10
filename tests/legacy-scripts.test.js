import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function runNode(relScript) {
    const scriptPath = path.join(root, relScript);
    return spawnSync(process.execPath, [scriptPath], {
        encoding: 'utf8',
        cwd: root,
        env: { ...process.env, NODE_NO_WARNINGS: '1' }
    });
}

describe('legacy integration scripts', () => {
    it('smoke.js exits 0', () => {
        const r = runNode('tests/smoke.js');
        assert.equal(r.status, 0, r.stderr || r.stdout);
    });

    it('properties.js exits 0', () => {
        const r = runNode('tests/properties.js');
        assert.equal(r.status, 0, r.stderr || r.stdout);
    });
});

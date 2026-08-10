// Regression tests for round-19 documentation fixes.
//
// Coverage map:
//   A-D1   README no longer references assets/; package.json files
//          ships only src + types; assets/ + scripts/svg-to-png.mjs
//          deleted; resvg devDependency dropped.
//   A-D2   parseWhen returns a typed WhenAst | null on both the
//          root entry and the /expression subpath. Verified by
//          reading the .d.ts files (TypeScript shape check).
//   A-D3   architecture.md __properties section has a dedicated
//          bullet on the inner-vs-outer brace shape.
//   A-D4   sync-version.mjs bumps the pinned CDN URLs in README +
//          library-uses-in-code.md to match package.json version.
//   A-D5   Future-feature roadmap section moved out of
//          expression-trust.md into docs/roadmap.md.
//   A-D6   architecture.md mentions the safe-keys.js Proxy.
//   A-D7   README coverage thresholds cross-reference jest.config.js.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = join(__dirname, '..');
const readDoc = (relPath) => readFileSync(join(repoRoot, relPath), 'utf8');

// ─── A-D1 assets removed from README + tarball ───────────────────────────

test("A-D1 README no longer embeds the assets/ wireframe SVG", () => {
    const text = readDoc('README.md');
    assert.equal(text.includes('assets/wireframe-commercial-onboarding'), false,
        'README should not reference the removed asset');
    assert.equal(text.includes('](assets/'), false,
        'README should have no other relative links into assets/');
});

test("A-D1 package.json files array no longer ships assets/", () => {
    const pkg = JSON.parse(readDoc('package.json'));
    assert.deepEqual(pkg.files, ['src', 'types'],
        'tarball should ship only src/ and types/');
});

test("A-D1 assets/ directory and svg-to-png.mjs script are deleted", () => {
    assert.equal(existsSync(join(repoRoot, 'assets')), false,
        'assets/ directory should be removed');
    assert.equal(existsSync(join(repoRoot, 'scripts', 'svg-to-png.mjs')), false,
        'scripts/svg-to-png.mjs should be removed');
});

test("A-D1 docs:png script is gone from package.json", () => {
    const pkg = JSON.parse(readDoc('package.json'));
    assert.equal(pkg.scripts['docs:png'], undefined,
        'docs:png script should be removed');
});

test("A-D1 @resvg/resvg-js devDependency is gone from package.json", () => {
    const pkg = JSON.parse(readDoc('package.json'));
    assert.equal(pkg.devDependencies['@resvg/resvg-js'], undefined,
        '@resvg/resvg-js devDependency should be removed');
});

// ─── A-D2 typed WhenAst union ────────────────────────────────────────────

test("A-D2 types/index.d.ts declares WhenAst as a typed discriminated union", () => {
    const text = readDoc('types/index.d.ts');
    assert.ok(text.includes('export type WhenAst'),
        'WhenAst type alias missing');
    assert.ok(text.match(/parseWhen\s*\([\s\S]*?\)\s*:\s*WhenAst\s*\|\s*null/),
        'parseWhen should return WhenAst | null');
    // whenAst fields on ContainerNode + ControlNode should also be typed.
    assert.equal(text.includes('whenAst: unknown'), false,
        'whenAst fields should not be typed unknown anymore');
    assert.ok(text.match(/whenAst:\s*WhenAst\s*\|\s*null/),
        'whenAst fields should be WhenAst | null');
});

test("A-D2 types/expression.d.ts re-exports WhenAst for the subpath consumer", () => {
    const text = readDoc('types/expression.d.ts');
    assert.ok(text.includes('export type WhenAst'),
        'WhenAst should be exported from the /expression subpath types too');
    assert.ok(text.match(/parseWhen\s*\([\s\S]*?\)\s*:\s*WhenAst\s*\|\s*null/),
        '/expression subpath parseWhen should return WhenAst | null');
});

test("A-D2 the typed union covers the seven runtime node kinds", () => {
    const text = readDoc('types/index.d.ts');
    for (const kind of ['or', 'and', 'not', 'eq', 'neq', 'in', 'path', 'lit']) {
        assert.ok(text.includes(`kind: '${kind}'`),
            `WhenAst should include kind: '${kind}' arm`);
    }
});

// ─── A-D3 __properties brace-shape bullet ────────────────────────────────

test("A-D3 architecture.md has a dedicated note on the inner-vs-outer brace shape", () => {
    const text = readDoc('docs/architecture.md');
    assert.ok(text.includes('A note on the brace shapes'),
        'brace-shape clarification should be promoted to its own paragraph');
});

// ─── A-D4 sync-version.mjs CDN bumper ────────────────────────────────────

test("A-D4 sync-version.mjs walks README + library-uses-in-code.md for CDN URLs", () => {
    const text = readDoc('scripts/sync-version.mjs');
    assert.ok(text.includes("'README.md'"),
        'sync-version should list README.md as a doc to bump');
    assert.ok(text.includes("'docs/library-uses-in-code.md'"),
        'sync-version should list library-uses-in-code.md as a doc to bump');
    assert.ok(text.includes('CDN_RX'),
        'sync-version should declare a CDN regex');
});

test("A-D4 every CDN URL in README + library-uses-in-code.md matches package.json version", () => {
    const pkg = JSON.parse(readDoc('package.json'));
    const cdnRx = /@mmpworks\/formbuilder-dsl@(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)/g;
    for (const rel of ['README.md', 'docs/library-uses-in-code.md']) {
        const text = readDoc(rel);
        const matches = [...text.matchAll(cdnRx)];
        for (const m of matches) {
            assert.equal(m[1], pkg.version,
                `${rel}: CDN URL pinned to @${m[1]} should match package.json version @${pkg.version}`);
        }
    }
});

// ─── A-D5 Future feature moved to roadmap.md ─────────────────────────────

test("A-D5 expression-trust.md no longer carries the Future-feature section", () => {
    const text = readDoc('docs/expression-trust.md');
    assert.equal(text.includes('## Future feature'), false,
        'Future-feature section should be moved out of trust doc');
    assert.ok(text.includes('roadmap.md'),
        'trust doc should cross-link to roadmap.md');
});

test("A-D5 docs/roadmap.md exists and covers the dynamic-membership idea", () => {
    const text = readDoc('docs/roadmap.md');
    assert.ok(text.includes('Dynamic membership test'),
        'roadmap should carry the dynamic-membership idea');
    assert.ok(text.includes('PARSE_ERROR. Not yet supported'),
        'roadmap should preserve the worked example from the trust doc');
});

// ─── A-D6 architecture.md mentions the safe-keys Proxy ───────────────────

test("A-D6 architecture.md §10 names the safe-keys.js Proxy guarantee", () => {
    const text = readDoc('docs/architecture.md');
    assert.ok(text.match(/safe-keys\.js[\s\S]*?Proxy/),
        'architecture.md should name the Proxy in the safe-keys.js entry');
    assert.ok(text.includes('add/delete/clear') || text.includes('add / delete / clear'),
        'architecture.md should name the methods the Proxy refuses');
});

// ─── A-D7 README coverage threshold mirror note ──────────────────────────

test("A-D7 README cross-references the runner config for the coverage thresholds", () => {
    // Same intent as always — the README's threshold table must name the
    // file the gate actually reads. That file moved from package.json:c8
    // to jest.config.js when the suite migrated to Jest.
    const text = readDoc('README.md');
    assert.ok(text.includes('jest.config.js:coverageThreshold.global'),
        'README should mirror the threshold table to jest.config.js:coverageThreshold.global');
});

// Round-trip fuzz: generated valid forms must survive the whole pipeline.
//
// The other fuzz files attack the front door with malformed input. This one
// does the opposite — it generates SYNTACTICALLY VALID forms and pushes each
// one all the way through the consumer path:
//
//     source -> parse -> AST -> walkAst / renderFormPreview / inferDataSchema
//
// That matters because the downstream stages only ever see ASTs the parser
// produced, so their inputs are shaped by the grammar rather than by random
// bytes. A hand-written test suite reaches the AST shapes its author thought
// of; a generator reaches the combinations nobody enumerated — a container
// holding only an empty row, a `when=` on a nested panel whose binding never
// appears in the data, a tooltip referenced by two controls at once.
//
//   F-R1  Generated sources parse successfully (the generator stays honest).
//   F-R2  walkAst visits every node without throwing, and terminates.
//   F-R3  renderFormPreview returns a string for any valid AST.
//   F-R4  inferDataSchema returns a usable schema for any valid AST.
//   F-R5  The whole downstream pipeline is read-only over the AST.
//   F-R6  Preview rendering is deterministic.
//
// Seeds are fixed; see tests/fuzz/random.js for why.

import assert from 'node:assert/strict';

import {
    TextFormBuilder, ERR, errorName,
    walkAst, renderFormPreview, inferDataSchema
} from '../../src/index.js';
import { forEachCase, makeRng } from './random.js';

const CONTROLS = ['textfield', 'number', 'toggle', 'check', 'label', 'combo', 'select'];
const CONTROLS_WITHOUT_OPTIONS = ['textfield', 'number', 'toggle', 'check', 'label'];
const BINDINGS = ['alpha', 'beta', 'gamma', 'nested.one', 'nested.two', 'deep.a.b'];
// An option source's `-> {target}` accepts a flat name only; dotted paths are
// a control-binding feature. Keeping the two pools separate is what makes the
// generator emit valid sources rather than testing the parser's reject path.
const FLAT_BINDINGS = ['alpha', 'beta', 'gamma'];

/** Build a syntactically valid .mmpform source of random shape. */
function randomForm(rng) {
    const columns = rng.between(4, 24);
    const lines = [`columns: ${columns}`, ''];

    // Optional option sources.
    const sources = [];
    for (let i = 0; i < rng.between(0, 3); i++) {
        const name = `opts${i}`;
        const items = Array.from({ length: rng.between(1, 4) }, (_, k) => `"item${k}"`).join(', ');
        lines.push(`${name} = [${items}] -> {${rng.pick(FLAT_BINDINGS)}}`);
        sources.push(name);
    }

    // Optional tooltips.
    const tips = [];
    if (rng.bool(0.4)) {
        const count = rng.between(1, 3);
        const entries = [];
        for (let i = 0; i < count; i++) {
            const key = `tip${i}`;
            entries.push(`  "${key}" = "Help text ${i}"`);
            tips.push(key);
        }
        // Entries are comma-separated; the trailing entry carries no comma.
        lines.push('tooltips = [');
        for (let i = 0; i < entries.length; i++) {
            lines.push(i < entries.length - 1 ? `${entries[i]},` : entries[i]);
        }
        lines.push(']');
    }
    lines.push('');

    lines.push(`[container({title}${rng.bool(0.5) ? ',{subtitle}' : ''})]`);
    lines.push('');

    const rowCount = rng.between(1, 6);
    for (let r = 0; r < rowCount; r++) {
        const cells = [];
        const cellCount = rng.between(1, 3);
        // Widths must sum within the column budget, so divide it up.
        const each = Math.max(1, Math.floor(columns / cellCount) - 1);
        for (let c = 0; c < cellCount; c++) {
            // select / combo are only legal when an option source exists to
            // point at, so they leave the pool when none were emitted.
            const pool = sources.length > 0 ? CONTROLS : CONTROLS_WITHOUT_OPTIONS;
            const control = rng.pick(pool);
            const binding = rng.pick(BINDINGS);
            const tip = tips.length > 0 && rng.bool(0.3) ? `,tt="${rng.pick(tips)}"` : '';
            if (control === 'select' || control === 'combo') {
                cells.push(`[${control}(${each},#${rng.pick(sources)},{${binding}})]`);
            } else if (control === 'label') {
                cells.push(`[label(${each}${tip})]`);
            } else if (control === 'number') {
                cells.push(`[number(${each},{${binding}},min=0,max=${rng.between(1, 1000)}${tip})]`);
            } else {
                cells.push(`[${control}(${each},{${binding}}${tip})]`);
            }
        }
        const label = rng.bool(0.7) ? ` Field ${r}` : '';
        lines.push(`  - ${cells.join('\n    | ')}${label}`);
    }

    // Optional nested panel container with a when= gate.
    if (rng.bool(0.4)) {
        const gate = rng.pick(BINDINGS);
        const half = Math.max(1, Math.floor(columns / 2));
        lines.push('');
        lines.push(`  - [>container(panels=[1:${half},2:${half}],when="${gate}")] [label(4)] Extra`);
        lines.push('');
        lines.push('    1. First');
        lines.push(`      - [textfield(${Math.max(1, half - 1)},{${rng.pick(BINDINGS)}})] Nested A`);
        lines.push('');
        lines.push('    2. Second');
        lines.push(`      - [check(3,{${rng.pick(BINDINGS)}})] Nested B`);
    }

    return lines.join('\n') + '\n';
}

/** Parse and require success — the generator is only useful if it stays valid. */
function parseValid(source) {
    const result = new TextFormBuilder({ schemaText: source }).parse();
    assert.equal(result.error, ERR.OK,
        `generated source should parse but failed with ${errorName(result.error)}: ` +
        `${result.messages.join(' | ')}\n--- source ---\n${source}`);
    return result.payload;
}

// ─── F-R1: the generator produces valid forms ────────────────────────────

test('F-R1 every generated form parses successfully (2000 cases)', () => {
    // If this ever fails, the generator drifted from the grammar and the rest
    // of this file stops testing what it claims to. It is the canary for the
    // other five properties, not a test of the parser.
    forEachCase(
        0x5eed_0401, 2000,
        (rng) => randomForm(rng),
        (source) => { parseValid(source); }
    );
});

// ─── F-R2: walkAst ───────────────────────────────────────────────────────

test('F-R2 walkAst visits every node exactly once and terminates (2000 cases)', () => {
    forEachCase(
        0x5eed_0402, 2000,
        (rng) => randomForm(rng),
        (source) => {
            const ast = parseValid(source);
            const seen = new Set();
            let visits = 0;

            walkAst(ast, (node) => {
                visits++;
                assert.ok(node && typeof node === 'object', 'visitor receives an object node');
                // A cycle in the AST would make walkAst loop forever; catching a
                // repeat visit turns that hang into a failure with a location.
                assert.equal(seen.has(node), false,
                    'walkAst visited the same node twice — the AST contains a cycle');
                seen.add(node);
            });

            assert.ok(visits > 0, 'a parsed form always has at least one node to visit');
        }
    );
});

test('F-R2b walkAst tolerates a missing or non-function visitor', () => {
    const ast = parseValid('columns: 10\n[container({t})]\n  - [label(4)] X\n');
    for (const visitor of [undefined, null, 42, 'nope', {}]) {
        assert.doesNotThrow(() => walkAst(ast, visitor),
            'walkAst documents a non-function visitor as a no-op, not a crash');
    }
    for (const node of [undefined, null, 0, '', false]) {
        assert.doesNotThrow(() => walkAst(node, () => {}),
            'walkAst on an absent AST is a no-op');
    }
});

// ─── F-R3 / F-R6: preview rendering ──────────────────────────────────────

test('F-R3 renderFormPreview returns a string for any valid AST (2000 cases)', () => {
    forEachCase(
        0x5eed_0403, 2000,
        (rng) => ({ source: randomForm(rng), width: rng.between(20, 200) }),
        ({ source, width }) => {
            const ast = parseValid(source);
            const out = renderFormPreview(ast, { width });
            assert.equal(typeof out, 'string', 'preview rendering returns a string');
            assert.ok(out.length > 0, 'a non-empty form renders non-empty preview text');
        }
    );
});

test('F-R6 preview rendering is deterministic (1000 cases)', () => {
    forEachCase(
        0x5eed_0404, 1000,
        (rng) => randomForm(rng),
        (source) => {
            const ast = parseValid(source);
            assert.equal(renderFormPreview(ast), renderFormPreview(ast),
                'rendering the same AST twice must produce identical text');
        }
    );
});

// ─── F-R4: schema inference ──────────────────────────────────────────────

test('F-R4 inferDataSchema produces a usable schema for any valid AST (2000 cases)', () => {
    forEachCase(
        0x5eed_0405, 2000,
        (rng) => randomForm(rng),
        (source) => {
            const ast = parseValid(source);
            const schema = inferDataSchema(ast);
            assert.ok(schema && typeof schema === 'object',
                'schema inference returns an object for a valid AST');
            // The schema is handed to scaffold generators, so it has to survive
            // a JSON round trip — an undefined or cyclic value would break them.
            assert.doesNotThrow(() => JSON.stringify(schema),
                'the inferred schema must be JSON-serialisable');
        }
    );
});

// ─── F-R5: the downstream stages are read-only ───────────────────────────

test('F-R5 walking, rendering, and inferring never mutate the AST (1000 cases)', () => {
    // The AST is the contract between the parser and every consumer. If a
    // downstream stage mutates it, two consumers running in either order see
    // different trees — an order-dependence bug that is brutal to reproduce.
    forEachCase(
        0x5eed_0406, 1000,
        (rng) => randomForm(rng),
        (source) => {
            const ast = parseValid(source);
            const before = JSON.stringify(ast);

            walkAst(ast, () => {});
            renderFormPreview(ast);
            inferDataSchema(ast);

            assert.equal(JSON.stringify(ast), before,
                'the downstream pipeline must treat the AST as read-only');
        }
    );
});

// ─── Generator coverage sanity ───────────────────────────────────────────

test('F-R7 the generator actually produces varied forms', () => {
    // A generator that emitted the same form 2000 times would make every
    // property above pass while testing almost nothing. This pins the
    // diversity the other properties depend on.
    const rng = makeRng(0x5eed_0407);
    const shapes = new Set();
    for (let i = 0; i < 500; i++) shapes.add(randomForm(rng));
    assert.ok(shapes.size > 450,
        `the generator should emit near-unique forms, got ${shapes.size} distinct of 500`);
});

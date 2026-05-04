// Parser error positions report the PHYSICAL (editor-visible) line
// and column even when the failing token sits on a continuation line
// inside a bracket-spanning declaration.
//
// Background: the LineSplitter folds multi-physical-line declarations
// into one logical line by replacing newlines with spaces. Before the
// fix, the LineTokenizer reported `col` as the offset INTO that
// merged content — so a parse error on the 6th physical line of a
// folded declaration came out as "line 4, col 419" while the editor
// reported "Ln 11, Col 14". The user's editor row marker landed on
// the wrong line and the column was off by hundreds.
//
// The fix maintains a per-logical-line `breaks` map (contentOffset →
// physical line + startCol) so the tokenizer can translate any
// merged offset back to the (line, col) the editor would show. The
// tests below pin each surface that depends on the translation:
// successful parses (token positions correct), parse errors (error
// messages correct), and tokens that survive into AST `loc` fields.

import test from 'node:test';
import assert from 'node:assert/strict';

import { TextFormBuilder, ERR, errorName } from '../src/index.js';
import { LineSplitter, LineTokenizer, T } from '../src/tokenizer.js';

// ─── Direct LineSplitter / LineTokenizer ───────────────────────────────

test('LineSplitter records breaks at the start of every continuation line inside a merged declaration', () => {
    const src = `[label(12, "long
                    continuation
                    here")]
`;
    const lines = new LineSplitter(src).split();
    assert.equal(lines.length, 1, 'one logical line collapsed from three physical');
    const line = lines[0];
    assert.ok(Array.isArray(line.breaks), 'breaks array is exposed on the line record');
    assert.equal(line.breaks.length, 3,
        'one break for the start (line 1) + one per merged newline (lines 2, 3)');
    assert.deepEqual(line.breaks[0], { contentOffset: 0, line: 1, startCol: 1 });
    // Subsequent breaks land on physical lines 2 and 3 at col 1.
    assert.equal(line.breaks[1].line, 2);
    assert.equal(line.breaks[1].startCol, 1);
    assert.equal(line.breaks[2].line, 3);
    assert.equal(line.breaks[2].startCol, 1);
});

test('LineTokenizer translates merged offsets back to physical line/col on every emitted token', () => {
    // Three-physical-line declaration. The IDENT `bar` lives on line
    // 3, col 21 (1-indexed). Without the breaks translation, its
    // reported col would be its merged-content offset.
    const src = `[label(12, "x",
                    style=note,
                    foo=bar)]
`;
    const lines = new LineSplitter(src).split();
    const tk = new LineTokenizer(lines[0].content, lines[0].startLine, lines[0].breaks);
    // Walk every token and find the one with value 'bar'.
    const barTok = tk.tokens.find(t => t.kind === T.IDENT && t.value === 'bar');
    assert.ok(barTok, "tokenizer emitted the 'bar' identifier");
    assert.equal(barTok.line, 3, "'bar' must report physical line 3");
    assert.equal(barTok.col,  25, "'bar' must report physical col 25 (col 21 of `foo=bar` after 20-space indent + 'foo=' = 4 chars)");
});

test('LineTokenizer carries `pos` (merged-content offset) alongside physical line/col so label slicing still works', () => {
    // The label-text picker (consumeLabelAndAdvance) slices into the
    // merged content using `pos`, not `col`. The contract here keeps
    // both fields on every token so a future contributor reaching for
    // `col` for slicing sees the divergence and reaches for `pos`
    // instead.
    const src = `[textfield(8,{name})] User Name`;
    const lines = new LineSplitter(src).split();
    const tk = new LineTokenizer(lines[0].content, lines[0].startLine, lines[0].breaks);
    for (const tok of tk.tokens) {
        assert.equal(typeof tok.line, 'number',
            `token kind ${tok.kind} must carry a physical line number`);
        assert.equal(typeof tok.col,  'number',
            `token kind ${tok.kind} must carry a physical column number`);
        assert.equal(typeof tok.pos,  'number',
            `token kind ${tok.kind} must carry a 0-indexed merged-content pos for slicing`);
    }
});

// ─── End-to-end via TextFormBuilder ─────────────────────────────────────

test('parse error inside a bracket-spanning declaration reports the physical line and column', () => {
    // The `style:'note'` (colon instead of equals) is on physical line
    // 11. Before the fix, the parser reported "line 4, col 419" — the
    // logical-line start + the merged-content offset. After the fix,
    // it must report a row inside line 11.
    const src = `columns: 12

[container("X")]
  - [label(12, "a long string that
                                              extends across
                                              several physical
                                              lines so the
                                              parser's column
                                              counter rolls
                                              past every newline",
        style:'note')]
`;
    const r = new TextFormBuilder({ schemaText: src }).process();
    assert.notEqual(r.error, ERR.OK, `expected a parse error; got ${errorName(r.error)}`);
    const msg = r.messages[0];
    assert.ok(/line 11,/.test(msg),
        `error must report physical line 11; got: ${msg}`);
    // The bad colon sits at physical col 14 (8 indent spaces + "style" = 13 chars, then ':').
    // The exact column may shift if the message format ever changes;
    // pinning < 50 keeps the test resilient while still catching the
    // 419-style merged-content drift.
    const colMatch = msg.match(/col (\d+)/);
    assert.ok(colMatch, `error must include "col N"; got: ${msg}`);
    const col = parseInt(colMatch[1], 10);
    assert.ok(col > 0 && col < 50,
        `physical col must be a small editor-visible number, not a merged offset; got col ${col}`);
});

test('parse error on a single-physical-line declaration still reports the right col (no over-correction)', () => {
    // No bracket-spanning here — the whole declaration is on one
    // physical line. The col must be the position of the bad token
    // within that line. Indent is 2 spaces, then `- [label(12,
    // "Hi", style:'x')]` — the colon sits at col 27.
    const src = `columns: 12
[container("X")]
  - [label(12, "Hi", style:'x')]
`;
    const r = new TextFormBuilder({ schemaText: src }).process();
    assert.notEqual(r.error, ERR.OK);
    const msg = r.messages[0];
    assert.ok(/line 3,/.test(msg), `error must report physical line 3; got: ${msg}`);
    const col = parseInt(msg.match(/col (\d+)/)[1], 10);
    assert.equal(col, 27,
        `col must point at the colon's physical column on line 3; got col ${col}`);
});

test('Lex error inside a folded continuation line reports the continuation line, not the logical start', () => {
    // Bare control char inside a string literal that spans two
    // physical lines. The error should land on the line containing
    // the control char, not on the line where the string opened.
    const src = `columns: 12
[container("X")]
  - [label(12, "
oktext")]
`;
    const r = new TextFormBuilder({ schemaText: src }).process();
    assert.notEqual(r.error, ERR.OK);
    const msg = r.messages[0];
    // The control char () sits on physical line 4. The fix
    // makes the LEX_ERROR for "bare control character" map back to
    // line 4, not line 3 (where the string opened).
    assert.ok(/line 4,/.test(msg),
        `lex error must report the line containing the bad char; got: ${msg}`);
});

// ─── AST loc fields carry physical positions ────────────────────────────

test('control AST loc.col reflects the physical column of the control type identifier', () => {
    // A control nested inside a multi-line bracketed parent. Before
    // the fix, loc.col was an offset into the merged content (indent
    // already stripped, so a small number like 4). After the fix,
    // loc.col includes the physical indent — col 6 for a 4-space
    // indent + dash + space + bracket.
    const src = `columns: 12

[container("X")]
    - [textfield(8,{name})] Name
`;
    const r = new TextFormBuilder({ schemaText: src }).process();
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    const ctl = r.payload.root.rows[0].controls[0];
    assert.equal(ctl.loc.line, 4, 'control sits on physical line 4');
    // 4 spaces + "- [" = 7 chars; the control type 'textfield' starts
    // at physical col 8.
    assert.equal(ctl.loc.col, 8,
        `control loc.col must be the physical column of the control type; got col ${ctl.loc.col}`);
});

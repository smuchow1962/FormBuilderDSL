import assert from 'node:assert/strict';
import { LineSplitter, stripTrailingLineComment } from '../src/tokenizer.js';
import { ParseError } from '../src/tuple-response.js';

test('stripTrailingLineComment: quoted # kept', () => {
    assert.equal(stripTrailingLineComment(`foo 'a #b' bar`), `foo 'a #b' bar`);
    assert.equal(stripTrailingLineComment(`x "y #z" w`), `x "y #z" w`);
});

test('stripTrailingLineComment: trailing comment removed', () => {
    assert.equal(stripTrailingLineComment('columns: 4  # note'), 'columns: 4');
    assert.equal(stripTrailingLineComment('a #levels'), 'a #levels');
    assert.equal(stripTrailingLineComment('a # '), 'a');
});

test('stripTrailingLineComment: empty and falsy', () => {
    assert.equal(stripTrailingLineComment(''), '');
    assert.equal(stripTrailingLineComment(null), null);
    assert.equal(stripTrailingLineComment(undefined), undefined);
});

test('stripTrailingLineComment: fuzz never throws', () => {
    const alphabet = `abc #'" \t\\r\n{}[]`;
    for (let i = 0; i < 500; i++) {
        let s = '';
        const len = Math.floor(Math.random() * 80);
        for (let j = 0; j < len; j++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
        stripTrailingLineComment(s);
    }
});

test('LineSplitter: bracket continuation then fuzz', () => {
    const alphabet = 'abc[](){} \n#';
    for (let i = 0; i < 200; i++) {
        let s = 'columns: 1\n';
        const blocks = 1 + Math.floor(Math.random() * 4);
        for (let b = 0; b < blocks; b++) {
            s += '[root]\n';
            const depth = 1 + Math.floor(Math.random() * 3);
            let line = '    ';
            for (let d = 0; d < depth; d++) line += '[';
            line += 'x';
            for (let d = 0; d < depth; d++) line += ']';
            for (let j = 0; j < Math.floor(Math.random() * 20); j++) {
                line += alphabet[Math.floor(Math.random() * alphabet.length)];
            }
            s += `${line}\n`;
        }
        try {
            const lines = new LineSplitter(s).split();
            for (const L of lines) {
                assert.ok(typeof L.content === 'string');
                stripTrailingLineComment(L.content);
            }
        } catch (e) {
            if (e instanceof ParseError) continue;
            throw e;
        }
    }
});

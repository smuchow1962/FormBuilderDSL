import assert from 'node:assert/strict';
import { TextFormBuilder, ERR } from '../src/index.js';

describe('parser error codes', () => {
    it('fails when columns missing', () => {
        const r = new TextFormBuilder({
            schemaText: `[container({a},{b})]`
        }).parse();
        assert.notEqual(r.error, ERR.OK);
        assert.ok(r.messages.some((m) => m.includes("Missing required 'columns: N'")));
    });

    it('fails on duplicate root', () => {
        const r = new TextFormBuilder({
            schemaText: `columns: 10
[container({a},{b})]
  - [textfield(10,{x})] X
[container({c},{d})]
  - [textfield(10,{y})] Y
`
        }).parse();
        assert.equal(r.error, ERR.PARSE_ERROR);
        assert.ok(r.messages.some((m) => m.includes('Multiple root containers')));
    });

    it('fails layout when row exceeds columns', () => {
        const r = new TextFormBuilder({
            schemaText: `columns: 10
[container({a},{b})]
  - [textfield(8,{u})] A
    | [textfield(8,{v})] B
`
        }).parse();
        assert.equal(r.error, ERR.INVALID_LAYOUT);
    });
});

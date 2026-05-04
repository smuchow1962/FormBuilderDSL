// Block-style top-level declarations. Each one introduces a `name = [
// entries ]` block whose entries map keys to values.
//
//   colors = ["primary" = "#3498DB", ...]
//   tooltips = ["help.port" = "TCP port must be 1..65535.", ...]
//   __properties = ["name" = { type: "string", default: "" }, ...]

import { ParseError, ERR } from '../tuple-response.js';
import { T } from '../tokenizer.js';
import { assertSafeObjectKey } from '../safe-keys.js';
import { defaultMatchesType, coerceLiteral } from './literal-types.js';

// ── colors block ──────────────────────────────────────────────────────

export function parseColorsBlock(tk, model) {
    tk.expect(T.IDENT);  // 'colors'
    tk.expect(T.EQUALS);
    tk.expect(T.LSQUARE);

    if (tk.peek().kind !== T.RSQUARE) {
        parseColorEntry(tk, model);
        while (tk.accept(T.COMMA)) {
            if (tk.peek().kind === T.RSQUARE) break;   // trailing comma
            parseColorEntry(tk, model);
        }
    }
    tk.expect(T.RSQUARE);

    if (!tk.isEnd()) {
        const t = tk.peek();
        throw new ParseError(ERR.PARSE_ERROR, `Trailing tokens after colors block`, t.line, t.col);
    }
}

function parseColorEntry(tk, model) {
    const keyTok = tk.peek();
    let key;
    if (keyTok.kind === T.STRING)      { tk.next(); key = keyTok.value; }
    else if (keyTok.kind === T.IDENT)  { tk.next(); key = keyTok.value; }
    else {
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Expected color key (quoted string or bare identifier), got ${keyTok.kind}`,
            keyTok.line, keyTok.col
        );
    }
    assertSafeObjectKey(key, 'color name', keyTok);
    tk.expect(T.EQUALS);
    const valTok = tk.next();
    if (valTok.kind !== T.STRING) {
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Color value must be a quoted hex string like "#F39C12"`,
            valTok.line, valTok.col
        );
    }
    const hex = valTok.value;
    if (!/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(hex)) {
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Color value '${hex}' is not a 3- or 6-digit hex code`,
            valTok.line, valTok.col
        );
    }
    if (model.colors[key] != null) {
        throw new ParseError(ERR.PARSE_ERROR, `Duplicate color key '${key}'`, keyTok.line, keyTok.col);
    }
    // Normalize to long uppercase form so consumers can compare hex
    // strings directly without case-folding.
    let body = hex.slice(1);
    if (body.length === 3) body = body.split('').map(c => c + c).join('');
    model.colors[key] = '#' + body.toUpperCase();
}

// ── tooltips block ────────────────────────────────────────────────────

export function parseTooltipsBlock(tk, model) {
    tk.expect(T.IDENT);  // 'tooltips'
    tk.expect(T.EQUALS);
    tk.expect(T.LSQUARE);

    if (tk.peek().kind !== T.RSQUARE) {
        parseTooltipEntry(tk, model);
        while (tk.accept(T.COMMA)) {
            if (tk.peek().kind === T.RSQUARE) break;  // trailing comma
            parseTooltipEntry(tk, model);
        }
    }
    tk.expect(T.RSQUARE);

    if (!tk.isEnd()) {
        const t = tk.peek();
        throw new ParseError(ERR.PARSE_ERROR, `Trailing tokens after tooltips block`, t.line, t.col);
    }
}

function parseTooltipEntry(tk, model) {
    const keyTok = tk.peek();
    let key;
    if (keyTok.kind === T.STRING)      { tk.next(); key = keyTok.value; }
    else if (keyTok.kind === T.IDENT)  { tk.next(); key = keyTok.value; }
    else {
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Expected tooltip key (quoted string or bare identifier), got ${keyTok.kind}`,
            keyTok.line, keyTok.col
        );
    }
    assertSafeObjectKey(key, 'tooltip key', keyTok);
    tk.expect(T.EQUALS);
    const valTok = tk.next();
    if (valTok.kind !== T.STRING) {
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Tooltip value must be a quoted string`,
            valTok.line, valTok.col
        );
    }
    if (model._rawTooltips[key] != null) {
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Duplicate tooltip key '${key}'`,
            keyTok.line, keyTok.col
        );
    }
    model._rawTooltips[key] = { value: valTok.value, line: valTok.line };
}

// ── __properties block ────────────────────────────────────────────────

export function parsePropertiesBlock(tk, model) {
    // __properties = [ "name" = { type: "int", default: 0 }, ... ]
    //
    // This block is the input side of the merge that process() runs.
    // Whatever the author wrote here lands on the AST as-is; then
    // process() walks the form, adds any new bindings the form
    // discovers, and overwrites entries when the discovered type
    // differs or when a control's `init=` literal differs from the
    // declared default. The merged dictionary is what process()
    // returns; the raw block parsed here is just the starting state.
    //
    // Parsing the block keeps round-tripping clean: a saved file
    // with __properties re-parses without erroring, and the viewer
    // writes the merged dictionary back in its place after each
    // Process click.
    tk.expect(T.IDENT);  // '__properties'
    tk.expect(T.EQUALS);
    tk.expect(T.LSQUARE);

    // Null-prototype dictionary so the explicit-block path lands on
    // the same shape as collectProperties returns. A consumer who
    // gets `__properties` from either path can treat it identically:
    // own-property reads, no inherited members, safe to feed
    // straight into JSON.stringify.
    const props = Object.create(null);
    if (tk.peek().kind !== T.RSQUARE) {
        parsePropertyEntry(tk, props);
        while (tk.accept(T.COMMA)) {
            if (tk.peek().kind === T.RSQUARE) break;   // trailing comma
            parsePropertyEntry(tk, props);
        }
    }
    tk.expect(T.RSQUARE);

    model.__properties = props;

    if (!tk.isEnd()) {
        const t = tk.peek();
        throw new ParseError(ERR.PARSE_ERROR, `Trailing tokens after __properties block`, t.line, t.col);
    }
}

function parsePropertyEntry(tk, props) {
    // "name" = { type: "int", default: 0 }
    //
    // The right-hand side is always an object with at least a `type`
    // key. The `default` field is optional and falls back to the
    // type's zero value. This is the canonical shape the renderer
    // writes back and the shape consumers (sinks) read.
    const keyTok = tk.peek();
    let key;
    if (keyTok.kind === T.STRING)     { tk.next(); key = keyTok.value; }
    else if (keyTok.kind === T.IDENT) { tk.next(); key = keyTok.value; }
    else {
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Expected property name (quoted string or bare identifier), got ${keyTok.kind}`,
            keyTok.line, keyTok.col
        );
    }
    assertSafeObjectKey(key, '__properties key', keyTok);
    if (key in props) {
        throw new ParseError(ERR.PARSE_ERROR, `Duplicate property '${key}'`, keyTok.line, keyTok.col);
    }
    tk.expect(T.EQUALS);
    tk.expect(T.LCURLY);

    // Object.create(null) keeps the entry shape prototype-free,
    // matching the rest of the parser-produced model maps. Field
    // names are also screened against the recognised vocabulary
    // below ('type' and 'default' only).
    const entry = Object.create(null);
    if (tk.peek().kind !== T.RCURLY) {
        do {
            const fieldTok = tk.expect(T.IDENT);
            const field = fieldTok.value;
            // Each entry only describes a sink property; the only
            // recognised fields are `type` and `default`. Reject
            // anything else with the offending field's source
            // position so a typo like `defalt` doesn't silently land
            // in the dictionary.
            if (field !== 'type' && field !== 'default') {
                throw new ParseError(
                    ERR.PARSE_ERROR,
                    `__properties['${key}']: unknown field '${field}' (allowed: 'type', 'default')`,
                    fieldTok.line, fieldTok.col
                );
            }
            tk.expect(T.COLON);
            entry[field] = parsePropertyValue(tk);
        } while (tk.accept(T.COMMA));
    }
    tk.expect(T.RCURLY);

    if (typeof entry.type !== 'string') {
        throw new ParseError(
            ERR.PARSE_ERROR,
            `__properties['${key}'] must declare a 'type'`,
            keyTok.line, keyTok.col
        );
    }
    if (!('default' in entry)) {
        entry.default = zeroForType(entry.type);
    } else {
        // Validate default-vs-type for the five known types. Custom
        // types (anything not in this set) pass through; the parser
        // can't know what shape the consumer's vocabulary expects.
        // This catches `{ type: "int", default: "abc" }` at parse
        // time instead of letting the JSON-equality merge in
        // process() report stable churn diffs forever after.
        const mismatch = defaultMatchesType(entry.type, entry.default);
        if (mismatch) {
            throw new ParseError(
                ERR.PARSE_ERROR,
                `__properties['${key}']: default ${JSON.stringify(entry.default)} does not match declared type '${entry.type}' (${mismatch})`,
                keyTok.line, keyTok.col
            );
        }
        // Canonicalise: a numeric-string default for int / float
        // becomes the number form so downstream readers get one
        // shape per type regardless of how the author wrote the
        // literal. Pass-through for every other type, including
        // custom types.
        entry.default = coerceLiteral(entry.type, entry.default);
    }
    props[key] = entry;
}

// Element of an array default. Scalars only (no nested arrays);
// the type system only knows `string[]`, so a nested array would
// just fail downstream. Rejecting here keeps the error close to
// the typo.
function parseArrayElement(tk) {
    const t = tk.next();
    if (t.kind === T.STRING)  return t.value;
    if (t.kind === T.INTEGER) return t.value;
    if (t.kind === T.FLOAT)   return t.value;
    if (t.kind === T.IDENT) {
        if (t.value === 'true')  return true;
        if (t.value === 'false') return false;
        if (t.value === 'null')  return null;
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Bare identifier '${t.value}' is not allowed in array element; quote it as "${t.value}" or use true/false/null`,
            t.line, t.col
        );
    }
    if (t.kind === T.LSQUARE) {
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Nested arrays are not allowed in __properties defaults; the type system only knows 'string[]'`,
            t.line, t.col
        );
    }
    throw new ParseError(
        ERR.PARSE_ERROR,
        `Expected scalar in array element, got ${t.kind}`,
        t.line, t.col
    );
}

function parsePropertyValue(tk) {
    const t = tk.next();
    if (t.kind === T.STRING)  return t.value;
    if (t.kind === T.INTEGER) return t.value;
    if (t.kind === T.FLOAT)   return t.value;
    if (t.kind === T.IDENT) {
        // Bare identifiers are only the three keyword forms. A
        // typo'd `tru` reads as a parse error; the author quotes
        // their string defaults explicitly to spell them out.
        if (t.value === 'true')  return true;
        if (t.value === 'false') return false;
        if (t.value === 'null')  return null;
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Bare identifier '${t.value}' is not allowed in __properties value; quote it as "${t.value}" or use true/false/null`,
            t.line, t.col
        );
    }
    if (t.kind === T.LSQUARE) {
        // Array defaults are flat string lists today (the type
        // system only knows `string[]`). The element parser is a
        // narrow scalar reader; recursing into another array
        // (`default: [["a","b"]]`) is rejected up front rather than
        // letting it parse and then catching the shape mismatch
        // downstream in defaultMatchesType. Keeps the error close
        // to the typo.
        const values = [];
        if (tk.peek().kind !== T.RSQUARE) {
            values.push(parseArrayElement(tk));
            while (tk.accept(T.COMMA)) {
                if (tk.peek().kind === T.RSQUARE) break;  // trailing comma
                values.push(parseArrayElement(tk));
            }
        }
        tk.expect(T.RSQUARE);
        return values;
    }
    throw new ParseError(
        ERR.PARSE_ERROR,
        `Expected literal or array in __properties value, got ${t.kind}`,
        t.line, t.col
    );
}

function zeroForType(type) {
    if (type === 'int' || type === 'float')  return 0;
    if (type === 'bool')                     return false;
    if (type === 'string[]')                 return [];
    return '';
}

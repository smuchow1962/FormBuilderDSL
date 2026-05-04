// Top-level declaration parsers. Each function handles one of the
// kinds of statement that can appear at indent 0:
//
//   columns: N                     parseGlobalConfig
//   name = [...] -> {bindingA}     parseOptionSource (static)
//   name = {dataPath}              parseOptionSource (dynamic)
//   name = "literal value"         parseNamedText
//   name = `decorated text`        handleBareTextNamedText (called from parse.js
//                                  before tokenization, since the backtick
//                                  would otherwise confuse the tokenizer)
//   name = { key: value, ... }     parseNamedObject
//
// The "option source" is the DSL term for a list of values that a
// select / combo / radio control can pick from. The leading name
// becomes the key the control references with `#name` later.

import { ParseError, ERR } from '../tuple-response.js';
import { T } from '../tokenizer.js';
import { isReserved } from '../control-spec.js';
import { parseBindingPath } from './binding-helpers.js';
import { assertSafeObjectKey } from '../safe-keys.js';

export function parseGlobalConfig(tk, model) {
    const keyTok = tk.expect(T.IDENT);
    const key = keyTok.value;
    tk.expect(T.COLON);
    // Pre-check for end-of-line. A bare `columns:` with no value would
    // otherwise pull EOF off the tokenizer and complain that EOF
    // "must be an integer" with the column pinned past end-of-line.
    // The dedicated message reads cleaner and points at the right spot.
    if (tk.peek().kind === T.EOF) {
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Missing value for '${key}'`,
            keyTok.line, keyTok.col
        );
    }
    const v = tk.next();
    if (key === 'columns') {
        if (v.kind !== T.INTEGER) {
            throw new ParseError(ERR.PARSE_ERROR, `'columns' must be an integer`, v.line, v.col);
        }
        if (v.value < 1) {
            throw new ParseError(
                ERR.INVALID_PARAM,
                `'columns' must be 1 or greater, got ${v.value}`,
                v.line, v.col
            );
        }
        model.columns = v.value;
    } else {
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Unknown global config key: '${key}'. Only 'columns:' is recognised at top level today.`,
            v.line, v.col
        );
    }
    if (!tk.isEnd()) {
        const t = tk.peek();
        throw new ParseError(ERR.PARSE_ERROR, `Trailing tokens after global config`, t.line, t.col);
    }
}

export function parseOptionSource(tk, model, lineNum) {
    const nameTok = tk.expect(T.IDENT);
    const name = nameTok.value;
    if (isReserved(name)) {
        throw new ParseError(ERR.PARSE_ERROR, `Reserved name '${name}' cannot be an option source`, lineNum, 1);
    }
    assertSafeObjectKey(name, 'option source name', nameTok);
    tk.expect(T.EQUALS);

    const next = tk.peek();
    let source;
    if (next.kind === T.LSQUARE) {
        // Static source: a literal list followed by zero or more
        // `-> {binding}` clauses.
        //
        //   sizes = ["S", "M", "L"] -> {sizeA} -> {sizeB}
        //
        // Each `->` clause attaches one binding name to the source.
        // The renderer reads the source's values into each named
        // binding at form-init time, then tracks each binding's
        // value independently after that.
        source = { type: 'static', values: parseLiteralList(tk), bindings: [] };
        if (tk.accept(T.ARROW)) {
            do {
                tk.expect(T.LCURLY);
                source.bindings.push(tk.expect(T.IDENT).value);
                tk.expect(T.RCURLY);
            } while (tk.accept(T.ARROW));
        }
        // Back-compat field. `source.binding` (singular) was the
        // shape before `bindings` (plural) existed. The AST is a
        // versioned contract, and removing a field that consumers
        // may read is a major-version change. The field stays on
        // the AST through 1.x — it is `bindings[0] ?? null`, never
        // out of sync with `bindings`. New consumers should read
        // `bindings`; existing consumers reading `binding` keep
        // working without code changes.
        source.binding = source.bindings[0] ?? null;
    } else if (next.kind === T.LCURLY) {
        // Dynamic source: a single {dataPath}.
        tk.next();
        source = { type: 'dynamic', path: parseBindingPath(tk).join('.'), bindings: [], binding: null };
        tk.expect(T.RCURLY);
    } else {
        // The author probably meant a known top-level block. The
        // dispatcher in parse.js routes `tooltips`, `colors`, and
        // `__properties` to dedicated parsers; anything else falls
        // here and the value side has to be `[`, `{`, or a
        // string-quoted form. A typo like `tooltps =` lands here
        // with a "missing [" message that doesn't help the author
        // see the typo. The hint below lists the canonical names.
        const hint = nameLooksLikeBlockTypo(name)
            ? ` (did you mean 'tooltips', 'colors', or '__properties'?)`
            : '';
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Expected '[' or '{' after '='${hint}`,
            next.line, next.col
        );
    }

    model.optionSources[name] = source;

    if (!tk.isEnd()) {
        const t = tk.peek();
        throw new ParseError(ERR.PARSE_ERROR, `Trailing tokens after option source`, t.line, t.col);
    }
}

function parseLiteralList(tk) {
    tk.expect(T.LSQUARE);
    const values = [];
    if (tk.peek().kind !== T.RSQUARE) {
        values.push(parseLiteralValue(tk));
        while (tk.accept(T.COMMA)) {
            values.push(parseLiteralValue(tk));
        }
    }
    tk.expect(T.RSQUARE);
    return values;
}

function parseLiteralValue(tk) {
    const t = tk.next();
    if (t.kind === T.STRING)  return t.value;
    if (t.kind === T.INTEGER) return t.value;
    if (t.kind === T.FLOAT)   return t.value;
    if (t.kind === T.DATE)    return t.value;     // YYYY-MM-DD or YYYY-MM-DDTHH:MM(:SS)?
    if (t.kind === T.IDENT) {
        // Same bare-keyword set as parseObjectValue: only true,
        // false, and null are accepted bare. Other identifiers must
        // be quoted, matching the language's quoted-strings rule.
        if (t.value === 'true')  return true;
        if (t.value === 'false') return false;
        if (t.value === 'null')  return null;
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Bare identifier '${t.value}' is not allowed in option-source value list; quote it as "${t.value}" or use true/false/null`,
            t.line, t.col
        );
    }
    // `#name` here is a reference to a named object declared at the
    // top of the form. Stored as a small placeholder; the phase-2
    // pass resolves each ref to the actual object so option-source
    // consumers see real values rather than `{__ref:'name'}` markers.
    if (t.kind === T.HASH_IDENT) return { __ref: t.value, __refLine: t.line, __refCol: t.col };
    throw new ParseError(ERR.PARSE_ERROR, `Expected literal value, got ${t.kind}`, t.line, t.col);
}

// ── Named text ────────────────────────────────────────────────────────

export function parseNamedText(tk, model) {
    const nameTok = tk.expect(T.IDENT);
    const name = nameTok.value;
    if (isReserved(name)) {
        throw new ParseError(ERR.PARSE_ERROR, `Reserved name '${name}' cannot be a named-text key`, nameTok.line, nameTok.col);
    }
    assertSafeObjectKey(name, 'named-text key', nameTok);
    if (model.optionSources[name] != null) {
        throw new ParseError(ERR.PARSE_ERROR, `'${name}' is already declared as an option source`, nameTok.line, nameTok.col);
    }
    if (model._rawNamedText[name] != null) {
        throw new ParseError(ERR.PARSE_ERROR, `Duplicate named-text key '${name}'`, nameTok.line, nameTok.col);
    }
    tk.expect(T.EQUALS);
    const valTok = tk.expect(T.STRING);
    model._rawNamedText[name] = { value: valTok.value, line: valTok.line };
    if (!tk.isEnd()) {
        const t = tk.peek();
        throw new ParseError(ERR.PARSE_ERROR, `Trailing tokens after named-text declaration`, t.line, t.col);
    }
}

export function handleBareTextNamedText(model, name, value, lineNum) {
    if (isReserved(name)) {
        throw new ParseError(ERR.PARSE_ERROR, `Reserved name '${name}' cannot be a named-text key`, lineNum, 1);
    }
    assertSafeObjectKey(name, 'named-text key', { line: lineNum, col: 1 });
    if (model.optionSources[name] != null) {
        throw new ParseError(ERR.PARSE_ERROR, `'${name}' is already declared as an option source`, lineNum, 1);
    }
    if (model._rawNamedText[name] != null) {
        throw new ParseError(ERR.PARSE_ERROR, `Duplicate named-text key '${name}'`, lineNum, 1);
    }
    model._rawNamedText[name] = { value: value.trimEnd(), line: lineNum };
}

// ── Named objects ─────────────────────────────────────────────────────
//
// Syntax:
//     name = { !pkField: value, key: value, key, key: value }
//
//   - `!pkField` marks the primary-key field. Stored on the object
//     as a non-enumerable __pk so JSON output stays clean.
//   - `key` (no value) is shorthand for `key: true`.
//   - quoted strings, numbers, dates, true, false, and null work as
//     values directly. Bare identifiers other than the three
//     keyword forms are rejected (parseObjectValue raises
//     PARSE_ERROR; quote the string explicitly).
//
// Referenced from option-source value lists via `#name`.
//
// Flat-body rule (v1). Named-object bodies hold scalar values only:
// strings, integers, floats, dates, true / false / null. They do
// not nest, and they do not accept `#name` references in value
// position. Cross-references between named entities happen in one
// place: option-source value lists. That keeps the consumer's mental
// model simple ("a named object is a flat property bag") and
// avoids the cycle-detection burden a graph-of-objects shape would
// add. If a future version allows references inside bodies, it'd
// resolve them at parse time and store the resolved object inline,
// not as a placeholder, so consumers never see "by reference"
// semantics in the AST.

export function looksLikeNamedObject(tk) {
    // Lookahead from the IDENT (current peek) past `=`:
    //   peek(0): IDENT (name)
    //   peek(1): EQUALS
    //   peek(2): LCURLY   if not, this is not an object declaration
    //   peek(3): BANG | IDENT
    //   peek(4): COLON | COMMA  (BANG case is decided one token earlier)
    //
    // A single-IDENT body (`name = {ident}`) is reserved for the
    // dynamic option source `name = {dataPath}` and is intentionally
    // not handled here. Without a COLON or COMMA the named-object
    // form would be ambiguous with an option-source path, and the
    // option source predates the named-object syntax.
    if (tk.peek(2).kind !== T.LCURLY) return false;
    const t3 = tk.peek(3);
    if (t3.kind === T.BANG) return true;
    if (t3.kind !== T.IDENT) return false;
    const t4 = tk.peek(4);
    return t4.kind === T.COLON || t4.kind === T.COMMA;
}

export function parseNamedObject(tk, model, lineNum) {
    const nameTok = tk.expect(T.IDENT);
    const name = nameTok.value;
    if (isReserved(name)) {
        throw new ParseError(ERR.PARSE_ERROR, `Reserved name '${name}' cannot be a named object`, lineNum, 1);
    }
    assertSafeObjectKey(name, 'named-object key', nameTok);
    if (model.namedObjects[name] != null) {
        throw new ParseError(ERR.PARSE_ERROR, `Duplicate named object '${name}'`, lineNum, 1);
    }
    tk.expect(T.EQUALS);
    tk.expect(T.LCURLY);

    // Object.create(null) for the body matches every other model
    // map (model.optionSources, model.tooltips, model.colors, etc.)
    // so a downstream walker that uses `for..in` or
    // `Object.getOwnPropertyNames` reads the same prototype-free
    // shape across the whole AST. Keys are also screened by
    // assertSafeObjectKey on the way in.
    const obj = Object.create(null);
    let pk = null;

    if (tk.peek().kind !== T.RCURLY) {
        do {
            const isPk = tk.accept(T.BANG) != null;
            const keyTok = tk.expect(T.IDENT);
            const key = keyTok.value;
            assertSafeObjectKey(key, `field name in named object '${name}'`, keyTok);
            if (isPk) {
                if (pk !== null) {
                    throw new ParseError(ERR.PARSE_ERROR,
                        `Named object '${name}' has multiple primary keys`,
                        keyTok.line, keyTok.col);
                }
                pk = key;
            }
            let value = true;          // bare key default
            if (tk.accept(T.COLON)) {
                value = parseObjectValue(tk);
            }
            obj[key] = value;
        } while (tk.accept(T.COMMA));
    }

    tk.expect(T.RCURLY);

    // __pk is marked non-enumerable so JSON output (Live Data tab,
    // commit payloads) doesn't carry parser metadata. Direct
    // property access still reads it.
    if (pk !== null) {
        Object.defineProperty(obj, '__pk', {
            value:        pk,
            enumerable:   false,
            configurable: false,
            writable:     false
        });
    }

    model.namedObjects[name] = obj;

    if (!tk.isEnd()) {
        const t = tk.peek();
        throw new ParseError(ERR.PARSE_ERROR, `Trailing tokens after named object`, t.line, t.col);
    }
}

// "Did you mean..." check for a top-level identifier. Used by the
// option-source error path so a typo like `tooltps` points the
// author at `tooltips` instead of falling out as a generic syntax
// error.
//
// What "looks like a typo" means here: the candidate name is one
// edit away from a known keyword. One edit is any of:
//
//   - one character changed   (`toolyips` -> `tooltips`)
//   - one character dropped   (`tooltps`  -> `tooltips`)
//   - one character added     (`tooltipss` -> `tooltips`)
//
// Two or more edits and we treat it as something else entirely
// (probably not a typo). The walk below is a one-pointer-per-
// string scan that counts edits as it goes; if the count goes
// above one, we bail.
//
// Hoisting note: this is the only typo-hint helper in the package
// today. If a second one appears (control-type typo hint, parameter-
// name typo hint), pull this into `src/parser/typo-hint.js` and
// call it from both sites — same decision, one place.
function nameLooksLikeBlockTypo(name) {
    const known = ['tooltips', 'colors', '__properties'];
    for (const k of known) {
        if (k === name) return false;
        if (Math.abs(k.length - name.length) > 1) continue;
        let edits = 0;
        for (let i = 0, j = 0; i < k.length || j < name.length; ) {
            if (k[i] === name[j]) { i++; j++; continue; }
            edits++;
            if (edits > 1) break;
            if (k.length > name.length) i++;
            else if (name.length > k.length) j++;
            else { i++; j++; }
        }
        if (edits <= 1) return true;
    }
    return false;
}

function parseObjectValue(tk) {
    const t = tk.next();
    if (t.kind === T.STRING)  return t.value;
    if (t.kind === T.INTEGER) return t.value;
    if (t.kind === T.FLOAT)   return t.value;
    if (t.kind === T.DATE)    return t.value;     // YYYY-MM-DD or YYYY-MM-DDTHH:MM(:SS)?
    if (t.kind === T.IDENT) {
        // Only the three keyword identifiers are accepted bare. Any
        // other identifier in value position is a typo or an
        // unquoted string, both of which the author should fix.
        // `tru` raises here; `true` is fine; `"tru"` is fine.
        if (t.value === 'true')  return true;
        if (t.value === 'false') return false;
        if (t.value === 'null')  return null;
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Bare identifier '${t.value}' is not allowed as a value; quote it as "${t.value}" or use true/false/null`,
            t.line, t.col
        );
    }
    throw new ParseError(ERR.PARSE_ERROR, `Expected value after ':', got ${t.kind}`, t.line, t.col);
}

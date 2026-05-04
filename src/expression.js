// Tiny boolean-expression evaluator for `when=...` strings.
//
// A control's `when=` lets the form hide or show that control based on
// the data object at render time. The expression syntax is small on
// purpose. The grammar below is the entire language.
//
// Grammar (recursive descent, meaning each grammar rule is one
// function and the parser walks the tokens top-down):
//
//   expr   := or
//   or     := and ( '||' and )*
//   and    := comp ( '&&' comp )*
//   comp   := primary ( ('==' | '!=') primary )?
//          | primary 'in' '[' literalList ']'
//   primary:= '!' primary
//          | '(' expr ')'
//          | identPath
//          | string | number | true | false
//   identPath := IDENT ('.' IDENT)*
//
// Trust model: only evaluate against trusted host data (typically an
// admin UI's data object). Three guards make this safe even so:
//
//   1. Path lookups refuse to walk `__proto__`, `prototype`, or
//      `constructor`. This blocks "prototype pollution," the class of
//      attack where an expression climbs the prototype chain to reach
//      Object.prototype and rewrite something every object inherits.
//   2. The source string has a maximum length (default 8 KB).
//   3. Tokenization stops after a maximum token count (default 2048).
//
// See docs/expression-trust.md for the full threat model.

import { ParseError, ERR } from './tuple-response.js';

const RX = {
    ws:    /^[ \t]+/,
    // Each segment is a non-empty identifier; segments are joined
    // by single dots. So `foo`, `a.b`, `a.b.c` are valid; `foo..bar`
    // and a trailing `foo.` are not (the regex stops short of the
    // bad segment, the parser then sees the leftover `.` and
    // raises a clear PARSE_ERROR rather than silently resolving
    // through an empty path segment).
    ident: /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/,
    // Named capture groups per the project's coding rule. The
    // capture itself is not consumed today (the tokenizer reads
    // `m[0]` for the full match and parses it via parseFloat); the
    // names exist so a future maintainer reading the regex sees
    // the part-of-speech without having to count parens.
    num:   /^-?\d+(?:\.(?<frac>\d+))?/,
    op2:   /^(?<op>==|!=|&&|\|\|)/
};

// String-literal grammar lives in src/string-literal.js so the outer
// DSL tokenizer and this expression tokenizer share one rule. The
// only thing that differs between the two is what to do with an
// unterminated literal; this caller raises PARSE_ERROR (the
// expression failure code), the tokenizer raises LEX_ERROR.
import { readQuotedString } from './string-literal.js';

/** Default maximum `when=` source length (characters). */
export const DEFAULT_MAX_WHEN_SOURCE_LENGTH = 8192;

/** Default maximum token count while lexing a `when=` expression. */
export const DEFAULT_MAX_WHEN_TOKENS = 2048;

// Re-export the shared reserved-key list under its historical name so
// existing consumers (and the trust doc) keep working without a churn.
// The actual definition and the Proxy live in safe-keys.js, which
// also serves interpolate.js, text-fragment.js, and the parser-side
// key checks. One source of truth for the rule.
export { RESERVED_OBJECT_KEYS as FORBIDDEN_PATH_SEGMENTS } from './safe-keys.js';
import { resolveSafePath } from './safe-keys.js';

function normalizeWhenOptions(options) {
    const o = options && typeof options === 'object' ? options : {};
    return {
        maxSourceLength: o.maxSourceLength ?? DEFAULT_MAX_WHEN_SOURCE_LENGTH,
        maxTokens:       o.maxTokens ?? DEFAULT_MAX_WHEN_TOKENS
    };
}

function tokenize(src, whenOpts) {
    const tokens = [];
    let pos = 0;
    const maxTokens = whenOpts.maxTokens;
    while (pos < src.length) {
        if (tokens.length >= maxTokens) {
            throw new ParseError(
                ERR.PARSE_ERROR,
                `when expression exceeds max token count (${maxTokens}); next character at offset ${pos}`
            );
        }
        const rest = src.slice(pos);
        let m;
        m = rest.match(RX.ws);
        if (m) { pos += m[0].length; continue; }
        m = rest.match(RX.op2);
        if (m) { tokens.push({ kind: m[0], value: m[0] }); pos += m[0].length; continue; }
        if (rest[0] === '!') { tokens.push({ kind: '!', value: '!' }); pos++; continue; }
        if (rest[0] === '(') { tokens.push({ kind: '(', value: '(' }); pos++; continue; }
        if (rest[0] === ')') { tokens.push({ kind: ')', value: ')' }); pos++; continue; }
        if (rest[0] === '[') { tokens.push({ kind: '[', value: '[' }); pos++; continue; }
        if (rest[0] === ']') { tokens.push({ kind: ']', value: ']' }); pos++; continue; }
        if (rest[0] === ',') { tokens.push({ kind: ',', value: ',' }); pos++; continue; }
        if (rest[0] === '"' || rest[0] === "'") {
            const { value, end } = readQuotedString(
                src,
                pos,
                () => {
                    throw new ParseError(
                        ERR.PARSE_ERROR,
                        `Unterminated string literal in when expression`
                    );
                },
                (charPos, charCode) => {
                    throw new ParseError(
                        ERR.PARSE_ERROR,
                        `String literal in when expression contains a bare control character (0x${charCode.toString(16).padStart(2, '0')}); recognised escapes are \\\\ \\' \\" \\n \\t.`,
                        0, charPos + 1
                    );
                }
            );
            tokens.push({ kind: 'STR', value });
            pos = end;
            continue;
        }
        m = rest.match(RX.num);
        if (m) {
            tokens.push({ kind: 'NUM', value: parseFloat(m[0]) });
            pos += m[0].length;
            continue;
        }
        m = rest.match(RX.ident);
        if (m) {
            const name = m[0];
            if (name === 'in')    tokens.push({ kind: 'IN',    value: name });
            else if (name === 'true')  tokens.push({ kind: 'BOOL', value: true });
            else if (name === 'false') tokens.push({ kind: 'BOOL', value: false });
            else                       tokens.push({ kind: 'IDENT', value: name });
            pos += name.length;
            continue;
        }
        // Escape control characters in the error message so a
        // literal newline, tab, or other unprintable doesn't mangle
        // the consumer's terminal. JSON.stringify gives a stable,
        // human-readable representation (`"\n"`, `"\t"`, etc.).
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Unexpected character in expression: ${JSON.stringify(rest[0])} at offset ${pos}`
        );
    }
    // The EOF token counts against the cap too. Without this check
    // a source that hits exactly the cap on its last real token
    // would still get an EOF appended for free.
    if (tokens.length >= maxTokens) {
        throw new ParseError(
            ERR.PARSE_ERROR,
            `when expression exceeds max token count (${maxTokens}); EOF would push past the cap`
        );
    }
    tokens.push({ kind: 'EOF' });
    return tokens;
}

class Walker {
    constructor(tokens) { this.tokens = tokens; this.cur = 0; }
    peek(o = 0) { return this.tokens[this.cur + o]; }
    next()      { return this.tokens[this.cur++]; }
    accept(k)   { if (this.peek().kind === k) return this.next(); return null; }
    expect(k)   {
        const t = this.peek();
        if (t.kind !== k) throw new ParseError(ERR.PARSE_ERROR, `Expected ${k}, got ${t.kind}`);
        return this.next();
    }
}

function parseExpr(w)    { return parseOr(w); }
function parseOr(w)      { let l = parseAnd(w); while (w.accept('||')) { const r = parseAnd(w); l = { kind: 'or', l, r }; } return l; }
function parseAnd(w)     { let l = parseComp(w); while (w.accept('&&')) { const r = parseComp(w); l = { kind: 'and', l, r }; } return l; }

function parseComp(w) {
    const left = parsePrimary(w);
    if (w.accept('IN')) {
        w.expect('[');
        const list = [];
        if (w.peek().kind !== ']') {
            list.push(parseLiteral(w));
            while (w.accept(',')) list.push(parseLiteral(w));
        }
        w.expect(']');
        return { kind: 'in', l: left, list };
    }
    const eq  = w.accept('==');
    const neq = !eq && w.accept('!=');
    if (eq || neq) {
        const right = parsePrimary(w);
        return { kind: eq ? 'eq' : 'neq', l: left, r: right };
    }
    return left;
}

function parsePrimary(w) {
    const t = w.peek();
    if (t.kind === '!') { w.next(); return { kind: 'not', x: parsePrimary(w) }; }
    if (t.kind === '(') { w.next(); const e = parseExpr(w); w.expect(')'); return e; }
    if (t.kind === 'IDENT') { w.next(); return { kind: 'path', path: t.value.split('.') }; }
    if (t.kind === 'STR')   { w.next(); return { kind: 'lit',  v: t.value }; }
    if (t.kind === 'NUM')   { w.next(); return { kind: 'lit',  v: t.value }; }
    if (t.kind === 'BOOL')  { w.next(); return { kind: 'lit',  v: t.value }; }
    throw new ParseError(ERR.PARSE_ERROR, `Unexpected token in expression: ${t.kind}`);
}

function parseLiteral(w) {
    const t = w.next();
    if (t.kind === 'STR')  return t.value;
    if (t.kind === 'NUM')  return t.value;
    if (t.kind === 'BOOL') return t.value;
    throw new ParseError(ERR.PARSE_ERROR, `Expected literal, got ${t.kind}`);
}

// Path resolution is delegated to safe-keys.js so interpolate.js and
// text-fragment.js share the exact same rule. The shared helper
// already refuses prototype-walking segments and only reads own
// properties, which is what the trust doc promises here.

function evalNode(node, data) {
    // The Boolean(...) coercions on `and` and `or` are intentional.
    // resolveSafePath returns `undefined` for a missing or
    // prototype-walking segment, and JavaScript's `&&` / `||` would
    // pass that through unchanged. Coercing keeps the operator's
    // result strictly a boolean even when the intermediate value
    // resolves to `undefined`. The native `&&` / `||` short-circuit
    // is preserved because the wrapping happens inside the operator
    // arms, not on the final result.
    switch (node.kind) {
        case 'lit':  return node.v;
        case 'path': return resolveSafePath(data, node.path);
        case 'not':  return !evalNode(node.x, data);
        case 'and':  return Boolean(evalNode(node.l, data)) && Boolean(evalNode(node.r, data));
        case 'or':   return Boolean(evalNode(node.l, data)) || Boolean(evalNode(node.r, data));
        case 'eq':   return evalNode(node.l, data) === evalNode(node.r, data);
        case 'neq':  return evalNode(node.l, data) !== evalNode(node.r, data);
        case 'in':   return node.list.includes(evalNode(node.l, data));
        default:     throw new ParseError(ERR.PARSE_ERROR, `Unknown expression node: ${node.kind}`);
    }
}

/**
 * Parse a `when=` string into an AST (or null for empty).
 * @param {string | null | undefined} source
 * @param {{ maxSourceLength?: number, maxTokens?: number } | undefined} options
 * @throws {ParseError} when `source` exceeds the length cap, the token-count
 *         cap, or contains a grammar error. Callers should wrap in try/catch
 *         or pre-validate length.
 */
export function parseWhen(source, options) {
    // Empty and whitespace-only sources both mean "no condition,"
    // which the consumer expects to read as "always render." Bailing
    // out before tokenizing keeps the parse path silent for the
    // common case of an unset `when=` and matches what evaluateWhen
    // promises (no throw on a missing condition).
    if (source == null) return null;
    if (typeof source !== 'string' || source.trim() === '') return null;
    const opt = normalizeWhenOptions(options);
    if (source.length > opt.maxSourceLength) {
        throw new ParseError(
            ERR.PARSE_ERROR,
            `when expression exceeds max length (${opt.maxSourceLength} characters)`
        );
    }
    const tokens = tokenize(source, opt);
    const w = new Walker(tokens);
    const ast = parseExpr(w);
    if (!w.accept('EOF')) {
        const t = w.peek();
        throw new ParseError(ERR.PARSE_ERROR, `Trailing tokens in expression near ${t.kind}`);
    }
    return ast;
}

/**
 * Evaluate a `when=` string against plain data (trusted host object).
 * @param {string | null | undefined} source
 * @param {Record<string, unknown>} data
 * @param {{ maxSourceLength?: number, maxTokens?: number } | undefined} options
 * @throws {ParseError} when `source` is malformed or exceeds a cap (parsing
 *         is delegated to {@link parseWhen}).
 */
export function evaluateWhen(source, data, options) {
    const ast = parseWhen(source, options);
    if (ast == null) return true;
    return Boolean(evalNode(ast, data));
}

/**
 * Evaluate an already-parsed `when=` AST against trusted host data.
 * The escape hatch documented in `architecture-no-ast-caching.md`:
 * the package re-walks every call by default, but a consumer can
 * cache the parse themselves and feed the AST back through this
 * function. The hot-loop case (form re-render on every keystroke
 * where visibility depends on a `when=` expression) saves the
 * parse cost on every keystroke without compromising the no-caching
 * rule on the package's own walks.
 *
 * @param {WhenAst | null} ast — the result of `parseWhen(source, options)`.
 *   `null` evaluates to `true` (no `when=` means always-visible).
 * @param {Record<string, unknown>} data — host data for the path lookups.
 * @returns {boolean}
 */
export function evaluateAst(ast, data) {
    if (ast == null) return true;
    return Boolean(evalNode(ast, data));
}

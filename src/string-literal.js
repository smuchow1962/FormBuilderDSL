// One source of truth for the package's quoted-string grammar. Both
// the outer DSL tokenizer (LineTokenizer._consumeString) and the
// inner `when=` expression tokenizer call this so an author who
// already knows how DSL strings work doesn't have to learn a second
// rule. Two implementations of the same rule would drift; one
// implementation can't.
//
// Recognised escapes (any other backslash sequence passes the next
// character through literally):
//
//   \\   backslash       \'   single quote
//   \"   double quote    \n   newline
//   \t   tab
//
// Bare control characters (C0 range 0x00-0x1F minus the explicit
// `\n` and `\t` escapes, plus DEL 0x7F, plus a bare CR 0x0D) are
// rejected at parse time. The grammar has no escape syntax for
// those bytes, so a string literal that contains one cannot round-
// trip through `readQuotedString` -> `writeQuotedString` -> read
// without losing or rewriting content. Refusing them at the reader
// keeps the round-trip honest and turns a silent data-loss bug
// into a visible parse error.

/**
 * Read a quoted string starting at `src[start]`. The character at
 * `src[start]` is the opening quote (' or "); the same character
 * closes the literal. Returns `{ value, end }` where `value` is the
 * decoded string content (escapes already applied) and `end` is the
 * index one past the closing quote.
 *
 * The caller decides what to do on an unterminated literal or a
 * bare control character by passing two callbacks. The helper
 * itself stays free of error policy: each callback either throws
 * (the tokenizer raises LEX_ERROR, the expression lexer raises
 * PARSE_ERROR) or returns whatever placeholder the caller wants.
 *
 * `onInvalidChar` fires for any C0 control byte (0x00-0x1F minus
 * the explicit `\n` and `\t` escapes), for DEL (0x7F), and for a
 * bare CR (0x0D). The grammar has no escape syntax for those
 * bytes; refusing them at the reader keeps the round-trip with
 * `writeQuotedString` honest.
 *
 * @param {string} src
 * @param {number} start
 * @param {(startPos: number) => never} onUnterminated
 * @param {(charPos: number, charCode: number) => never} [onInvalidChar]
 *   Optional. If omitted, invalid characters pass through silently
 *   (preserves callers that have not yet adopted the strict rule).
 *   New callers pass it; the bundled tokenizer and expression
 *   tokenizer both do.
 * @returns {{ value: string, end: number }}
 */
export function readQuotedString(src, start, onUnterminated, onInvalidChar) {
    const quote = src[start];
    let pos = start + 1;
    let value = '';
    while (pos < src.length && src[pos] !== quote) {
        const c = src[pos];
        if (c === '\\' && pos + 1 < src.length) {
            const next = src[pos + 1];
            if (next === '\\')      value += '\\';
            else if (next === '\'') value += '\'';
            else if (next === '"')  value += '"';
            else if (next === 'n')  value += '\n';
            else if (next === 't')  value += '\t';
            else                    value += next;
            pos += 2;
            continue;
        }
        // C0 / DEL / bare CR rejection. The check sits inside the
        // raw-character branch (after the escape branch) so an
        // explicit `\n` / `\t` still works; only an unescaped
        // control byte trips the callback.
        if (onInvalidChar) {
            const code = c.charCodeAt(0);
            const isControl = code < 0x20 && code !== 0x09 && code !== 0x0A;
            if (isControl || code === 0x0D || code === 0x7F) {
                onInvalidChar(pos, code);
            }
        }
        // Trailing backslash at end-of-input. The escape branch above
        // requires a lookahead character, so a `\` with nothing after
        // it falls through and lands literally in `value`. The outer
        // while exits, then `onUnterminated` fires (the literal isn't
        // terminated); the partial `value` we built never escapes
        // because the callback throws. The path is benign by design.
        value += c;
        pos++;
    }
    if (pos >= src.length) {
        onUnterminated(start);
    }
    return { value, end: pos + 1 };
}

/**
 * Encode a JS string back into the package's quoted-string grammar.
 * The inverse of `readQuotedString`: any value emitted here parses
 * back to the same string with the same content. Round-trip safe
 * across the five escape pairs the reader recognises (`\\`, `\'`,
 * `\"`, `\n`, `\t`) plus all printable ASCII and the entire
 * Unicode range above 0x7F (umlauts, CJK, emoji).
 *
 * Bare control characters (C0 range 0x00-0x1F minus the explicit
 * `\n` and `\t` escapes, plus DEL 0x7F, plus a bare CR 0x0D) have
 * no grammar-safe escape and the reader rejects them at parse
 * time. The writer raises a `TypeError` for the same bytes so a
 * caller never produces a literal that won't round-trip. Both
 * sides refuse the same input; the contract is symmetric.
 *
 * Used by `property-collector.formatDefault` so a `__properties`
 * dictionary that comes back through `process()` and gets re-rendered
 * carries the same string content the source did. The reader's
 * parse-time rejection of C0 means no value coming from a parsed
 * document ever reaches this writer carrying those bytes; the
 * `TypeError` here only fires for a consumer hand-building a
 * properties dictionary with bytes the grammar cannot represent.
 *
 * Output is always double-quoted. The reader accepts both quote
 * styles, but pinning the writer to one keeps diffs stable.
 *
 * @param {string} value
 * @returns {string} a quoted, escape-safe DSL string literal
 * @throws {TypeError} when `value` contains a C0 control byte, DEL,
 *         or a bare CR. The error message names the offending byte
 *         and its index so the caller can locate the bad character.
 */
export function writeQuotedString(value) {
    let out = '"';
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        const ch = value[i];
        // Five escape pairs the reader recognises directly.
        if (ch === '\\') { out += '\\\\'; continue; }
        if (ch === '"')  { out += '\\"';  continue; }
        if (ch === '\n') { out += '\\n';  continue; }
        if (ch === '\t') { out += '\\t';  continue; }
        // C0 / DEL / bare CR refusal — symmetric with the reader.
        const isControl = c < 0x20 && c !== 0x09 && c !== 0x0A;
        if (isControl || c === 0x0D || c === 0x7F) {
            throw new TypeError(
                `writeQuotedString: byte 0x${c.toString(16).padStart(2, '0')} at index ${i} has no DSL escape; the grammar refuses bare control characters`
            );
        }
        // Everything else, including all printable ASCII and the
        // entire Unicode range above 0x7F (umlauts, CJK, emoji),
        // emits as-is. JS strings are Unicode and the DSL is read
        // as UTF-8.
        out += ch;
    }
    out += '"';
    return out;
}

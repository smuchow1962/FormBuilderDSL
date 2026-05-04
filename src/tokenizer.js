// Two-stage lexer. (A "lexer" is the part of a parser that turns raw
// characters into tokens. Tokens are the small named pieces, like
// LBRACKET or IDENT, that the grammar walks.)
//
//   1. LineSplitter walks the raw input and produces "logical lines"
//      with their indent and content. Lines with unclosed brackets or
//      parens get merged with the following line (newlines become
//      spaces) so a multi-line declaration shows up as one logical
//      line. Whole-line comments (where # is the first non-whitespace
//      character) are dropped. Trailing comments are dropped too,
//      provided the # has whitespace before it and is followed by
//      whitespace or end-of-line. The whitespace requirement keeps
//      `#levels` references safe.
//
//   2. LineTokenizer runs over one logical line's content and returns
//      a flat token list. The parser uses this to walk parens and
//      brackets inside a declaration.
//
// The label text after a control's closing `]` is intentionally not
// tokenized. The parser asks the tokenizer for the unconsumed
// remainder of the line and treats it as raw label text.

import { ParseError, ERR } from './tuple-response.js';
import { readQuotedString } from './string-literal.js';

export const T = Object.freeze({
    LBRACKET:   'LBRACKET',
    RBRACKET:   'RBRACKET',
    LPAREN:     'LPAREN',
    RPAREN:     'RPAREN',
    LCURLY:     'LCURLY',
    RCURLY:     'RCURLY',
    LSQUARE:    'LSQUARE',
    RSQUARE:    'RSQUARE',
    COMMA:      'COMMA',
    COLON:      'COLON',
    EQUALS:     'EQUALS',
    ARROW:      'ARROW',     // ->
    GT:         'GT',        // >
    DOT:        'DOT',
    BANG:       'BANG',
    BAR:        'BAR',
    DASH:       'DASH',
    HASH_IDENT: 'HASH_IDENT',
    AT:         'AT',
    IDENT:      'IDENT',
    INTEGER:    'INTEGER',
    FLOAT:      'FLOAT',
    DATE:       'DATE',
    STRING:     'STRING',
    EOF:        'EOF'
});

// ---------------------------------------------------------------
// LineSplitter (pass 1)
// ---------------------------------------------------------------

export class LineSplitter {
    constructor(input) {
        this.input = stripBom(input);
        this.pos = 0;
        this.line = 1;
        this.lines = [];
    }

    split() {
        while (this.pos < this.input.length) {
            // Hard cap on the number of logical lines. The 1 MB
            // input cap above bounds total work, but a 1 MB input
            // of mostly-empty lines could still build a 200k+ entry
            // array of placeholder records. The cap keeps the AST
            // size bounded next to the input cap so consumers
            // hosting untrusted DSL text get a focused error
            // instead of a memory spike.
            if (this.lines.length >= MAX_LOGICAL_LINES) {
                throw new ParseError(
                    ERR.LEX_ERROR,
                    `Source exceeds max logical-line count (${MAX_LOGICAL_LINES})`,
                    this.line, 1
                );
            }
            this._splitNextLine();
        }
        return this.lines;
    }

    _splitNextLine() {
        const lineNum = this.line;

        // Read indent (spaces only)
        let indent = 0;
        while (this.pos < this.input.length && this.input[this.pos] === ' ') {
            indent++;
            this.pos++;
        }
        if (this.pos < this.input.length && this.input[this.pos] === '\t') {
            throw new ParseError(
                ERR.LEX_ERROR,
                'Tab in indentation; spaces only',
                lineNum,
                indent + 1
            );
        }

        // Blank line
        if (this.pos >= this.input.length) return;
        const c = this.input[this.pos];
        if (c === '\n' || c === '\r') {
            this._consumeNewline();
            return;
        }

        // Whole-line comment. The # was the first non-whitespace
        // character on the line, so the whole line gets thrown away.
        if (c === '#') {
            while (this.pos < this.input.length
                   && this.input[this.pos] !== '\n'
                   && this.input[this.pos] !== '\r') {
                this.pos++;
            }
            this._consumeNewline();
            return;
        }

        // Real content. Accumulate characters until we hit a newline
        // at bracket depth 0. Newlines inside `[...]`, `(...)`, or
        // `{...}` become spaces so multi-line declarations collapse
        // into one logical line, and `breaks` records where each new
        // physical line restarts inside the merged content so the
        // LineTokenizer can translate (contentOffset) → (physicalLine,
        // col) for error reporting. Without the map a parse error on
        // the 6th physical line of a folded declaration would report
        // a col of 300+ at the logical start line — completely wrong
        // for an editor that wants to highlight the actual row.
        let content = '';
        let depth = 0;
        const startLine = lineNum;
        const breaks = [{ contentOffset: 0, line: startLine, startCol: indent + 1 }];
        while (this.pos < this.input.length) {
            const ch = this.input[this.pos];
            if ((ch === '\n' || ch === '\r') && depth === 0) break;
            if (ch === '[' || ch === '(' || ch === '{') depth++;
            else if (ch === ']' || ch === ')' || ch === '}') depth--;
            if (depth < 0) {
                throw new ParseError(
                    ERR.LEX_ERROR,
                    'Unbalanced closing bracket',
                    this.line,
                    1
                );
            }
            if (ch === '\n' || ch === '\r') {
                content += ' ';
                this._consumeNewline();
                // After the merged newline, content.length is the
                // offset where the next non-newline char will land.
                // From that offset onwards the source sits on the
                // freshly-incremented physical line, col 1.
                breaks.push({ contentOffset: content.length, line: this.line, startCol: 1 });
            } else {
                content += ch;
                this.pos++;
            }
        }

        if (depth !== 0) {
            throw new ParseError(
                ERR.LEX_ERROR,
                'Unclosed bracket / paren at end of input',
                startLine,
                1
            );
        }

        this.lines.push({
            startLine,
            indent,
            content: stripTrailingLineComment(content.trimEnd()),
            breaks
        });
        this._consumeNewline();
    }

    _consumeNewline() {
        // Recognise the four common line-ending shapes:
        //   \n        Unix
        //   \r        old Mac
        //   \r\n      Windows
        //   \n\r      rare; produced by a handful of older text
        //             editors (early BBS clients, some embedded
        //             serial-terminal stacks) that wrote LF first
        //             and CR second. Modern producers do not emit
        //             this shape, but DSL files coming through a
        //             legacy export tool can still carry it. Better
        //             to fold it into one logical line than to
        //             count a phantom blank line every time.
        // The pair-aware consume keeps each logical newline at one
        // line-counter increment instead of two.
        const c = this.input[this.pos];
        if (c === '\r' || c === '\n') {
            const next = this.input[this.pos + 1];
            const isPair = (c === '\r' && next === '\n') || (c === '\n' && next === '\r');
            this.pos += isPair ? 2 : 1;
            this.line++;
        }
    }
}

function stripBom(s) {
    // Empty input has no BOM and `''.charCodeAt(0)` returns NaN; the
    // explicit length check is clearer than relying on NaN !== 0xFEFF
    // for the empty case.
    if (s.length === 0) return s;
    if (s.charCodeAt(0) === 0xFEFF) return s.slice(1);
    return s;
}

/**
 * Remove end-of-line comment: requires whitespace before `#`, and `#` must be
 * followed by whitespace or end-of-string (so `#levels` option refs are kept).
 * Quote-aware for ' and ". Escapes \\ inside strings skip the next char.
 */
export function stripTrailingLineComment(text) {
    if (!text) return text;
    const isWs = (ch) => ch === ' ' || ch === '\t';
    let inSingle = false;
    let inDouble = false;
    // We track the LAST legal `#` cut, not the first. A line can
    // contain several whitespace-delimited `#` sequences (a tooltip
    // body talking about hash codes, for example). The trailing
    // comment is the rightmost one because everything after it is
    // by definition the comment, including any earlier `#`s in the
    // same suffix. The whole tail collapses to one cut.
    let lastCut = -1;
    for (let j = 0; j < text.length; j++) {
        const c = text[j];
        if (c === '\\' && j + 1 < text.length && (inSingle || inDouble)) {
            j++;
            continue;
        }
        if (c === "'" && !inDouble) {
            inSingle = !inSingle;
            continue;
        }
        if (c === '"' && !inSingle) {
            inDouble = !inDouble;
            continue;
        }
        if (inSingle || inDouble) continue;
        if (c !== '#' || j === 0) continue;
        if (!isWs(text[j - 1])) continue;
        const after = text[j + 1];
        if (after !== undefined && !isWs(after)) continue;
        let k = j - 1;
        while (k >= 0 && isWs(text[k])) k--;
        lastCut = k + 1;
    }
    if (lastCut < 0) return text;
    return text.slice(0, lastCut).trimEnd();
}

// ---------------------------------------------------------------
// LineTokenizer (pass 2)
// ---------------------------------------------------------------

const DATE_RX  = /^(?<y>\d{4})-(?<m>\d{2})-(?<d>\d{2})/;
const IDENT_RX = /^[A-Za-z_][A-Za-z0-9_]*/;

// Cap on the character length of a numeric literal. 20 chars covers
// every legal int / float well past Number.MAX_SAFE_INTEGER (16
// digits) and Number.MAX_VALUE's exponent-free decimal forms; an
// input longer than this is almost certainly hostile or a bug. The
// cap raises LEX_ERROR with a focused message instead of letting
// parseInt produce Infinity that ripples through the layout sums.
const MAX_NUMBER_LITERAL_LEN = 20;

// Cap on the number of logical lines a single input can produce.
// The 1 MB input cap upstream bounds raw bytes; this cap bounds
// the resulting structure size. Generous (100k) so realistic
// hand-authored forms (a few hundred lines) and machine-generated
// reports (several thousand) both pass without trouble.
const MAX_LOGICAL_LINES = 100_000;

export class LineTokenizer {
    constructor(content, originLine, breaks) {
        this.input = content;
        this.pos = 0;
        this.line = originLine;
        // Breaks map content offsets back to physical (line, col).
        // The LineSplitter builds them while merging multi-physical-
        // line declarations into a single logical line; callers that
        // build a synthetic single-line invocation (e.g. the parser
        // stripping a label tail and re-tokenising it) can omit the
        // arg and get a single-break map covering the whole input.
        this.breaks = breaks ?? [{ contentOffset: 0, line: originLine, startCol: 1 }];
        this.tokens = [];
        this.tokenize();
        this.cursor = 0;
    }

    // Translate a content offset back to physical (line, col). Walks
    // breaks linearly because the typical break count is 1 (single-
    // physical-line declarations) or a small handful (multi-line
    // bracketed declarations) — a binary-search variant would carry
    // its own setup cost without saving anything for those shapes.
    _physical(offset) {
        const breaks = this.breaks;
        let i = breaks.length - 1;
        while (i > 0 && breaks[i].contentOffset > offset) i--;
        const b = breaks[i];
        return { line: b.line, col: b.startCol + (offset - b.contentOffset) };
    }

    tokenize() {
        // Track structural depth so non-ASCII characters in label
        // text (which lives at depth 0, after the closing `]` of a
        // declaration) don't get rejected by the catchall throw at
        // the bottom of the loop. The label is consumed via string
        // slicing later, not through tokens, so silently skipping
        // unknown characters here lets Unicode characters reach the
        // slice unchanged. Inside structural delimiters
        // (depth > 0) the catchall still throws, which is what
        // catches a malformed identifier or a stray Unicode
        // character that doesn't belong inside a `{...}`.
        //
        // The "are we past the declaration's `]`?" check uses
        // `sawClose`. Before the first RSQUARE on the line, depth-0
        // ground is still value-position territory (`name = "x"` or
        // `__properties = [ ... ]`), and a stray non-ASCII character
        // there is almost always an identifier typo (`höhe` instead
        // of `hoehe`). The targeted error names the character and
        // points at the column so the author sees the typo without
        // hunting through the cascading "Trailing tokens" message
        // the silent skip would otherwise produce.
        let depth = 0;
        let sawClose = false;
        while (this.pos < this.input.length) {
            const ch = this.input[this.pos];

            if (ch === ' ' || ch === '\t') { this.pos++; continue; }

            // Escape for literal `[` / `]` in label-text region.
            // At depth 0 (after a declaration's closing `]`) an
            // author may want a literal `[` in their label text.
            // `\[` and `\]` consume both characters without emitting
            // a token; the original input string still contains the
            // backslash and the bracket, and the label slicer
            // copies the run unchanged. parseDecorated then
            // unescapes `\[` and `\]` back to the literal bracket.
            if (depth === 0 && ch === '\\'
                && (this.input[this.pos + 1] === '['
                    || this.input[this.pos + 1] === ']')) {
                this.pos += 2;
                continue;
            }
            if (ch === '[') { this._emit(T.LBRACKET, '[');  this.pos++; depth++; continue; }
            if (ch === ']') {
                this._emit(T.RBRACKET, ']');
                this.pos++;
                if (depth > 0) {
                    depth--;
                    // Drop into label-text mode the moment we close
                    // back to depth 0. From here on, non-ASCII
                    // characters are silently skipped (the slice
                    // re-reads the original input). Before this point,
                    // depth-0 ground is value position and a stray
                    // non-ASCII char raises a targeted error.
                    if (depth === 0) sawClose = true;
                }
                continue;
            }
            if (ch === '(') { this._emit(T.LPAREN, '(');    this.pos++; depth++; continue; }
            if (ch === ')') { this._emit(T.RPAREN, ')');    this.pos++; if (depth > 0) depth--; continue; }
            if (ch === '{') { this._emit(T.LCURLY, '{');    this.pos++; depth++; continue; }
            if (ch === '}') { this._emit(T.RCURLY, '}');    this.pos++; if (depth > 0) depth--; continue; }
            if (ch === ',') { this._emit(T.COMMA, ',');     this.pos++; continue; }
            if (ch === ':') { this._emit(T.COLON, ':');     this.pos++; continue; }
            if (ch === '=') { this._emit(T.EQUALS, '=');    this.pos++; continue; }
            if (ch === '|') { this._emit(T.BAR, '|');       this.pos++; continue; }
            if (ch === '!') { this._emit(T.BANG, '!');      this.pos++; continue; }
            if (ch === '.') {
                // Leading-dot numeric literal like `.5`. Only fires
                // when the previous emitted token is NOT something
                // that makes `.` a member-access (an IDENT path
                // segment). The check on `prev` keeps `customer.name`
                // tokenising as IDENT DOT IDENT while still letting
                // a value-position `.5` lex as a single FLOAT.
                if (this._isDigit(this.input[this.pos + 1])) {
                    const prev = this.tokens[this.tokens.length - 1];
                    const isPathDot = prev && (prev.kind === T.IDENT || prev.kind === T.RBRACKET || prev.kind === T.RPAREN);
                    if (!isPathDot) {
                        this._consumeLeadingDotFloat(false);
                        continue;
                    }
                }
                this._emit(T.DOT, '.'); this.pos++; continue;
            }

            // - and -> dispatch
            if (ch === '-') {
                if (this.input[this.pos + 1] === '>') {
                    this._emit(T.ARROW, '->'); this.pos += 2; continue;
                }
                // Negative numbers (digit-led: `-5`, `-5.5`).
                if (this._isDigit(this.input[this.pos + 1])) {
                    this._consumeNumber(true);
                    continue;
                }
                // Negative leading-dot float (`-.5`).
                if (this.input[this.pos + 1] === '.'
                    && this._isDigit(this.input[this.pos + 2])) {
                    this._consumeLeadingDotFloat(true);
                    continue;
                }
                this._emit(T.DASH, '-'); this.pos++; continue;
            }

            // > as collapsible-container marker
            if (ch === '>') { this._emit(T.GT, '>'); this.pos++; continue; }

            // @ marks a function-binding inside { ... }
            if (ch === '@') { this._emit(T.AT, '@'); this.pos++; continue; }

            // Square brackets (only seen in array literals: option sources, panels=[1:8,2:12])
            // We currently route '[' through LBRACKET above; re-route when we see we are
            // in an "array literal" context. The parser disambiguates by surrounding tokens.
            // To keep tokens unambiguous, switch [ inside parens / after '=' to LSQUARE.
            // (Done in a separate post-processing step below.)

            // String literals
            if (ch === '"' || ch === "'") {
                this._consumeString();
                continue;
            }

            // Hash-prefixed name (#optName)
            if (ch === '#') {
                this.pos++;
                const m = this.input.slice(this.pos).match(IDENT_RX);
                if (!m) {
                    const phys = this._physical(this.pos);
                    throw new ParseError(
                        ERR.LEX_ERROR,
                        `Expected identifier after '#'`,
                        phys.line,
                        phys.col
                    );
                }
                this._emit(T.HASH_IDENT, m[0]);
                this.pos += m[0].length;
                continue;
            }

            // Numbers and dates
            if (this._isDigit(ch)) {
                if (DATE_RX.test(this.input.slice(this.pos))) {
                    this._consumeDate();
                    continue;
                }
                this._consumeNumber(false);
                continue;
            }

            // Identifiers (possibly && / ||)
            if (this._isAlpha(ch) || ch === '_') {
                const m = this.input.slice(this.pos).match(IDENT_RX);
                this._emit(T.IDENT, m[0]);
                this.pos += m[0].length;
                continue;
            }

            // Non-ASCII character at depth 0. Two cases:
            //
            //   - After the declaration's closing `]` (sawClose ===
            //     true): label text. The label is reassembled by
            //     string slicing the original input later, so we walk
            //     past Unicode characters here without emitting a
            //     token. The slice picks them up unchanged.
            //
            //   - Before the closing `]` (sawClose === false): value
            //     position. A stray Unicode character here is almost
            //     always an identifier typo (`höhe` instead of
            //     `hoehe`); the targeted error names the character
            //     and points at the column so the author sees the
            //     typo instead of a downstream "Trailing tokens"
            //     message.
            if (depth === 0 && ch.charCodeAt(0) >= 128) {
                if (sawClose) {
                    this.pos++;
                    continue;
                }
                const phys = this._physical(this.pos);
                throw new ParseError(
                    ERR.LEX_ERROR,
                    `Non-ASCII character '${ch}' is not allowed in identifier position; quote it as a string or use the Unicode escape if it should be part of a value`,
                    phys.line,
                    phys.col
                );
            }
            const phys = this._physical(this.pos);
            throw new ParseError(
                ERR.LEX_ERROR,
                `Unexpected character '${ch}'`,
                phys.line,
                phys.col
            );
        }
        this._postProcessSquareBrackets();
        // EOF carries an empty string rather than null so every
        // emitted token has a string `value`. consumeLabelAndAdvance
        // reads `value.length` directly; uniform shape removes a
        // footgun there.
        this._emit(T.EOF, '');
    }

    _consumeString() {
        // Capture the string-start physical position before
        // readQuotedString advances `this.pos`. The unterminated-string
        // error message points at the string's opening quote, not at
        // wherever we ran out of input — that's the location the user
        // needs to see in the editor.
        const startPhys = this._physical(this.pos);
        const { value, end } = readQuotedString(
            this.input,
            this.pos,
            () => {
                throw new ParseError(
                    ERR.LEX_ERROR,
                    'Unterminated string literal',
                    startPhys.line,
                    startPhys.col
                );
            },
            (charPos, charCode) => {
                const phys = this._physical(charPos);
                throw new ParseError(
                    ERR.LEX_ERROR,
                    `String literal contains a bare control character (0x${charCode.toString(16).padStart(2, '0')}); the grammar has no escape for it. Recognised escapes inside strings: \\\\ \\' \\" \\n \\t.`,
                    phys.line,
                    phys.col
                );
            }
        );
        this.pos = end;
        this._emit(T.STRING, value);
    }

    _consumeDate() {
        const m = this.input.slice(this.pos).match(DATE_RX);
        this._emit(T.DATE, m[0]);
        this.pos += m[0].length;
        // Optional T-time portion: 2026-01-01T00:00 or 2026-01-01T12:30:45
        if (this.input[this.pos] === 'T') {
            const tail = this.input.slice(this.pos).match(/^T\d{2}:\d{2}(:\d{2})?/);
            if (tail) {
                // Append into the previous DATE token
                const last = this.tokens[this.tokens.length - 1];
                last.value += tail[0];
                this.pos += tail[0].length;
            }
        }
    }

    // Consume a leading-dot float like `.5` or `-.5`. The dispatcher
    // checks the digit-after-dot before calling, so this just
    // advances past the optional `-`, the `.`, and the digit run.
    _consumeLeadingDotFloat(isNegative) {
        const start = this.pos;
        if (isNegative) this.pos++;          // consume `-`
        this.pos++;                          // consume `.`
        while (this.pos < this.input.length && this._isDigit(this.input[this.pos])) this.pos++;
        const text = this.input.slice(start, this.pos);
        if (text.length > MAX_NUMBER_LITERAL_LEN) {
            const phys = this._physical(start);
            throw new ParseError(
                ERR.LEX_ERROR,
                `Numeric literal too long (${text.length} chars; max ${MAX_NUMBER_LITERAL_LEN})`,
                phys.line,
                phys.col
            );
        }
        // parseFloat handles leading `.` and `-.`. The slice we
        // built is exactly the matched substring; no extra cleanup
        // needed.
        this._emit(T.FLOAT, parseFloat(text));
    }

    _consumeNumber(isNegative) {
        const start = this.pos;
        if (isNegative) this.pos++;
        while (this.pos < this.input.length && this._isDigit(this.input[this.pos])) this.pos++;
        let isFloat = false;
        if (this.input[this.pos] === '.' && this._isDigit(this.input[this.pos + 1])) {
            isFloat = true;
            this.pos++;
            while (this.pos < this.input.length && this._isDigit(this.input[this.pos])) this.pos++;
        }
        const text = this.input.slice(start, this.pos);
        // Numeric literal length cap. Without this, a 1 MB input full
        // of digits would parseInt to Infinity (or a float losing
        // precision) and ride out as a control width or a layout
        // sum. The 1 MB input cap higher up bounds the worst case,
        // but the right error here is "number too long" not "row
        // overflows columns."
        if (text.length > MAX_NUMBER_LITERAL_LEN) {
            const phys = this._physical(start);
            throw new ParseError(
                ERR.LEX_ERROR,
                `Numeric literal too long (${text.length} chars; max ${MAX_NUMBER_LITERAL_LEN})`,
                phys.line,
                phys.col
            );
        }
        const value = isFloat ? parseFloat(text) : parseInt(text, 10);
        // Integer-precision check. parseInt happily produces values
        // beyond Number.MAX_SAFE_INTEGER (2^53 - 1), but the bits
        // past 2^53 cannot round-trip — `parseInt('9007199254740993')`
        // yields 9007199254740992, off by one and silently. The
        // displayed error would then name the rounded value, hiding
        // the source typo. Refuse the literal at parse time and
        // name MAX_SAFE_INTEGER in the message so the author
        // understands the range.
        if (!isFloat && !Number.isSafeInteger(value)) {
            const phys = this._physical(start);
            throw new ParseError(
                ERR.LEX_ERROR,
                `Integer literal '${text}' exceeds Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}); values beyond this lose precision when parsed`,
                phys.line,
                phys.col
            );
        }
        this._emit(isFloat ? T.FLOAT : T.INTEGER, value);
    }

    // Re-classify [ / ] tokens that appear in array-literal contexts.
    // An [ is an LSQUARE when the previous token is EQUALS, COMMA,
    // COLON, LPAREN, LSQUARE, or the IDENT `in` (e.g. inside
    // `panels=[1:8,2:12]`, `["log",...]`, `in [a,b]`,
    // `default: [["a","b"]]`).
    //
    // One pass over the token list with an explicit stack. Each
    // LSQUARE we open pushes its index onto the stack; the matching
    // RBRACKET pops and rewrites itself to RSQUARE. The stack
    // remembers whether the most recent open was re-classified, so
    // the next token's predecessor check works for nested arrays
    // without needing a second pass. The cost grows in proportion
    // to the number of tokens (one visit each); peak memory is
    // however deeply the arrays nest.
    //
    // Bracket-balance assumption: this loop assumes every `[` has
    // a matching `]`. The outer LineSplitter enforces that by
    // raising LEX_ERROR on an unbalanced line before any LineTokenizer
    // sees the input (see LineSplitter._splitNextLine in this file).
    // A future contributor should not add a "what if the stack is
    // non-empty at end-of-input" branch here — the upstream
    // splitter has already ruled that case out.
    _postProcessSquareBrackets() {
        const openSquareStack = [];
        for (let i = 0; i < this.tokens.length; i++) {
            const t = this.tokens[i];
            if (t.kind === T.LBRACKET) {
                const prev = this.tokens[i - 1];
                const prevKind = prev?.kind;
                // The outer DSL has no `in` operator (that lives in
                // the expression tokenizer used inside `when=`
                // strings). Predecessor list is only the four
                // structural openers plus an already-rewritten
                // LSQUARE so nested arrays handle correctly.
                const opensArrayLiteral =
                    prevKind === T.EQUALS
                    || prevKind === T.COMMA
                    || prevKind === T.LPAREN
                    || prevKind === T.COLON
                    || prevKind === T.LSQUARE;
                if (opensArrayLiteral) {
                    t.kind = T.LSQUARE;
                    t.value = '[';
                    openSquareStack.push(i);
                }
                continue;
            }
            if (t.kind === T.RBRACKET && openSquareStack.length > 0) {
                // Close the most recently opened LSQUARE. The match
                // pairs the closing token with its opener at the
                // same nesting depth, then converts it to RSQUARE.
                openSquareStack.pop();
                t.kind = T.RSQUARE;
                t.value = ']';
                continue;
            }
        }
    }

    _emit(kind, value) {
        // `line`/`col` are the physical (editor-visible) coordinates.
        // `pos` keeps the 0-indexed offset into the merged content so
        // downstream slicing (consumeLabelAndAdvance) doesn't have to
        // translate physical coords back through the breaks map. Both
        // are recorded at every token because translation through
        // breaks is a one-way operation: physical → merged is many-to-
        // one when merged whitespace collapses, so a back-translation
        // can't always pick the right answer.
        const phys = this._physical(this.pos);
        this.tokens.push({ kind, value, line: phys.line, col: phys.col, pos: this.pos });
    }

    _isDigit(c) { return c >= '0' && c <= '9'; }
    _isAlpha(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }

    // ---------- Cursor API used by parser ----------

    peek(offset = 0) {
        return this.tokens[this.cursor + offset] ?? this.tokens[this.tokens.length - 1];
    }

    next() {
        const t = this.tokens[this.cursor];
        if (this.cursor < this.tokens.length - 1) this.cursor++;
        return t;
    }

    expect(kind, message) {
        const t = this.peek();
        if (t.kind !== kind) {
            throw new ParseError(
                ERR.PARSE_ERROR,
                message ?? `Expected ${kind}, got ${t.kind}${t.value != null ? ` '${t.value}'` : ''}`,
                t.line,
                t.col
            );
        }
        return this.next();
    }

    accept(kind) {
        if (this.peek().kind === kind) return this.next();
        return null;
    }

    isEnd() {
        return this.peek().kind === T.EOF;
    }

    // Like consumeLabelTextUntilNextDecl (the older non-advancing
    // variant, removed) but also advances the token cursor
    // past every token that overlaps the label-text region. Used when the
    // parser captures label text and then expects to be past those tokens.
    consumeLabelAndAdvance() {
        const consumedIdx = this.cursor - 1;
        const lastBracket = this.tokens[consumedIdx];
        // _emit always sets `value` to a string (EOF is `''`, not
        // null; see _emit below). This direct read depends on that
        // contract: a quiet null `value` would silently shift the
        // label start by one character. The assertion below makes
        // the contract loud — a future change to _emit that ships
        // EOF as null would crash here with a clear message instead
        // of mis-counting columns silently.
        if (typeof lastBracket.value !== 'string') {
            throw new Error(
                `LineTokenizer.consumeLabelAndAdvance: token value must be a string for column math; got ${typeof lastBracket.value} on token kind ${lastBracket.kind}`
            );
        }
        // Slice into the merged content — `pos` is the 0-indexed
        // offset (`col` is now physical and would mis-index here).
        // The offset right after the bracket token is its pos plus
        // its rendered length.
        const sliceStart = lastBracket.pos + lastBracket.value.length;

        // Find next LBRACKET or EOF
        let endCursor = this.cursor;
        let sliceEnd;
        while (endCursor < this.tokens.length) {
            const t = this.tokens[endCursor];
            if (t.kind === T.LBRACKET || t.kind === T.EOF) { break; }
            endCursor++;
        }
        const next = this.tokens[endCursor];
        if (next?.kind === T.LBRACKET) {
            sliceEnd = next.pos;
        } else {
            sliceEnd = this.input.length;
        }
        const text = this.input.slice(sliceStart, sliceEnd).trim();
        this.cursor = endCursor;
        return text;
    }
}

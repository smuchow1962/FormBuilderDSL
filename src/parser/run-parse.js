import { ParseError, TupleResponse, ERR } from '../tuple-response.js';
import { validateControlSpec } from '../control-spec.js';
import { parse } from './parse.js';
import { checkLayout } from './layout-check.js';

/** Default cap on the length of the DSL source string (1 MB). */
export const DEFAULT_MAX_INPUT_LENGTH = 1024 * 1024;

/**
 * Top-level wrapper that the public `TextFormBuilder.parse()` method
 * calls. Four steps:
 *
 *   1. Bound the input. If the source exceeds `maxInputLength`
 *      (default 1 MB), return `LEX_ERROR` without lexing a single
 *      character. The cap protects the rest of the pipeline (the
 *      lexer, the per-line tokenizer, `state.pendingLabels`, the
 *      AST itself) from runaway adversarial input.
 *   2. Validate the control spec the caller handed in. If it's
 *      malformed, return `INVALID_SPEC` without ever running the
 *      parser. (The "control spec" is the data dictionary that tells
 *      the parser what each control type accepts; see
 *      `src/control-spec.js` for the default one.)
 *   3. Run the parser. If it throws a `ParseError`, convert it to a
 *      `TupleResponse` failure carrying the error code and message.
 *      A `TupleResponse` is the small `{ error, payload, messages }`
 *      envelope every public method returns.
 *   4. Run the layout check. If any row's controls add up wider than
 *      the form's `columns`, return `INVALID_LAYOUT`. Otherwise wrap
 *      the AST in a `TupleResponse.ok` and return it.
 *
 * Both `ParseError` and any other thrown value land in the
 * `TupleResponse`. The consumer should always be able to branch on
 * `result.error` without wrapping the call in try/catch. ParseError
 * carries its own ERR.* code. Everything else (a TypeError from a
 * null dereference, a RangeError from runaway recursion, anything
 * else thrown from inside the parser) becomes
 * `ERR.INTERNAL_ERROR`. The captured message preserves the error
 * name, the original message, and the first line of the stack so a
 * consumer reporting bugs has enough to file an actionable issue.
 * The full stack does NOT ride out (it's noisy and the first frame
 * is the part that matters).
 *
 * @param {string} input             DSL source text
 * @param {object} controlSpec       control vocabulary
 * @param {{maxInputLength?: number, maxNestingDepth?: number}} [opts]
 *   maxInputLength overrides the 1 MB input cap.
 *   maxNestingDepth overrides the 16-level container-nesting cap
 *   (a deeper form raises INVALID_LAYOUT).
 */
export function runParse(input, controlSpec, opts) {
    const maxInputLength = opts?.maxInputLength ?? DEFAULT_MAX_INPUT_LENGTH;
    if (typeof input === 'string' && input.length > maxInputLength) {
        return TupleResponse.fail(
            ERR.LEX_ERROR,
            `Input exceeds max length (${input.length} > ${maxInputLength} characters)`
        );
    }
    try {
        const specErrors = validateControlSpec(controlSpec);
        if (specErrors.length > 0) {
            return TupleResponse.fail(ERR.INVALID_SPEC, specErrors);
        }
        const ast = parse(input, controlSpec, { maxNestingDepth: opts?.maxNestingDepth });
        const layoutErrors = checkLayout(ast);
        if (layoutErrors.length > 0) {
            return TupleResponse.fail(ERR.INVALID_LAYOUT, layoutErrors);
        }
        // Non-fatal warnings (empty option-source lists, duplicate
        // values) ride out in the messages array on a successful
        // result. Consumers branch on `result.error === ERR.OK` and
        // can surface the messages alongside the AST.
        const warnings = ast._warnings ?? [];
        return TupleResponse.ok(ast, warnings);
    } catch (e) {
        if (e instanceof ParseError) {
            return TupleResponse.fail(e.code, [e.toMessage()]);
        }
        return TupleResponse.fail(ERR.INTERNAL_ERROR, [formatInternalError(e)]);
    }
}

function formatInternalError(e) {
    // Compact "name: message (at firstStackLine)" formatting. The
    // first stack frame is enough for a consumer to file a useful
    // bug report; the rest of the stack belongs in a debugger, not
    // in the response envelope.
    //
    // Path scrubbing. A V8 stack frame embeds the absolute file URL
    // (`at fn (file:///C:/dev/herald/.../parse-controls.js:135:5)`),
    // which leaks the host filesystem layout when the response is
    // surfaced to an untrusted caller. Strip the URL down to its
    // basename so the diagnostic still points at the file but
    // doesn't carry the path. Line and column survive.
    if (!(e instanceof Error)) {
        return `INTERNAL_ERROR: ${String(e)}`;
    }
    const name = e.name || 'Error';
    const msg = e.message || '';
    let firstStackLine = '';
    if (typeof e.stack === 'string') {
        const lines = e.stack.split('\n');
        for (const line of lines) {
            if (/^\s+at\s/.test(line)) { firstStackLine = line.trim(); break; }
        }
    }
    return firstStackLine
        ? `${name}: ${msg} (${scrubStackPath(firstStackLine)})`
        : `${name}: ${msg}`;
}

// Replace any `file://...` or absolute-path segment inside a stack
// frame line with the basename so the message doesn't leak the host
// filesystem layout. Keeps the line and column suffix intact. Has
// to allow colons in the body (Windows paths look like
// `file:///E:/dev/...`) and anchor the basename via the last slash.
//
// The regex is V8-shaped (`at fn (file:URL:line:col)`). The package
// targets Node 18+ per package.json:engines, so V8 is the only
// runtime we need to handle. SpiderMonkey / JavaScriptCore stack
// formats differ; if the package ever runs on those, this scrub
// would need a second branch.
function scrubStackPath(line) {
    // Early-out: V8 stack frames start with whitespace + "at ".
    // SpiderMonkey and JavaScriptCore use different shapes (e.g.
    // SpiderMonkey: "fn@file:line:col"). On those runtimes the
    // scrub regex below could over-match a partial-shape input,
    // so refuse to touch lines that don't look like V8 frames.
    // The package targets Node 18+ (V8) per package.json:engines;
    // the README's install section names the V8 dependence too.
    if (!/^\s*at\s/.test(line)) return line;
    return line.replace(
        /(\(?)(?:file:\/\/\/|[A-Za-z]:[\\/]|\/)[^()]+[/\\]([^/\\():]+:\d+:\d+)(\)?)/g,
        (_m, openParen, basenameAndPos, closeParen) => `${openParen}${basenameAndPos}${closeParen}`
    );
}

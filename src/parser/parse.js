// Top-level parse entry. Dispatches each logical line in the input
// to the appropriate helper, wires phase-2 fragment rewriting, and
// runs cross-reference validation. Returns the completed AST. Throws
// ParseError on any failure; the runParse wrapper catches and
// converts to a TupleResponse.

import { ParseError, ERR } from '../tuple-response.js';
import { LineSplitter, LineTokenizer, T } from '../tokenizer.js';
import { createInitialFormModel } from './initial-model.js';
import { BARE_NAMED_TEXT_RX } from './constants.js';
import { createParserState } from './state.js';
import {
    parseGlobalConfig,
    parseOptionSource,
    parseNamedText,
    parseNamedObject,
    handleBareTextNamedText,
    looksLikeNamedObject
} from './parse-toplevel.js';
import {
    parseColorsBlock,
    parseTooltipsBlock,
    parsePropertiesBlock
} from './parse-blocks.js';
import { parseContainerDecl, parseContainerBody } from './parse-containers.js';
import { rewriteTextToFragments } from './rewrite-fragments.js';
import { validateRefs } from './validate.js';

/**
 * @param {string} input          DSL source text
 * @param {object} controlSpec    control vocabulary the parser consults
 * @returns {object}              the form-model AST (see docs/architecture.md §4)
 * @throws {ParseError}           on any grammar, layout, or reference failure
 */
export function parse(input, controlSpec, opts = {}) {
    const state = createParserState(controlSpec, opts);
    const splitter = new LineSplitter(input);
    const lines = splitter.split();
    const model = createInitialFormModel();

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        if (line.indent !== 0) {
            throw new ParseError(
                ERR.PARSE_ERROR,
                `Unexpected indent at top level (got ${line.indent} spaces)`,
                line.startLine, 1
            );
        }

        // Bare-text named-text declaration: `name = \`decorated...\``.
        // Detected via regex before the tokenizer would error on the
        // backtick.
        const bareMatch = line.content.match(BARE_NAMED_TEXT_RX);
        if (bareMatch) {
            handleBareTextNamedText(model, bareMatch.groups.name, bareMatch.groups.value, line.startLine);
            i++;
            continue;
        }

        const tk = new LineTokenizer(line.content, line.startLine, line.breaks);
        const t0 = tk.peek();

        // Global config: `IDENT : value`.
        if (t0.kind === T.IDENT && tk.peek(1).kind === T.COLON) {
            parseGlobalConfig(tk, model);
            i++;
            continue;
        }

        // Top-level declarations: `IDENT = ...`.
        if (t0.kind === T.IDENT && tk.peek(1).kind === T.EQUALS) {
            if (t0.value === 'tooltips') {
                parseTooltipsBlock(tk, model);
            } else if (t0.value === 'colors') {
                parseColorsBlock(tk, model);
            } else if (t0.value === '__properties') {
                parsePropertiesBlock(tk, model);
            } else if (tk.peek(2).kind === T.STRING) {
                // String value -> named text declaration
                parseNamedText(tk, model);
            } else if (looksLikeNamedObject(tk)) {
                // Object literal -> named object declaration
                parseNamedObject(tk, model, line.startLine);
            } else {
                parseOptionSource(tk, model, line.startLine);
            }
            i++;
            continue;
        }

        // Root container: `[container(...)]` or `[>container(...)]`.
        if (t0.kind === T.LBRACKET) {
            if (model.root != null) {
                throw new ParseError(
                    ERR.PARSE_ERROR,
                    'Multiple root containers; only one allowed',
                    line.startLine, 1
                );
            }
            const root = parseContainerDecl(state, tk, line);
            i++;
            const consumed = parseContainerBody(state, lines, i, root, line.indent);
            model.root = root;
            i += consumed;
            continue;
        }

        throw new ParseError(
            ERR.PARSE_ERROR,
            `Unexpected token at top level: ${t0.kind}`,
            line.startLine, 1
        );
    }

    if (model.columns == null) {
        throw new ParseError(
            ERR.PARSE_ERROR,
            "Missing required 'columns: N' declaration",
            1, 1
        );
    }

    // Phase 2: rewrite raw text fields into TextFragment[] using
    // the now-complete colors map. Must run before validation so
    // the tooltips map is populated for cross-ref checks.
    rewriteTextToFragments(state, model);

    // Validate cross-references and binding policies.
    validateRefs(model);

    // Non-fatal scan. A successful parse can still produce messages
    // for quirky-but-legal shapes — today only option-source quirks
    // (empty list, empty entries, duplicate values). The single
    // helper below is the only writer to state.warnings; if more
    // warning categories appear later, add a sibling helper here
    // and let runParse lift the array into the messages output.
    collectOptionSourceWarnings(model, state);

    // Stash warnings on the model so runParse can lift them into the
    // TupleResponse messages array. Uses a non-enumerable field so
    // JSON dumps of the AST stay clean. Foot-gun note: an
    // `Object.assign({}, ast)` shallow copy elsewhere will silently
    // drop _warnings (non-enumerable properties don't transfer
    // through ...spread or Object.assign). runParse reads it from
    // the original model directly, not from a copy, so this is fine
    // there; future helpers that pass around a copied AST need to
    // re-copy `_warnings` explicitly via Object.defineProperty.
    if (state.warnings.length > 0) {
        Object.defineProperty(model, '_warnings', {
            value: state.warnings.slice(),
            enumerable: false,
            configurable: true,
            writable: false
        });
    }

    // Strip internal scratch fields before handing the AST out.
    delete model._rawTooltips;
    delete model._rawNamedText;

    return model;
}

function collectOptionSourceWarnings(model, state) {
    // No `??` fallback here. The model is always parser-produced
    // and createInitialFormModel always seeds optionSources as a
    // null-prototype map. A consumer reaching this function with a
    // hand-built model that omits optionSources is using the
    // package wrong; let the TypeError land so the bug is loud.
    for (const [name, src] of Object.entries(model.optionSources)) {
        if (src.type !== 'static') continue;
        if (!Array.isArray(src.values)) continue;
        if (src.values.length === 0) {
            state.warnings.push(`Option source '${name}' is empty; controls referencing it will have no choices.`);
            continue;
        }
        // Empty-string choices are almost always a typo (a stray
        // comma, an unfinished value). They render as a blank pick
        // in a select / multiselect / combo, which the user can
        // hit but cannot meaningfully distinguish. We don't refuse
        // them — a sink consumer might honestly want a "blank means
        // unset" entry — but the warning makes the shape visible
        // so the typo case gets caught before it ships.
        let emptyCount = 0;
        for (const v of src.values) {
            if (typeof v === 'string' && v.length === 0) emptyCount++;
        }
        if (emptyCount > 0) {
            state.warnings.push(
                emptyCount === 1
                    ? `Option source '${name}' contains an empty choice; controls will render a blank pick.`
                    : `Option source '${name}' contains ${emptyCount} empty choices; controls will render blank picks.`
            );
        }
        // Duplicates are detected by stringifying each value (the list
        // can hold scalars or named-object literals after phase 2). A
        // string representation collapses both shapes safely without
        // walking each named-object key.
        const seen = new Set();
        const dups = new Set();
        for (const v of src.values) {
            const k = typeof v === 'object' ? JSON.stringify(v) : String(v);
            if (seen.has(k)) dups.add(k); else seen.add(k);
        }
        if (dups.size > 0) {
            state.warnings.push(`Option source '${name}' has duplicate values: ${[...dups].join(', ')}.`);
        }
    }
}

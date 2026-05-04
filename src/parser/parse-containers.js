// Container, panel, and row parsing. Three node kinds share this
// file because they all use the same "header + body of indented
// lines" shape:
//
//   container    [container({title})] Title text
//   repeater     [repeater({items})] Items
//   listManager  [listManager({rows})] Rows
//
// The body of any of these is either a list of `- row` lines or a
// list of `1. Panel`/`2. Panel` markers. Containers and panels are
// peer concerns inside this file because the panels are a body
// shape, not a separate node kind.

import { ParseError, ERR } from '../tuple-response.js';
import { LineTokenizer, T } from '../tokenizer.js';
import { parseWhen } from '../expression.js';
import { PANEL_RX } from './constants.js';
import { parseBindingPath, collectLabel } from './binding-helpers.js';
import { parseRowItems, parseControlDecl } from './parse-controls.js';
import { safeGet, assertSafeObjectKey } from '../safe-keys.js';

// Container parameter dispatch table. The parser walks `key=value`
// pairs inside a container's parens (e.g. `panels=[1:8,2:12]`,
// `when="x == 1"`). Each entry below describes one parameter:
//
//   nodeKinds     optional Set restricting which container shapes
//                 accept this parameter. Omit to allow all shapes.
//   parse(state, tk, node, srcTok, key)
//                 consumes the value tokens off `tk` and writes
//                 them onto `node`. The handler can call other
//                 helper functions through the state and the
//                 imported names from this file.
//
// Adding a new container parameter is one entry below. The
// dispatcher in parseContainerParams doesn't have to change.

const LIST_MANAGER_ONLY = new Set(['listManager']);
const REPEATER_ONLY     = new Set(['repeater']);
const HEIGHT_KINDS      = new Set(['listManager', 'container']);

function parseBool(tk, key, srcTok) {
    const v = tk.expect(T.IDENT).value;
    if (v !== 'true' && v !== 'false') {
        throw new ParseError(
            ERR.INVALID_PARAM,
            `${key}= must be true or false, got '${v}'`,
            srcTok.line, srcTok.col
        );
    }
    return v === 'true';
}

const CONTAINER_PARAM_HANDLERS = Object.freeze({
    when: {
        parse(state, tk, node) {
            node.when = tk.expect(T.STRING).value;
            node.whenAst = parseWhen(node.when);
        }
    },
    panels: {
        parse(state, tk, node) {
            node.panels = parsePanelsParam(tk);
        }
    },
    min: {
        nodeKinds: REPEATER_ONLY,
        parse(state, tk, node, srcTok) {
            const tok = tk.expect(T.INTEGER);
            if (tok.value < 0) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `repeater min must be 0 or greater, got ${tok.value}`,
                    srcTok.line, srcTok.col
                );
            }
            node.itemMin = tok.value;
        }
    },
    max: {
        nodeKinds: REPEATER_ONLY,
        parse(state, tk, node, srcTok) {
            const tok = tk.expect(T.INTEGER);
            if (tok.value < 0) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `repeater max must be 0 or greater, got ${tok.value}`,
                    srcTok.line, srcTok.col
                );
            }
            node.itemMax = tok.value;
        }
    },
    search: {
        // search=true|false toggles the list's text-filter toolbar.
        nodeKinds: LIST_MANAGER_ONLY,
        parse(state, tk, node, srcTok, key) { node.search = parseBool(tk, key, srcTok); }
    },
    filter: {
        // filter="fieldName" picks which field on each item the
        // search box matches against. Defaults to the primary key
        // when left unset.
        nodeKinds: LIST_MANAGER_ONLY,
        parse(state, tk, node) { node.filter = tk.expect(T.STRING).value; }
    },
    draggable: {
        // draggable=true|false opts the list into drag-to-reorder.
        // Off by default. Most lists (categories, properties, tag
        // pools) are unordered sets where drag handles would just
        // clutter each row.
        nodeKinds: LIST_MANAGER_ONLY,
        parse(state, tk, node, srcTok, key) { node.draggable = parseBool(tk, key, srcTok); }
    },
    addLabel: {
        nodeKinds: LIST_MANAGER_ONLY,
        parse(state, tk, node) { node.addLabel = tk.expect(T.STRING).value; }
    },
    commit: {
        // commit={@fnName} attaches a function reference that the
        // renderer resolves at runtime. Same shape as the compute=
        // function reference on regular controls, kept symmetric
        // so the renderer's lookup stays uniform.
        nodeKinds: LIST_MANAGER_ONLY,
        parse(state, tk, node, srcTok) {
            tk.expect(T.LCURLY);
            const parts = parseBindingPath(tk);
            tk.expect(T.RCURLY);
            const path = parts.join('.');
            if (!path.startsWith('@')) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `commit= must reference a function (commit={@fn})`,
                    srcTok.line, srcTok.col
                );
            }
            node.commit = { kind: 'function', name: path.slice(1) };
        }
    },
    excluded: {
        // excluded=#refName references a static option source
        // declared at the top of the form. Items whose name matches
        // one of these are protected from the per-row delete
        // control.
        nodeKinds: LIST_MANAGER_ONLY,
        parse(state, tk, node) {
            const ref = tk.expect(T.HASH_IDENT);
            node.excludedRef = ref.value;
        }
    },
    // `height` is the legacy keyword and aliases `maxHeight`. Both
    // store the same field; the renderer reads node.maxHeight
    // regardless of which keyword was used.
    height: {
        nodeKinds: HEIGHT_KINDS,
        parse(state, tk, node) { node.maxHeight = tk.expect(T.STRING).value; }
    },
    maxHeight: {
        nodeKinds: HEIGHT_KINDS,
        parse(state, tk, node) { node.maxHeight = tk.expect(T.STRING).value; }
    },
    minHeight: {
        nodeKinds: HEIGHT_KINDS,
        parse(state, tk, node) { node.minHeight = tk.expect(T.STRING).value; }
    },
    // Containers and controls share one tooltip surface: a
    // `tt="key"` parameter that resolves into the top-level
    // `tooltips` map at validate time. Tooltip text is authored in
    // one place (the `tooltips` block) and referenced from anywhere
    // by key.
    tt: {
        parse(state, tk, node) { node.tooltipRef = tk.expect(T.STRING).value; }
    }
});

export function parseContainerDecl(state, tk, line) {
    tk.expect(T.LBRACKET);
    const collapsible = tk.accept(T.GT) != null;
    const typeIdent = tk.expect(T.IDENT);
    const typeName = typeIdent.value;

    if (typeName !== 'container' && typeName !== 'repeater' && typeName !== 'listManager') {
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Expected 'container', 'repeater', or 'listManager' at top of declaration, got '${typeName}'`,
            typeIdent.line, typeIdent.col
        );
    }

    const node = {
        nodeKind: typeName,
        collapsible,
        title:       [],          // TextFragment[]: literal, {binding}, or #ref-resolved
        description: [],          // TextFragment[]: ditto
        tooltipRef:  null,        // string key into model.tooltips (set by tt="key")
        headerControls: [],
        panels: null,
        rows: [],
        arrayBinding: null,
        itemMin: null,
        itemMax: null,
        // listManager-specific fields. Set only when nodeKind ===
        // 'listManager'; ignored by container/repeater walks. Each
        // one corresponds to a parameter accepted in
        // parseContainerParams below.
        search:    false,         // boolean. Render the search filter toolbar.
        filter:    null,          // string. Field name the search box matches against. Null when not set; renderers may fall back to 'name' as a convention. Plain containers leave this null too.
        draggable: false,         // boolean. Show drag handles and accept drop-to-reorder events.
        addLabel:  null,          // string.  Label on the [+ Add ...] button.
        commit:    null,          // { kind:'function', name }, the handler called on commit click.
        excludedRef: null,        // string.  Name of a static option source that lists protected items.
        // Vertical sizing fields, used by listManager's scroll
        // viewport and by container swimlane lanes. Both accept any
        // CSS length value ("300px", "20em", "60vh"). With only
        // maxHeight set, the viewport caps and scrolls. With only
        // minHeight set, an empty list still reserves vertical
        // room. The legacy `height` keyword is an alias for
        // `maxHeight`.
        minHeight: null,
        maxHeight: null,
        when: null,
        whenAst: null,
        label: [],   // TextFragment[], filled in during phase 2
        loc: { line: typeIdent.line, col: typeIdent.col, length: 0 }
    };

    if (tk.accept(T.LPAREN)) {
        parseContainerParams(state, tk, node);
        tk.expect(T.RPAREN);
    }

    tk.expect(T.RBRACKET);

    // Header controls run after the container's `]` and don't
    // carry their own labels. Any trailing text on the line belongs
    // to the container, where it becomes the container's visible
    // header text.
    while (tk.peek().kind === T.LBRACKET) {
        const headerCtl = parseControlDecl(state, tk, line, { skipLabel: true });
        node.headerControls.push(headerCtl);
    }

    // Capture the container's label text from after the last `]` to
    // end-of-line.
    const rawLabel = tk.consumeLabelAndAdvance();
    if (rawLabel.length > 0) {
        collectLabel(state, node, rawLabel, line.startLine);
    }

    // Repeater and listManager bind an array. Without a {path} the
    // node has no semantics; the renderer would have nothing to
    // iterate over. The `arrayBinding: string` type contract on the
    // public surface depends on this being non-null after parse.
    if ((typeName === 'repeater' || typeName === 'listManager') && node.arrayBinding == null) {
        throw new ParseError(
            ERR.INVALID_PARAM,
            `'${typeName}' requires an array binding (write '[${typeName}({fieldName}, ...)]' where {fieldName} names the array on the data object)`,
            typeIdent.line, typeIdent.col
        );
    }

    return node;
}

function parseContainerParams(state, tk, node) {
    let first = true;
    while (tk.peek().kind !== T.RPAREN) {
        if (!first) tk.expect(T.COMMA);
        first = false;
        const t = tk.peek();

        // {binding} becomes a text-slot fragment with kind:'binding'
        // (or kind:'function' for {@fn}). For repeater and
        // listManager, the first {path} is the array binding (must
        // be a data path, not a function reference).
        if (t.kind === T.LCURLY) {
            tk.next();
            const parts = parseBindingPath(tk);
            tk.expect(T.RCURLY);
            const path = parts.join('.');
            const isFn = path.startsWith('@');
            if ((node.nodeKind === 'repeater' || node.nodeKind === 'listManager') && node.arrayBinding == null) {
                if (isFn) {
                    throw new ParseError(ERR.INVALID_PARAM, `${node.nodeKind} array binding must be a data path, not a function`, t.line, t.col);
                }
                node.arrayBinding = path;
            } else {
                const frag = isFn
                    ? { kind: 'function', name: path.slice(1) }
                    : { kind: 'binding',  path };
                addContainerTextSlot(node, [frag], t);
            }
            continue;
        }

        // "Literal text" becomes a text fragment.
        if (t.kind === T.STRING) {
            tk.next();
            addContainerTextSlot(node, [{ kind: 'text', text: t.value }], t);
            continue;
        }

        // #name is a reference to named text or an option source.
        // Resolved during phase 2.
        if (t.kind === T.HASH_IDENT) {
            tk.next();
            addContainerTextSlot(node, [{ kind: 'ref', refName: t.value }], t);
            continue;
        }

        if (t.kind === T.IDENT) {
            const key = tk.next().value;
            tk.expect(T.EQUALS);
            // Screen the IDENT before reading off the dispatch table.
            // Without it, a parameter name like `__proto__` would
            // bracket-walk through Object.prototype and return a
            // truthy non-handler. The screen turns the input into a
            // clean INVALID_PARAM with the offending key surfaced.
            assertSafeObjectKey(key, `container parameter name`, t);
            const handler = safeGet(CONTAINER_PARAM_HANDLERS, key);
            if (!handler) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `Unknown container parameter '${key}'`,
                    t.line, t.col
                );
            }
            if (handler.nodeKinds && !handler.nodeKinds.has(node.nodeKind)) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `Container parameter '${key}' is not allowed on ${node.nodeKind}`,
                    t.line, t.col
                );
            }
            handler.parse(state, tk, node, t, key);
            continue;
        }

        throw new ParseError(ERR.PARSE_ERROR, `Unexpected token in container params: ${t.kind}`, t.line, t.col);
    }
}

function addContainerTextSlot(node, frags, srcTok) {
    if (node.title.length === 0) { node.title = frags; return; }
    if (node.description.length === 0) { node.description = frags; return; }
    throw new ParseError(
        ERR.PARSE_ERROR,
        `Too many text slots in container declaration (max 2: title, description)`,
        srcTok?.line ?? 0, srcTok?.col ?? 0
    );
}

function parsePanelsParam(tk) {
    // panels=[1:8, 2:12]
    tk.expect(T.LSQUARE);
    const panels = [];
    const seen = new Set();
    if (tk.peek().kind !== T.RSQUARE) {
        addPanelSpec(tk, panels, seen);
        while (tk.accept(T.COMMA)) addPanelSpec(tk, panels, seen);
    }
    tk.expect(T.RSQUARE);
    return panels;
}

function addPanelSpec(tk, panels, seen) {
    const numTok = tk.expect(T.INTEGER);
    // Match the PANEL_RX regex (`^(?<num>\d+)\.\s+...`) which only
    // accepts non-negative panel numbers. Without this check, a
    // negative number parses cleanly but no body line can ever
    // reference it (the regex won't match), so the panel sits
    // unreachable in the AST.
    if (numTok.value < 1) {
        throw new ParseError(
            ERR.INVALID_PARAM,
            `Panel number must be 1 or greater, got ${numTok.value}`,
            numTok.line, numTok.col
        );
    }
    if (seen.has(numTok.value)) {
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Duplicate panel number ${numTok.value} in panels=[...]`,
            numTok.line, numTok.col
        );
    }
    seen.add(numTok.value);
    tk.expect(T.COLON);
    const widthTok = tk.expect(T.INTEGER);
    // Width 0 is intentionally allowed. A zero-width panel renders
    // nothing, which a designer occasionally wants as a placeholder
    // entry that other tooling can fill in later. Negative widths
    // never make sense and are rejected.
    if (widthTok.value < 0) {
        throw new ParseError(
            ERR.INVALID_PARAM,
            `Panel ${numTok.value} width must be 0 or greater, got ${widthTok.value}`,
            widthTok.line, widthTok.col
        );
    }
    panels.push({ number: numTok.value, label: [], width: widthTok.value, rows: [] });
}

// Default cap on container nesting. The 1 MB input cap above bounds
// total work, but a hostile input with hundreds of nested
// `[container(...)]` declarations would stack-overflow before
// hitting any other limit. 16 levels covers any human-authored
// form (most top out around a dozen) and gives a focused error
// instead of a stack trace. The cap is configurable via the
// `maxNestingDepth` option on TextFormBuilder for callers that
// host machine-generated forms with deeper layouts.
//
// Off-by-one note: the comparison below is `depth > cap`, so a
// form whose deepest container sits at depth 16 parses fine; the
// 17th level throws. Error message reads "max 16" because the
// cap value is still the number authors think in.
export const MAX_NESTING_DEPTH = 16;

export function parseContainerBody(state, lines, start, container, parentIndent, depth = 0) {
    const cap = state.maxNestingDepth ?? MAX_NESTING_DEPTH;
    if (depth > cap) {
        throw new ParseError(
            ERR.INVALID_LAYOUT,
            `Container nesting too deep (${depth} levels; max ${cap}). Flatten the form or use panels.`,
            container.loc?.line ?? 0, container.loc?.col ?? 0
        );
    }
    // Consume lines whose indent is greater than parentIndent,
    // dispatching as panels (if container.panels was declared) or
    // as rows.
    let i = start;
    const bodyMode = container.panels != null ? 'panels' : 'rows';

    if (bodyMode === 'panels') {
        while (i < lines.length && lines[i].indent > parentIndent) {
            const line = lines[i];
            const m = line.content.match(PANEL_RX);
            if (!m) {
                throw new ParseError(
                    ERR.PARSE_ERROR,
                    `Expected panel marker '<n>. Name' inside multi-panel container`,
                    line.startLine, 1
                );
            }
            // PANEL_RX pinned `num` to /\d+/, so Number() is
            // unambiguous and reads cleaner than parseInt(...,10).
            const num = Number(m.groups.num);
            const panel = container.panels.find(p => p.number === num);
            if (!panel) {
                throw new ParseError(
                    ERR.PARSE_ERROR,
                    `Panel ${num} not declared in panels=[...]`,
                    line.startLine, 1
                );
            }
            collectLabel(state, panel, m.groups.label.trim(), line.startLine);
            i++;
            const consumed = parseRowsBody(state, lines, i, panel.rows, line.indent, depth);
            i += consumed;
        }
    } else {
        const consumed = parseRowsBody(state, lines, i, container.rows, parentIndent, depth);
        i += consumed;
        // Mutually exclusive: rows xor panels
        if (container.rows.length > 0 && container.panels != null) {
            throw new ParseError(ERR.PARSE_ERROR, `Container has both rows and panels`, container.loc.line, 1);
        }
    }

    return i - start;
}

function parseRowsBody(state, lines, start, rows, parentIndent, depth = 0) {
    let i = start;
    while (i < lines.length && lines[i].indent > parentIndent) {
        const line = lines[i];
        const tk = new LineTokenizer(line.content, line.startLine, line.breaks);
        const t0 = tk.peek();

        if (t0.kind === T.DASH) {
            tk.next();  // consume -
            const row = { nodeKind: 'row', controls: [], loc: { line: line.startLine, col: 1, length: 0 } };
            parseRowItems(state, tk, row, line);
            rows.push(row);
            i++;

            // If the row's last item is a sub-container, parse its
            // body (lines at deeper indent). Each level adds 1 to
            // the depth counter; the cap fires inside
            // parseContainerBody before further recursion happens.
            const lastItem = row.controls[row.controls.length - 1];
            if (lastItem && (lastItem.nodeKind === 'container' || lastItem.nodeKind === 'repeater' || lastItem.nodeKind === 'listManager')) {
                const subConsumed = parseContainerBody(state, lines, i, lastItem, line.indent, depth + 1);
                i += subConsumed;
            }

            // Continuations: any line at deeper indent that starts
            // with `|` adds more items to the same row.
            while (i < lines.length && lines[i].indent > line.indent) {
                const cl = lines[i];
                const ck = new LineTokenizer(cl.content, cl.startLine, cl.breaks);
                if (ck.peek().kind !== T.BAR) break;
                ck.next();  // consume |
                parseRowItems(state, ck, row, cl);
                i++;
            }
            continue;
        }

        throw new ParseError(
            ERR.PARSE_ERROR,
            `Expected row marker '-' at indent ${line.indent}, got ${t0.kind}`,
            line.startLine, 1
        );
    }
    return i - start;
}

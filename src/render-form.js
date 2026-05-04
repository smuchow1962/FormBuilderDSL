// renderForm(ast) — emit `.mmpform` text from a parsed AST.
//
// The inverse of `TextFormBuilder.parse()`. Walks every node in the
// model and produces source text that round-trips: feeding the
// output back through `parse()` produces an equivalent AST. Useful
// for editor tooling that mutates the AST (drag-to-reorder a row,
// toggle a `collapsible` flag, rename a binding) and writes the
// source back; for "diff between two parsed forms" workflows that
// produce a normalised text shape on each side; and for machine-
// generated forms whose source needs to be hand-readable.
//
// What round-trip preservation means here:
//   - The AST shape after a parse → render → parse cycle is
//     equivalent to the input AST. Field values, nested structure,
//     param lists, and binding metadata all carry through.
//   - Text formatting (whitespace, indent style, comment placement)
//     is normalised. The output uses 4-space indent; comments are
//     not emitted (the parser strips them and the AST does not
//     carry them, so this writer cannot put them back).
//   - The output is canonical: two ASTs that differ only by
//     incidental whitespace produce identical text. That makes
//     the emitter safe to use for diff workflows.
//
// What this is NOT:
//   - Not a pretty-printer for an arbitrary user's source. Comments
//     and idiomatic spacing are lost on the round trip.
//   - Not a one-to-one byte-preserving formatter. The tokenizer
//     doesn't carry positions or comments through to the AST.

import { writeQuotedString } from './string-literal.js';
import { renderPropertiesBlock } from './property-collector.js';

/**
 * Emit `.mmpform` source text from a parsed AST.
 *
 * @param {object | null | undefined} ast  a FormModel from `parse()` or `process()`
 * @param {{ indent?: string }} [opts]
 * @returns {string} canonical source text; round-trips through `parse()`
 */
export function renderForm(ast, opts = {}) {
    if (!ast) return '';
    const indent = opts.indent ?? '    ';
    const lines = [];

    // 1. columns: N
    lines.push(`columns: ${ast.columns ?? 12}`);
    lines.push('');

    // 2. colors block
    if (ast.colors && Object.keys(ast.colors).length > 0) {
        lines.push(renderNamedMap('colors', ast.colors, (v) => writeQuotedString(v)));
        lines.push('');
    }

    // 3. tooltips block
    if (ast.tooltips && Object.keys(ast.tooltips).length > 0) {
        lines.push(renderNamedMap('tooltips', ast.tooltips, (frags) => writeQuotedString(fragmentsToSource(frags))));
        lines.push('');
    }

    // 4. named text bodies
    if (ast.namedText) {
        for (const [name, frags] of Object.entries(ast.namedText)) {
            lines.push(`${name} = ${writeQuotedString(fragmentsToSource(frags))}`);
        }
        if (Object.keys(ast.namedText).length > 0) lines.push('');
    }

    // 5. named objects
    if (ast.namedObjects) {
        for (const [name, obj] of Object.entries(ast.namedObjects)) {
            lines.push(renderNamedObject(name, obj));
        }
        if (Object.keys(ast.namedObjects).length > 0) lines.push('');
    }

    // 6. option sources
    if (ast.optionSources) {
        for (const [name, src] of Object.entries(ast.optionSources)) {
            lines.push(renderOptionSource(name, src));
        }
        if (Object.keys(ast.optionSources).length > 0) lines.push('');
    }

    // 7. __properties block (if hydrated)
    if (ast.__properties && Object.keys(ast.__properties).length > 0) {
        lines.push(renderPropertiesBlock(ast.__properties, { indent }));
        lines.push('');
    }

    // 8. root container
    if (ast.root) {
        lines.push(...renderContainer(ast.root, 0, indent));
    }

    return lines.join('\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------
// Block helpers
// ---------------------------------------------------------------

function renderNamedMap(blockName, map, valueWriter) {
    const entries = Object.entries(map);
    if (entries.length === 0) return `${blockName} = []`;
    const parts = entries.map(([k, v]) => `${writeQuotedString(k)} = ${valueWriter(v)}`);
    return `${blockName} = [${parts.join(', ')}]`;
}

function renderNamedObject(name, obj) {
    const pk = obj.__pk;   // non-enumerable; only true when source declared !field
    const parts = [];
    for (const [k, v] of Object.entries(obj)) {
        const prefix = k === pk ? '!' : '';
        parts.push(`${prefix}${k}: ${formatScalar(v)}`);
    }
    return `${name} = { ${parts.join(', ')} }`;
}

function renderOptionSource(name, src) {
    if (src.type === 'dynamic') {
        return `${name} = {${src.path}}`;
    }
    // static: ["a", "b", ...] -> {binding} -> {binding} ...
    const valuesText = (src.values ?? []).map(formatOptionValue).join(', ');
    let out = `${name} = [${valuesText}]`;
    for (const b of src.bindings ?? []) {
        out += ` -> {${b}}`;
    }
    return out;
}

function formatOptionValue(v) {
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
        // Resolved named-object body. Render as inline object.
        const parts = Object.entries(v).map(([k, val]) => `${k}: ${formatScalar(val)}`);
        return `{ ${parts.join(', ')} }`;
    }
    return formatScalar(v);
}

function formatScalar(v) {
    if (v === null)               return 'null';
    if (typeof v === 'boolean')   return v ? 'true' : 'false';
    if (typeof v === 'number')    return String(v);
    if (typeof v === 'string')    return writeQuotedString(v);
    return writeQuotedString(String(v));
}

// ---------------------------------------------------------------
// Container / row / control rendering
// ---------------------------------------------------------------

function renderContainer(node, depth, indent) {
    const pad = indent.repeat(depth);
    const lines = [];
    const head = renderContainerHead(node);
    lines.push(`${pad}${head}`);
    if (node.headerControls && node.headerControls.length > 0) {
        // Header controls render on the same logical line as the
        // container declaration, but the parser doesn't preserve
        // exact placement; emit each on its own line under the
        // container head with one extra indent step.
        for (const hc of node.headerControls) {
            lines.push(`${pad}${indent}${renderControl(hc)}`);
        }
    }
    if (node.panels) {
        // Multi-panel container body. Each panel renders as a
        // `<num>. <label>` marker line at one extra indent step
        // (the parser matches these via PANEL_RX = /^(?<num>\d+)\.\s+(?<label>.+)$/);
        // its rows live underneath at one further indent. The
        // `panels=[1:8,2:12]` head param tells the parser to switch
        // into panel-body mode (parse-containers.js: bodyMode).
        for (const p of node.panels) {
            const labelText = (p.label && p.label.length > 0)
                ? fragmentsToSource(p.label)
                : `Panel ${p.number}`;
            lines.push(`${pad}${indent}${p.number}. ${labelText}`);
            for (const r of p.rows ?? []) {
                lines.push(...renderRow(r, depth + 2, indent));
            }
        }
    } else if (node.rows) {
        for (const r of node.rows) {
            lines.push(...renderRow(r, depth + 1, indent));
        }
    }
    return lines;
}

function renderContainerHead(node) {
    const params = [];

    // The first parameter is conventionally the binding (for
    // repeater/listManager) or a label/title fragment ref. The
    // parser distinguishes via the dedicated fields on the node.
    if (node.arrayBinding) params.push(`{${node.arrayBinding}}`);
    if (node.title && node.title.length > 0) {
        params.push(formatFragmentParam(node.title));
    }
    if (node.description && node.description.length > 0) {
        params.push(formatFragmentParam(node.description));
    }

    // Container-level params with a non-default value. Note:
    // `collapsible` is NOT a parameter — the parser models it via
    // the leading `>` syntax (`[>container(...)]`) and emitting it
    // as a param would fail to re-parse. The `>` is added when the
    // `[${kind}(...)]` is built at the bottom of this function.
    if (node.search)     params.push('search=true');
    if (node.draggable)  params.push('draggable=true');
    if (node.filter)     params.push(`filter="${node.filter}"`);
    if (node.addLabel)   params.push(`addLabel=${writeQuotedString(node.addLabel)}`);
    if (node.commit)     params.push(`commit={@${node.commit.name}}`);
    if (node.excludedRef) params.push(`excluded=#${node.excludedRef}`);
    if (node.itemMin != null) params.push(`min=${node.itemMin}`);
    if (node.itemMax != null) params.push(`max=${node.itemMax}`);
    if (node.minHeight) params.push(`minHeight=${writeQuotedString(node.minHeight)}`);
    if (node.maxHeight) params.push(`maxHeight=${writeQuotedString(node.maxHeight)}`);
    if (node.tooltipRef) params.push(`tt=${writeQuotedString(node.tooltipRef)}`);
    if (node.when) params.push(`when=${writeQuotedString(node.when)}`);

    // `panels=[1:8,2:12]` head param tells the parser to switch
    // into panel-body mode. Without it, the body parser dispatches
    // to rows mode and the `<n>. <label>` markers in the body
    // raise PARSE_ERROR ("expected `- ` row marker").
    if (node.panels && node.panels.length > 0) {
        const panelList = node.panels.map(p => `${p.number}:${p.width}`).join(',');
        params.push(`panels=[${panelList}]`);
    }

    // `>` prefix on the type name carries the collapsible flag
    // (parse-containers.js:176 — `tk.accept(T.GT)`). The flag is
    // not a container param; emitting it as one fails to re-parse.
    const kindPrefix = node.collapsible ? '>' : '';
    const kind = node.nodeKind === 'container' ? 'container'
              :  node.nodeKind === 'repeater'  ? 'repeater'
              :                                  'listManager';
    const label = node.label && node.label.length > 0 ? ` ${fragmentsToSource(node.label)}` : '';
    return `[${kindPrefix}${kind}(${params.join(',')})]${label}`;
}

function renderRow(row, depth, indent) {
    const pad = indent.repeat(depth);
    const items = (row.controls ?? []).map(item => {
        if (item.nodeKind === 'control') return renderControl(item);
        // Nested container/repeater/listManager inside a row: emit
        // its declaration on the row line and let rows below indent.
        return renderContainerHead(item);
    });
    return [`${pad}- ${items.join(' ')}`];
}

function renderControl(ctl) {
    const params = [];
    if (ctl.width != null) params.push(String(ctl.width));
    if (ctl.binding) {
        const typeSuffix = ctl.bindingType ? `:${ctl.bindingType}` : '';
        params.push(`{${ctl.binding}${typeSuffix}}`);
    }
    if (ctl.contentRef)    params.push(`#${ctl.contentRef}`);
    if (ctl.optionsSource) params.push(`#${ctl.optionsSource}`);

    // Hoisted fields go back into params.
    if (ctl.dataType)      params.push(`__dataType=${ctl.dataType}`);
    if (ctl.tooltipRef)    params.push(`tt=${writeQuotedString(ctl.tooltipRef)}`);
    if (ctl.when)          params.push(`when=${writeQuotedString(ctl.when)}`);
    if (ctl.init)          params.push(`init=${formatInit(ctl.init)}`);
    if (ctl.compute)       params.push(`compute={@${ctl.compute.name}}`);
    if (ctl.explain && ctl.explain.length > 0) {
        params.push(`explain=${writeQuotedString(fragmentsToSource(ctl.explain))}`);
    }

    // Free-form params from the spec dispatch.
    for (const [k, v] of Object.entries(ctl.params ?? {})) {
        params.push(`${k}=${formatScalar(v)}`);
    }

    const label = ctl.label && ctl.label.length > 0 ? ` ${fragmentsToSource(ctl.label)}` : '';
    return `[${ctl.controlType}(${params.join(',')})]${label}`;
}

function formatInit(init) {
    if (init.kind === 'literal')  return formatScalar(init.value);
    if (init.kind === 'binding')  return `{${init.path}}`;
    if (init.kind === 'function') return `{@${init.name}}`;
    return 'null';
}

// ---------------------------------------------------------------
// Fragment helpers
// ---------------------------------------------------------------

// Rebuild a TextFragment[] back into source text with backtick
// decorator spans. The inverse of parseDecorated.
function fragmentsToSource(frags) {
    if (!frags || frags.length === 0) return '';
    let out = '';
    let activeStyle = {};
    for (const f of frags) {
        const style = f.style ?? {};
        if (!stylesEqual(style, activeStyle)) {
            out += '`' + encodeStyleCodes(style) + '`';
            activeStyle = style;
        }
        if (f.kind === 'text')     out += escapeLabelText(f.text ?? '');
        else if (f.kind === 'binding')  out += `{${f.path}}`;
        else if (f.kind === 'function') out += `{@${f.name}}`;
    }
    return out;
}

function fragmentBindingPath(frags) {
    if (!frags || frags.length !== 1) return null;
    const f = frags[0];
    if (f.kind === 'binding') return f.path;
    return null;
}

// Pick the right shape for a title/description container param.
// If the source authored it as a single `{path}` binding, emit the
// `{path}` shape (the parser prefers it). Otherwise encode the
// full fragments and quote them.
function formatFragmentParam(frags) {
    const path = fragmentBindingPath(frags);
    if (path != null) return `{${path}}`;
    return writeQuotedString(fragmentsToSource(frags));
}

function escapeLabelText(text) {
    return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/`/g,  '\\`')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}');
}

function stylesEqual(a, b) {
    return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

function encodeStyleCodes(style) {
    if (!style || Object.keys(style).length === 0) return 'r';
    const codes = [];
    if (style.bold)          codes.push('b');
    if (style.italic)        codes.push('i');
    if (style.underline)     codes.push('u');
    if (style.strikethrough) codes.push('s');
    if (typeof style.sizeStep === 'number') {
        for (let i = 0; i < Math.abs(style.sizeStep); i++) {
            codes.push(style.sizeStep > 0 ? '+' : '-');
        }
    }
    if (style.fg?.name)     codes.push(`:${style.fg.name}`);
    else if (style.fg?.resolved) codes.push(style.fg.resolved);
    if (style.bg?.name)     codes.push(`bg:${style.bg.name}`);
    else if (style.bg?.resolved) codes.push(`bg${style.bg.resolved}`);
    return codes.join('');
}

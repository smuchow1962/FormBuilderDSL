// renderFormPreview(ast, opts). Produces an ASCII drawing of the
// parsed form. Useful for console output, capturing into a string for
// tests, or pasting into a code review.
//
//   const text = renderFormPreview(ast, { width: 128 });
//   console.log(text);
//
// Options:
//   width     total character width of the rendered output (default 128)
//   showInit  show init values when present (default true)
//   showWhen  list `when=` conditions in a footer (default true)
//
// The function is pure. No side effects, no I/O, returns a string.

import { renderFragments } from './text-fragment.js';
import { safeGet } from './safe-keys.js';

const CHARS = {
    h:  '─', v:  '│',
    tl: '┌', tr: '┐', bl: '└', br: '┘',
    l:  '├', r:  '┤', t:  '┬', b:  '┴', x:  '┼',
    dh: '═', dl: '╞', dr: '╡',
    space: ' '
};

// Every node kind that renders as a nested header rather than as an
// inline control cell. Adding a new container-shaped nodeKind needs an
// entry here so the preview stops trying to format it as a row item.
const SUB_CONTAINER_KINDS = new Set(['container', 'repeater', 'listManager']);

export function renderFormPreview(ast, opts = {}) {
    if (!ast || !ast.root) return '(empty form)';
    const totalWidth = opts.width ?? 128;
    const showInit   = opts.showInit ?? true;
    const showWhen   = opts.showWhen ?? true;
    const ctx = {
        columns: ast.columns ?? 12,
        totalWidth,
        showInit,
        showWhen,
        tooltipsMap: ast.tooltips ?? {},
        whenList: []
    };

    const lines = [];
    renderTitleBar(ast.root, lines, ctx);
    renderContainerBody(ast.root, lines, ctx, totalWidth - 2, '');
    closeBox(lines, totalWidth);

    if (ctx.showWhen && ctx.whenList.length > 0) {
        lines.push('');
        lines.push('Conditional visibility:');
        for (const w of ctx.whenList) {
            lines.push(`  • ${w.label} when ${w.expr}`);
        }
    }

    return lines.join('\n');
}

function renderTitleBar(root, lines, ctx) {
    const w = ctx.totalWidth;
    lines.push(CHARS.tl + CHARS.h.repeat(w - 2) + CHARS.tr);

    const title = fragsToText(root.title);
    if (title) lines.push(boxRow(title, w));

    const desc = fragsToText(root.description);
    if (desc) lines.push(boxRow(desc, w));

    // Container nodes only carry a tooltipRef (the language has one
    // tooltip surface, shared with controls). The actual tooltip
    // text lives in the top-level `tooltips` map, looked up by key.
    const rootTip = root.tooltipRef ? safeGet(ctx.tooltipsMap, root.tooltipRef) : null;
    if (rootTip) {
        const tip = fragsToText(rootTip);
        if (tip) lines.push(boxRow('  ⓘ  ' + tip, w));
    }

    if (title || desc || root.tooltipRef) {
        lines.push(CHARS.l + CHARS.h.repeat(w - 2) + CHARS.r);
    }
}

function closeBox(lines, w) {
    lines.push(CHARS.bl + CHARS.h.repeat(w - 2) + CHARS.br);
}

function renderContainerBody(container, lines, ctx, innerW, indent) {
    if (container.panels) {
        for (const p of container.panels) {
            renderPanel(p, lines, ctx, innerW, indent);
        }
    } else if (container.rows) {
        for (const row of container.rows) {
            renderRow(row, lines, ctx, innerW, indent);
        }
    }
}

function renderPanel(panel, lines, ctx, innerW, indent) {
    const label = fragsToText(panel.label);
    const header = `${indent}▾ Panel ${panel.number}: ${label}  (${panel.width}/${ctx.columns})`;
    lines.push(boxRow(header, ctx.totalWidth));
    for (const row of panel.rows) {
        renderRow(row, lines, ctx, innerW, indent + '  ');
    }
}

function renderRow(row, lines, ctx, innerW, indent) {
    // Distribute innerW across controls based on each control's column weight.
    // First check whether the row holds a sub-container. Those render
    // as nested headers instead of as an inline cell, so they take a
    // different code path entirely.
    const ctls = row.controls;
    if (ctls.length === 1 && SUB_CONTAINER_KINDS.has(ctls[0].nodeKind)) {
        renderSubContainer(ctls[0], lines, ctx, innerW, indent);
        return;
    }

    // Compute char widths from column weights
    const totalCols = ctls.reduce((s, c) => s + (c.width ?? 0), 0) || ctx.columns;
    const usable = innerW - indent.length - ctls.length;  // dividers between controls
    const widths = ctls.map(c => Math.max(8, Math.floor((c.width / totalCols) * usable)));

    // Build control labels and types
    const cells = ctls.map((c, i) => formatControl(c, widths[i], ctx));
    const line = indent + cells.join(' ');
    lines.push(boxRow(line, ctx.totalWidth));
}

function renderSubContainer(c, lines, ctx, innerW, indent) {
    const headerParts = [indent];
    if (c.collapsible) headerParts.push('▾ ');
    const labelText = fragsToText(c.label);
    headerParts.push(labelText || '(container)');

    if (c.headerControls.length > 0) {
        const inline = c.headerControls.map(h => `[${h.controlType}]`).join(' ');
        headerParts.push(' ' + inline);
    }

    const containerTip = c.tooltipRef ? safeGet(ctx.tooltipsMap, c.tooltipRef) : null;
    if (containerTip) {
        headerParts.push(`  ⓘ ${fragsToText(containerTip)}`);
    }

    lines.push(boxRow(headerParts.join(''), ctx.totalWidth));

    if (c.panels) {
        for (const p of c.panels) renderPanel(p, lines, ctx, innerW, indent + '  ');
    } else if (c.rows) {
        for (const row of c.rows) renderRow(row, lines, ctx, innerW, indent + '  ');
    }
}

function formatControl(c, charW, ctx) {
    const label = fragsToText(c.label) || '';
    const widget = widgetGlyph(c);
    const tt = c.tooltipRef && safeGet(ctx.tooltipsMap, c.tooltipRef)
        ? ` ⓘ`
        : '';
    let inner;
    if (c.controlType === 'label') {
        inner = label || '(label)';
    } else if (c.controlType === 'display') {
        const path = c.binding ? `{${c.binding}}` : (c.contentRef ? `#${c.contentRef}` : '(display)');
        inner = label ? `${label}: ${path}` : path;
    } else {
        const bindStr = c.binding ? `{${c.binding}}` : '';
        inner = `${label || c.controlType}${bindStr ? ' ' + bindStr : ''}`;
    }

    let init = '';
    if (ctx.showInit && c.init) {
        if (c.init.kind === 'literal') init = ` =${JSON.stringify(c.init.value)}`;
        else if (c.init.kind === 'binding') init = ` ={${c.init.path}}`;
        else if (c.init.kind === 'function') init = ` ={@${c.init.name}}`;
    }

    if (ctx.showWhen && c.when) {
        ctx.whenList.push({ label: label || c.controlType, expr: c.when });
    }

    const text = `${inner}${init}${tt} ${widget}`;
    return padOrTrunc(`[${text}]`, charW);
}

function widgetGlyph(c) {
    switch (c.controlType) {
        case 'select':      return '▾';
        case 'combo':       return '▾';
        case 'multiselect': return '▾▾';
        case 'check':       return '☐';
        case 'toggle':      return '◉';
        case 'radio':       return '◯';
        case 'slider':      return '═';
        case 'date':        return '📅';
        case 'time':        return '🕒';
        case 'datetime':    return '📅🕒';
        case 'daterange':   return '📅—📅';
        case 'file':        return '📁';
        case 'color':       return '◼';
        case 'password':    return '🔒';
        case 'hidden':      return '○';
        case 'label':       return '';
        case 'display':     return '';
        // Unknown / consumer-defined control types render with a
        // generic glyph so the row is visually distinguishable from
        // a label or display block (which intentionally have no
        // glyph). The author of a custom control sees their widget
        // appear in the preview without needing to extend this
        // table.
        default:            return '◆';
    }
}

function fragsToText(fragments) {
    if (!fragments || fragments.length === 0) return '';
    return renderFragments(fragments, {}, {}, { mode: 'plain' });
}

function boxRow(text, w) {
    const inner = w - 2;
    const padded = padOrTrunc(text, inner);
    return CHARS.v + padded + CHARS.v;
}

function padOrTrunc(s, w) {
    const visualLen = visibleLen(s);
    if (visualLen >= w) {
        // Truncate while preserving multi-byte glyphs at the end
        let out = '';
        let used = 0;
        for (const ch of s) {
            const cw = charWidth(ch);
            if (used + cw > w) break;
            out += ch;
            used += cw;
        }
        return out + ' '.repeat(Math.max(0, w - used));
    }
    return s + ' '.repeat(w - visualLen);
}

function visibleLen(s) {
    let n = 0;
    for (const ch of s) n += charWidth(ch);
    return n;
}

// Approximate char width in monospace cells. ASCII and most BMP =
// 1; wide CJK, fullwidth forms, and emoji presentation = 2. The
// approximation matches the East Asian Width "Wide" / "Fullwidth"
// classes from Unicode TR 11 closely enough for ASCII preview
// output. A label that mixes wide and narrow characters lays out
// with the correct visual padding so the surrounding box does not
// over- or under-pad.
function charWidth(ch) {
    const code = ch.codePointAt(0);
    // Emoji block (presentation form is double-wide in monospace
    // fonts on every platform that ships emoji).
    if (code >= 0x1F300 && code <= 0x1FAFF) return 2;
    // East Asian Wide ranges. The boundaries here cover the bulk
    // of CJK Unified Ideographs, Hangul, Kana, and the fullwidth
    // forms a sink author is likely to display. The list is the
    // pragmatic Unicode TR 11 "Wide" set, not exhaustive — adding
    // a missing range is a one-entry change.
    if (code >= 0x1100 && code <= 0x115F)  return 2;   // Hangul Jamo
    if (code >= 0x2E80 && code <= 0x303E)  return 2;   // CJK Radicals + Kangxi + CJK Symbols
    if (code >= 0x3041 && code <= 0x33FF)  return 2;   // Hiragana, Katakana, CJK strokes
    if (code >= 0x3400 && code <= 0x4DBF)  return 2;   // CJK Extension A
    if (code >= 0x4E00 && code <= 0x9FFF)  return 2;   // CJK Unified Ideographs
    if (code >= 0xA000 && code <= 0xA4CF)  return 2;   // Yi
    if (code >= 0xAC00 && code <= 0xD7A3)  return 2;   // Hangul Syllables
    if (code >= 0xF900 && code <= 0xFAFF)  return 2;   // CJK Compatibility Ideographs
    if (code >= 0xFE30 && code <= 0xFE4F)  return 2;   // CJK Compatibility Forms
    if (code >= 0xFF00 && code <= 0xFF60)  return 2;   // Fullwidth Forms
    if (code >= 0xFFE0 && code <= 0xFFE6)  return 2;   // Fullwidth signs
    if (code >= 0x20000 && code <= 0x3FFFF) return 2;  // CJK Extensions B–F
    // Misc / dingbats / box drawing render as single cells. This
    // is a deliberate monospace-consistency choice rather than a
    // Unicode-correct width: a few characters in this range
    // (☐ ☑ ◯) render wide on some terminals, but the ASCII preview
    // in this package targets fixed-width snapshots and CLI
    // diagnostics where treating them as one cell keeps the box
    // alignment stable.
    if (code >= 0x2500  && code <= 0x27BF)  return 1;
    return 1;
}

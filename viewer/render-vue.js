// render-vue.js — mount a Vue 3 + Vuetify 3 form from the AST.
//
//   mountVueRenderer(rootElement, ast, schema, { theme: 'dark'|'light' });
//
// Walks the AST and dispatches each ControlNode to a Vuetify component
// with a v-model bound to a reactive data object built from the schema.
// Re-mount the app on each call (no diffing across schema changes).

import { walkAst } from '../src/walk-ast.js';

const { createApp, h, reactive, watch, watchEffect, onUnmounted, ref, computed } = window.Vue ?? {};
const Vuetify = window.Vuetify;
const createVuetify = Vuetify?.createVuetify;

// Vuetify 3.4+ stopped auto-registering components in its install hook —
// the components and directives objects must be passed explicitly to
// createVuetify(). Pull them off the UMD bundle's namespace; some
// versions expose `.components`/`.directives` and some scatter the
// VFoo entries on the namespace itself.
function collectComponents() {
    if (!Vuetify) return {};
    if (Vuetify.components && Object.keys(Vuetify.components).length > 0) return Vuetify.components;
    return Object.fromEntries(
        Object.entries(Vuetify).filter(([k, v]) =>
            typeof v === 'object' && v !== null && k.startsWith('V'))
    );
}
function collectDirectives() {
    if (!Vuetify) return {};
    return Vuetify.directives ?? {};
}

const components = collectComponents();
const directives = collectDirectives();

// Diagnostic logging is gated on the viewer's debug flag. The flag
// is set on the global by viewer.js when the URL carries `?debug=1`;
// without it, render-vue stays quiet at module load. Useful for
// sorting out CDN / mount issues without spamming the console in
// steady state.
const VIEWER_DEBUG = globalThis.__FB_VIEWER_DEBUG__ === true;
if (VIEWER_DEBUG) {
    console.info(
        '[render-vue] Vue', window.Vue?.version ?? '?',
        '· Vuetify', Vuetify?.version ?? '?',
        '· components registered:', Object.keys(components).length
    );
}

// Component reference lookup — bypasses Vue's string-based component
// resolution (which has been unreliable across Vuetify versions). h(C('VFoo'))
// passes the actual component reference, which always works.
function C(name) {
    return components[name] ?? name;
}

let activeApp = null;

export function mountVueRenderer(rootEl, ast, schema, opts = {}) {
    teardown();
    rootEl.innerHTML = '';

    // Diagnostic banner. Painted only when the viewer's debug flag
    // is on (URL `?debug=1`). Without the flag, the mount goes
    // straight to the form so the visual surface is uncluttered.
    // The CDN-load checks below still fire either way; the banner
    // is purely a diagnostic surface.
    const vuetifyOk  = !!Vuetify;
    const vueOk      = !!createApp;
    const compsCount = Object.keys(components).length;
    if (VIEWER_DEBUG) {
        const banner = document.createElement('div');
        banner.style.cssText = 'padding:6px 10px;background:#1f2228;color:#8a8d94;font-size:11px;border-bottom:1px solid #3a3d44;font-family:monospace;';
        banner.textContent =
            `Vue ${window.Vue?.version ?? '✗'}  ·  Vuetify ${Vuetify?.version ?? '✗'}  ·  Components: ${compsCount}` +
            (vueOk && vuetifyOk && compsCount > 0 ? '  ✓' : '  ✗');
        rootEl.appendChild(banner);
    }

    if (!vuetifyOk) { addError(rootEl, 'Vuetify failed to load from CDN. Check the Network tab for vuetify.min.js.'); return null; }
    if (!vueOk)     { addError(rootEl, 'Vue 3 failed to load from CDN. Check the Network tab for vue.global.prod.js.'); return null; }
    if (compsCount === 0) { addError(rootEl, 'Vuetify loaded but no components were found. Pin to a different CDN version.'); return null; }
    if (!ast) {
        const p = document.createElement('p');
        p.textContent = '(parse to render)';
        p.style.cssText = 'padding:20px;color:#8a8d94;';
        rootEl.appendChild(p);
        return null;
    }

    // Mount Vue into a child div, not the root — keeps the diagnostic banner alive
    // even if Vue replaces children of its mount target.
    const appMount = document.createElement('div');
    appMount.id = 'vue-app-mount';
    appMount.style.cssText = 'flex:1;overflow:auto;';
    rootEl.appendChild(appMount);
    rootEl.style.cssText = 'display:flex;flex-direction:column;height:100%;';

    const data = reactive(buildInitialData(schema, ast));
    const functions = opts.functions ?? window.formFunctions ?? {};

    // Wire compute= functions: re-run when any read data field changes,
    // write the result back into the bound field. Vue's reactivity tracks
    // dependencies automatically — no explicit watches= list needed.
    if (ast?.root && watchEffect) walkControls(ast.root, (ctl) => {
        if (ctl.compute?.kind === 'function' && ctl.binding && !ctl.binding.startsWith('@')) {
            const fn = functions[ctl.compute.name];
            if (typeof fn !== 'function') {
                console.info(`[render-vue] compute fn '${ctl.compute.name}' not in registry; ${ctl.binding} stays at its init`);
                return;
            }
            watchEffect(() => {
                try {
                    const next = fn(data);
                    if (next !== undefined) setDeep(data, ctl.binding, next);
                } catch (e) {
                    console.warn(`[render-vue] compute '${ctl.compute.name}' threw:`, e);
                }
            });
        }
    });
    const theme = opts.theme ?? 'dark';

    // No <v-app> wrapper — Vuetify 3 components render fine without it for the
    // form preview, and v-app's layout assumptions (viewport-tall, slot system)
    // collide with our flex-bounded container. Theme is applied via createVuetify.
    // Outer .fb-form-page gives the form room around the card; the v-card itself
    // gives a familiar surface + border so the form doesn't run to the pane edge.
    const App = {
        setup() {
            // Live-data inspector. When the host page passes a target
            // element (typically the `<pre>` in the Live Data tab), every
            // reactive change to the form data writes a fresh JSON view
            // into it. The watchEffect lives inside setup() so it gets
            // disposed automatically when teardown() unmounts the app —
            // no leaked subscriptions across re-renders.
            // Same `watchEffect` guard as the compute= wiring above.
            // The CDN-loaded Vue module always exposes watchEffect; the
            // guard is defence in case a future bundler swap drops a
            // tree-shaken Vue runtime that omits it.
            if (opts.dataInspectorEl && watchEffect) {
                watchEffect(() => {
                    try {
                        opts.dataInspectorEl.textContent = JSON.stringify(data, null, 2);
                    } catch (e) {
                        opts.dataInspectorEl.textContent = `(serialise failed: ${e.message})`;
                    }
                });
            }
            // Optional onDataChange callback. Fires after every reactive
            // change to the form data, debounced so a typing burst becomes
            // one host-side notification instead of one per keystroke. The
            // host (viewer.js) uses this to push snapshots into the undo
            // history; other consumers can use it for any debounced react-
            // to-edit flow.
            //
            // `watch(data, fn, { deep: true, flush: 'post' })` is cheaper
            // than the watchEffect+JSON.stringify approach: deep watchers
            // observe nested mutations directly, no per-tick serialise of
            // the whole tree to register dependencies. `flush: 'post'`
            // batches the callback to after Vue's render commit so a
            // single user action that mutates several fields produces
            // one debounce arm, not one per field.
            if (typeof opts.onDataChange === 'function' && watch) {
                let timer = 0;
                const stop = watch(data, () => {
                    if (timer) clearTimeout(timer);
                    timer = setTimeout(() => {
                        timer = 0;
                        try { opts.onDataChange(data); }
                        catch (e) { console.warn('[render-vue] onDataChange threw:', e); }
                    }, opts.dataChangeDebounceMs ?? 350);
                }, { deep: true, flush: 'post' });
                // Drop the in-flight debounce + stop the watcher on
                // unmount. Without this, a fast-typing user who clicks
                // Process before the 350 ms timer fires would see the
                // timer fire AFTER the new mount installed a fresh
                // history — and the callback's closed-over `data` (the
                // orphaned old reactive root) would push a stale
                // snapshot into the new history.
                if (onUnmounted) onUnmounted(() => {
                    if (timer) { clearTimeout(timer); timer = 0; }
                    if (stop) stop();
                });
            }
            return {};
        },
        render() {
            return h('div', { class: 'fb-form-page', 'data-theme': theme }, [
                h(C('VCard'), { variant: 'outlined', class: 'fb-form-card' }, () =>
                    h('div', { class: 'fb-form-card-body' }, [
                        renderRootHeader(ast.root, ast, data),
                        renderContainerBody(ast.root, ast, data)
                    ])
                )
            ]);
        }
    };

    const app = createApp(App);
    const vuetify = createVuetify({
        theme: { defaultTheme: theme },
        components,
        directives
    });
    app.use(vuetify);

    // Belt + suspenders: register every component (and directive) directly
    // on the app, in BOTH PascalCase and kebab-case. Vuetify 3.4+ install
    // hook's component registration has been unreliable across versions.
    let registered = 0;
    for (const [name, comp] of Object.entries(components)) {
        if (!comp) continue;
        const isComponentLike = typeof comp === 'object' || typeof comp === 'function';
        if (!isComponentLike) continue;
        try {
            // Vue 3 accepts both casings on a single registration:
            // `app.component('VTextField', VTextField)` makes both
            // `<VTextField>` and `<v-text-field>` resolve in
            // templates. The PascalCase register is enough; no need
            // to register the kebab form separately.
            app.component(name, comp);
            registered++;
        } catch { /* skip non-component entries */ }
    }
    for (const [name, dir] of Object.entries(directives)) {
        if (!dir) continue;
        try { app.directive(name, dir); } catch { /* skip */ }
    }

    if (VIEWER_DEBUG) {
        console.info('[render-vue] manually registered', registered, 'components on app');
        if (components.VTextField) {
            console.info('[render-vue] VTextField sample:', components.VTextField);
        } else {
            console.warn('[render-vue] VTextField NOT FOUND in components object');
            console.warn('[render-vue] components keys (first 15):', Object.keys(components).slice(0, 15));
        }
    }

    app.mount(appMount);
    activeApp = app;

    // Post-mount sanity check. Two RAF ticks is the conventional
    // "after layout has settled" signal — the first tick gives Vue
    // its mount commit, the second tick lets the browser apply the
    // resulting style/layout pass. A `setTimeout(100)` would be a
    // guess; busy main threads or slow CI machines may legitimately
    // not be done painting in 100 ms, and a fast machine waits 95 ms
    // longer than necessary. RAF is the honest signal.
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const hasInert = !!appMount.querySelector('v-text-field, v-checkbox, v-card, v-row, v-col, v-app, v-main, v-container');
        if (hasInert) {
            addError(rootEl,
                'Vue still rendering as inert custom elements after manual registration. ' +
                'Open the console for the component dump — paste it back to diagnose.');
        }
        const styles = window.getComputedStyle(appMount);
        if (parseInt(styles.height, 10) === 0) {
            addError(rootEl,
                'Mount target has zero height. The Vue tree is rendering, but the layout has collapsed it.');
        }
    }));

    return { app, data };
}

function addError(rootEl, msg) {
    const pre = document.createElement('pre');
    pre.style.cssText = 'color:#e06c75;padding:12px;background:#2a1f22;margin:0;white-space:pre-wrap;';
    pre.textContent = '✗ ' + msg;
    rootEl.appendChild(pre);
}

export function teardown() {
    if (activeApp) {
        try { activeApp.unmount(); } catch { /* swallow */ }
        activeApp = null;
    }
}

// ---------------------------------------------------------------
// Container / row / panel rendering
// ---------------------------------------------------------------

function renderRootHeader(root, ast, data) {
    const children = [];
    const titleText = renderFragmentsAsText(root.title, data);
    if (titleText) children.push(h('h2', { class: 'fb-title' }, titleText));
    const descText = renderFragmentsAsText(root.description, data);
    if (descText) children.push(h('p', { class: 'fb-desc' }, descText));
    const tipText = resolveTooltipText(root, ast, data);
    if (tipText) children.push(h('p', { class: 'fb-tip' }, [
        h('span', { 'aria-hidden': 'true', class: 'fb-tip-icon' }, '🛈  '),
        tipText
    ]));
    if (children.length === 0) return null;
    return h('div', { class: 'fb-root-header' }, children);
}

function renderContainerBody(container, ast, data) {
    const totalCols = ast.columns ?? 12;
    if (container.panels) {
        // Swimlanes vs accordion: if every panel declared a width and the
        // widths sum to within totalCols, treat panels=[1:4,2:4,3:4] as a
        // horizontal-lane layout (each lane keeps its own header + body).
        // Otherwise fall back to the historical vertical accordion.
        const widths = container.panels.map(p => p.width || 0);
        const allSized = widths.every(w => w > 0);
        const widthSum = widths.reduce((a, w) => a + w, 0);
        if (allSized && widthSum <= totalCols) {
            return h(C('VRow'), { dense: true, class: 'fb-swimlanes' }, () =>
                container.panels.map(p => renderSwimlane(p, ast, data, totalCols, container))
            );
        }
        return h(C('VExpansionPanels'), { variant: 'accordion', multiple: true, class: 'fb-panels' }, () =>
            container.panels.map(p => renderPanel(p, ast, data, totalCols))
        );
    }
    if (container.rows) {
        return h('div', { class: 'fb-rows' }, container.rows.map(r => renderRow(r, ast, data, totalCols)));
    }
    return null;
}

function renderPanel(panel, ast, data, totalCols) {
    const labelText = renderFragmentsAsText(panel.label, data);
    return h(C('VExpansionPanel'), null, () => [
        h(C('VExpansionPanelTitle'), null, () => labelText || `Panel ${panel.number}`),
        h(C('VExpansionPanelText'), null, () =>
            panel.rows.map(r => renderRow(r, ast, data, totalCols))
        )
    ]);
}

function renderSwimlane(panel, ast, data, totalCols, container) {
    const labelText = renderFragmentsAsText(panel.label, data);
    const cols = colsFor(panel.width, totalCols);
    // Lane min/max heights propagate from the parent container so the
    // form author sets them once for all swimlanes instead of on every
    // panel. Applied to the lane's body so the title bar stays put.
    const sizing = [
        container?.minHeight ? `min-height:${container.minHeight};` : '',
        container?.maxHeight ? `max-height:${container.maxHeight};overflow-y:auto;` : ''
    ].filter(Boolean).join('');
    return h(C('VCol'), { cols, class: 'fb-swimlane' }, () =>
        h(C('VCard'), { variant: 'outlined', class: 'fb-swimlane-card' }, () => [
            h(C('VCardTitle'), { class: 'fb-swimlane-title' }, () => labelText || `Panel ${panel.number}`),
            h(C('VCardText'), {
                class: 'fb-swimlane-body',
                style: sizing
            }, () =>
                panel.rows.map(r => renderRow(r, ast, data, totalCols))
            )
        ])
    );
}

function renderRow(row, ast, data, totalCols) {
    return h(C('VRow'), { dense: true, class: 'fb-row' }, () =>
        row.controls.map(item => {
            if (item.nodeKind === 'container' || item.nodeKind === 'repeater') {
                return h(C('VCol'), { cols: 12 }, () => renderSubContainer(item, ast, data));
            }
            if (item.nodeKind === 'listManager') {
                return h(C('VCol'), { cols: 12 }, () =>
                    h(ListManagerComponent, { node: item, ast, data })
                );
            }
            const cols = colsFor(item.width, totalCols);
            return h(C('VCol'), { cols }, () => renderControl(item, ast, data));
        })
    );
}

function renderSubContainer(c, ast, data) {
    const labelText = renderFragmentsAsText(c.label, data);
    const tipText = resolveTooltipText(c, ast, data);
    const titleSlot = () => [
        labelText || '(container)',
        ...c.headerControls.map(h2 => h('span', { class: 'fb-header-ctl' }, [renderControl(h2, ast, data)]))
    ];

    if (c.collapsible) {
        return h(C('VExpansionPanels'), { variant: 'accordion', class: 'fb-sub-panels' }, () =>
            h(C('VExpansionPanel'), null, () => [
                h(C('VExpansionPanelTitle'), null, titleSlot),
                h(C('VExpansionPanelText'), null, () => [
                    tipText ? h('p', { class: 'fb-tip' }, [
                        h('span', { 'aria-hidden': 'true', class: 'fb-tip-icon' }, '🛈  '),
                        tipText
                    ]) : null,
                    renderContainerBody(c, ast, data)
                ])
            ])
        );
    }

    return h(C('VCard'), { variant: 'outlined', class: 'fb-subcontainer' }, () => [
        h(C('VCardTitle'), null, titleSlot),
        tipText ? h(C('VCardSubtitle'), null, [
            h('span', { 'aria-hidden': 'true', class: 'fb-tip-icon' }, '🛈  '),
            tipText
        ]) : null,
        h(C('VCardText'), null, () => renderContainerBody(c, ast, data))
    ]);
}

// ---------------------------------------------------------------
// Per-control dispatch
// ---------------------------------------------------------------

function renderControl(ctl, ast, data) {
    if (ctl.controlType === 'hidden') return null;

    const labelText   = renderFragmentsAsText(ctl.label, data);
    const tipText     = resolveTooltipText(ctl, ast, data);
    const explainText = renderFragmentsAsText(ctl.explain, data);

    // Stable id pair derived from binding + source line so re-renders
    // produce the same `<label for>` / aria-describedby targets
    // (Vuetify generates the matching `<label for="<id>">` from the
    // label prop). The Math.random fallback covers the rare control
    // with no binding and no contentRef — the wiring stays valid
    // even if the id can't be made stable across renders.
    // The 'noref' fallback keeps the id stable across re-renders for
    // controls with no binding and no contentRef (dividers, labels).
    // A random suffix would make every render produce a fresh id —
    // any aria-describedby chain set in one render would dangle in
    // the next.
    const stableId  = ctl.binding ?? ctl.contentRef ?? `noref-${ctl.loc?.line ?? 0}`;
    const inputId   = `fb-input-${stableId}-${ctl.loc?.line ?? 0}`;
    const explainId = `fb-explain-${stableId}-${ctl.loc?.line ?? 0}`;
    const isRequired = ctl.binding != null && !ctl.binding.startsWith('@');

    // Threaded into renderControlBare so each Vuetify component wires
    // id, aria-required, and aria-describedby on the input element
    // itself. Vuetify's `label` prop builds the matching `<label for>`
    // automatically — that replaces the previous external <label>
    // whose `for=` pointed at an id no input ever carried.
    const a11y = {
        id: inputId,
        'aria-required': isRequired ? 'true' : undefined,
        'aria-describedby': explainText ? explainId : undefined
    };

    const bare = renderControlBare(ctl, ast, data, labelText, a11y);
    if (bare == null) return null;

    const stack = [bare];
    if (explainText) {
        // explainId lives on the body div, NOT on the <details>
        // wrapper. NVDA on Chromium reads aria-describedby targets
        // pointed at <details> as "Show details, button, collapsed"
        // — the body text never reaches the user until they
        // expand the section. Pointing at the body div makes the
        // description text reach the screen reader regardless of
        // whether the disclosure is open.
        stack.push(h('details', { class: 'fb-explain' }, [
            h('summary', { class: 'fb-explain-summary' }, 'Show details'),
            h('div', { class: 'fb-explain-body', id: explainId }, explainText)
        ]));
    }

    return h('div', {
        class: 'fb-control-stack',
        title: tipText || undefined          // native HTML tooltip — no positioning bug
    }, stack);
}

function renderControlBare(ctl, ast, data, labelText, a11y) {
    // baseProps applies to every Vuetify input. labeledProps adds the
    // label + a11y bundle for single-input controls. Compound controls
    // (daterange, fileSize, color, directoryBrowser) skip labeledProps
    // and instead wrap their sub-inputs in a <fieldset>/<legend> so
    // the group's name is announced once by assistive tech and each
    // sub-input keeps its own granular Vuetify label.
    //
    // hideDetails:true drops Vuetify's reserved error-message strip
    // beneath each field for a denser overall layout — validation
    // messages live in the consumer's own pass.
    const baseProps = {
        density: 'compact',
        hideDetails: true
    };
    const labeledProps = {
        ...baseProps,
        label: labelText || undefined,
        ...a11y
    };
    // Sub-input a11y for compound controls. Each sub-input keeps its
    // own granular Vuetify label and its own derived id, but inherits
    // aria-describedby from the parent so a screen reader on a
    // focused sub-input still surfaces the explain text. The parent
    // id is NOT inherited (would collide); aria-required stays on the
    // <fieldset> alone (the group is required, not each sub-input).
    const subA11y = {
        'aria-describedby': a11y['aria-describedby']
    };
    const modelHandlers = (kind = 'value') => ({
        modelValue: getDeep(data, ctl.binding),
        'onUpdate:modelValue': (v) => setDeep(data, ctl.binding, kind === 'int' ? toInt(v) : kind === 'float' ? toFloat(v) : v)
    });

    switch (ctl.controlType) {
        case 'textfield':
            return h(C('VTextField'), { ...labeledProps, ...modelHandlers(),
                maxlength:   ctl.params.maxLength,
                placeholder: ctl.params.placeholder
            });

        case 'textarea':
            return h(C('VTextarea'), { ...labeledProps, ...modelHandlers(),
                rows:        ctl.params.rows ?? 4,
                maxlength:   ctl.params.maxLength,
                placeholder: ctl.params.placeholder
            });

        case 'password':
            return h(C('VTextField'), { ...labeledProps, ...modelHandlers(),
                type: 'password',
                appendInnerIcon: ctl.params.reveal ? 'mdi-eye' : undefined
            });

        case 'number':
            return h(C('VTextField'), { ...labeledProps, ...modelHandlers('int'),
                type: 'number', min: ctl.params.min, max: ctl.params.max, step: ctl.params.step ?? 1
            });

        case 'float':
            return h(C('VTextField'), { ...labeledProps, ...modelHandlers('float'),
                type: 'number',
                min: ctl.params.min, max: ctl.params.max, step: ctl.params.step ?? 0.1
            });

        case 'slider':
            return h(C('VSlider'), { ...labeledProps, ...modelHandlers('float'),
                min: ctl.params.min ?? 0, max: ctl.params.max ?? 100, step: ctl.params.step ?? 1,
                thumbLabel: 'always'
            });

        case 'check':
            return h(C('VCheckbox'), { ...labeledProps, ...modelHandlers() });

        case 'toggle':
            return h(C('VSwitch'), { ...labeledProps, ...modelHandlers(), color: 'primary' });

        case 'select': {
            const items = resolveOptionItems(ctl.optionsSource, ast, data);
            return h(C('VSelect'), { ...labeledProps, ...modelHandlers(), items });
        }

        case 'combo': {
            const items = resolveOptionItems(ctl.optionsSource, ast, data);
            return h(C('VCombobox'), { ...labeledProps, ...modelHandlers(), items });
        }

        case 'radio': {
            const items = resolveOptionItems(ctl.optionsSource, ast, data);
            return h(C('VRadioGroup'), { ...labeledProps, ...modelHandlers(), inline: true }, () =>
                items.map(it => h(C('VRadio'), { label: String(it), value: it }))
            );
        }

        case 'multiselect': {
            const items = resolveOptionItems(ctl.optionsSource, ast, data);
            return h(C('VSelect'), { ...labeledProps, ...modelHandlers(), items, multiple: true, chips: true });
        }

        case 'date':
            return h(C('VTextField'), { ...labeledProps, ...modelHandlers(),
                type: 'date', min: ctl.params.min, max: ctl.params.max
            });

        case 'time':
            return h(C('VTextField'), { ...labeledProps, ...modelHandlers(), type: 'time' });

        case 'datetime':
            return h(C('VTextField'), { ...labeledProps, ...modelHandlers(),
                type: 'datetime-local', min: ctl.params.min, max: ctl.params.max
            });

        case 'daterange':
            return renderFieldset(labelText, a11y, 'fb-daterange-set', () =>
                h('div', { class: 'fb-daterange' }, [
                    h(C('VTextField'), { ...baseProps, ...subA11y, type: 'date', label: 'Start',
                        id: `${a11y.id}-start`,
                        modelValue: getDeep(data, ctl.binding)?.start ?? null,
                        'onUpdate:modelValue': (v) => setDeep(data, ctl.binding, { ...(getDeep(data, ctl.binding) ?? {}), start: v })
                    }),
                    h(C('VTextField'), { ...baseProps, ...subA11y, type: 'date', label: 'End',
                        id: `${a11y.id}-end`,
                        modelValue: getDeep(data, ctl.binding)?.end ?? null,
                        'onUpdate:modelValue': (v) => setDeep(data, ctl.binding, { ...(getDeep(data, ctl.binding) ?? {}), end: v })
                    })
                ])
            );

        case 'file':
            // File inputs are uncontrolled in HTML — browsers refuse to
            // restore a programmatically-set File object into the
            // input's selected-file slot. So we listen for selection
            // changes and write into the bound data field, but we do
            // NOT spread modelValue back from data into the input.
            // A re-render after a file selection would silently fail
            // to restore the chosen file; users always re-pick after
            // a re-render. The bound field still carries the File for
            // the consumer to read (size, name, content).
            return h(C('VFileInput'), { ...labeledProps,
                'onUpdate:modelValue': (v) => setDeep(data, ctl.binding, v),
                accept: ctl.params.accept
            });

        case 'fileSize': {
            // Compound control: amount (float) + unit (Kb/Mb/Gb/Tb).
            // Wrapped in a fieldset so the screen reader hears the
            // group's label once and each sub-input's role label
            // ("Amount" / "Unit") once. The binding stores a single
            // string like "1.5Mb"; we parse it on read and recombine
            // on every keystroke.
            const units = (ctl.params.units ?? 'Kb,Mb,Gb,Tb').split(',').map(s => s.trim());
            const defaultUnit = ctl.params.defaultUnit ?? units[1] ?? units[0] ?? 'Mb';
            const raw = getDeep(data, ctl.binding);
            const { amount, unit } = parseSizeString(raw, defaultUnit, units);

            const recombine = (nextAmount, nextUnit) => {
                const a = nextAmount;
                // Guard against an undefined unit reaching the
                // template literal — `${a}${undefined}` would write
                // "5undefined" to the binding. The VSelect today has
                // no clearable so this path is unreachable, but a
                // future tweak that adds clearable: true (or a units
                // list with empty entries) is one keystroke away.
                const u = nextUnit ?? defaultUnit;
                const amountEmpty = (a == null || a === '' || Number.isNaN(a));
                if (amountEmpty && u === defaultUnit) {
                    // Both default — collapse to empty string for a
                    // clean "no value yet" representation.
                    setDeep(data, ctl.binding, '');
                } else if (amountEmpty) {
                    // Unit picked without an amount — preserve the
                    // unit alone in the binding so the next render
                    // shows the user's chosen unit instead of
                    // silently reverting to defaultUnit.
                    setDeep(data, ctl.binding, u);
                } else {
                    setDeep(data, ctl.binding, `${a}${u}`);
                }
            };

            return renderFieldset(labelText, a11y, 'fb-filesize-set', () =>
                h('div', { class: 'fb-filesize-row' }, [
                    h(C('VTextField'), { ...baseProps, ...subA11y,
                        modelValue: amount,
                        'onUpdate:modelValue': (v) => recombine(toNumberOrEmpty(v), unit),
                        type: 'number',
                        label: 'Amount',
                        id: `${a11y.id}-amount`,
                        min: ctl.params.min ?? 0,
                        step: ctl.params.step ?? 0.1,
                        class: 'fb-filesize-amount'
                    }),
                    h(C('VSelect'), { ...baseProps, ...subA11y,
                        modelValue: unit,
                        'onUpdate:modelValue': (v) => recombine(amount, v),
                        items: units,
                        label: 'Unit',
                        id: `${a11y.id}-unit`,
                        class: 'fb-filesize-unit'
                    })
                ])
            );
        }

        case 'fileBrowser':
            return h(C('VFileInput'), { ...labeledProps,
                'onUpdate:modelValue': (v) => setDeep(data, ctl.binding, v),
                accept:    ctl.params.accept,
                multiple:  ctl.params.multiple ?? false,
                prependIcon: 'mdi-file-document-outline',
                showSize:  true,
                variant:   'outlined',
                placeholder: 'Browse for a file…'
            });

        case 'directoryBrowser': {
            // Path selector — NOT an upload. Editable text + a Browse button
            // that uses the File System Access API's showDirectoryPicker()
            // when available (Chromium browsers) and stores the chosen
            // directory's name in the binding. Falls back to text-only
            // entry on browsers without the API. The actual filesystem
            // path resolution happens at the renderer/runtime layer (e.g.
            // an Electron / Tauri host can replace the picker with a
            // native dialog that returns a real OS path).
            const value = getDeep(data, ctl.binding) ?? '';

            const browse = async () => {
                if (typeof window.showDirectoryPicker !== 'function') {
                    // Don't block the UI with alert(). The host can listen
                    // for fb-renderer-status to surface the message in a
                    // toast / status bar; without a listener the message
                    // still lands in the console.
                    const msg = 'Directory picker not available in this browser. Type a path or run the app in an Electron/Tauri shell.';
                    console.warn('[directoryBrowser]', msg);
                    window.dispatchEvent?.(new CustomEvent('fb-renderer-status', {
                        detail: { message: msg, kind: 'warn' }
                    }));
                    return;
                }
                try {
                    const handle = await window.showDirectoryPicker();
                    setDeep(data, ctl.binding, handle.name);
                } catch (e) {
                    if (e?.name === 'AbortError') return;     // user cancelled, not an error
                    console.warn('[directoryBrowser]', e);
                    // Surface to the host so a permission denial or
                    // other real failure reaches the user, not just
                    // the dev console.
                    window.dispatchEvent?.(new CustomEvent('fb-renderer-status', {
                        detail: { message: `Directory picker failed: ${e?.message ?? e}`, kind: 'err' }
                    }));
                }
            };

            return renderFieldset(labelText, a11y, 'fb-dir-set', () =>
                h('div', { class: 'fb-dir-row' }, [
                    h(C('VTextField'), {
                        ...baseProps,
                        ...subA11y,
                        modelValue: value,
                        'onUpdate:modelValue': (v) => setDeep(data, ctl.binding, v),
                        label: 'Path',
                        id: `${a11y.id}-path`,
                        placeholder: 'Type a path or click Browse…',
                        class: 'fb-dir-field'
                    }),
                    h(C('VBtn'), {
                        ...subA11y,
                        size: 'small',
                        prependIcon: 'mdi-folder-open-outline',
                        variant: 'tonal',
                        onClick: browse,
                        'aria-label': labelText ? `Browse for ${labelText}` : 'Browse for directory'
                    }, () => 'Browse')
                ])
            );
        }

        case 'color': {
            // Native <input type="color"> always holds a hex value
            // (defaulting to #000000 when blank), so we wrap it in a
            // compound that adds an explicit null option as a sibling
            // swatch. The swatch uses a checker pattern — the universal
            // visual for "transparent / no fill" — and renders highlighted
            // (blue ring) when the bound field is empty, so the operator
            // can see at a glance which side of the compound is "live".
            // Click the swatch → set binding to ''. Pick a colour in the
            // picker → set binding to the hex.
            //
            // The fieldset around both gives a screen reader one group
            // label for the whole compound; aria-pressed on the swatch
            // exposes the "null is active" state to assistive tech.
            const binding = ctl.binding;
            const current = getDeep(data, binding);
            const isNull  = !current;
            return renderFieldset(labelText, a11y, 'fb-color-set', () =>
                h('div', { class: 'fb-color-row' }, [
                    h('button', {
                        type:    'button',
                        class:   ['fb-color-null', isNull ? 'fb-color-null-active' : null]
                                     .filter(Boolean).join(' '),
                        title:   'Null colour (let ANSI or default win)',
                        'aria-label': 'Null colour (let ANSI or default win)',
                        'aria-describedby': subA11y['aria-describedby'],
                        'aria-pressed': isNull ? 'true' : 'false',
                        onClick: () => setDeep(data, binding, '')
                    }),
                    h(C('VTextField'), {
                        ...baseProps,
                        ...subA11y,
                        type: 'color',
                        label: 'Colour',
                        id: `${a11y.id}-color`,
                        modelValue: current || '#000000',
                        'onUpdate:modelValue': v => setDeep(data, binding, v),
                        class: 'fb-color-input'
                    })
                ])
            );
        }

        case 'display': {
            // Read-only: data binding (or function ref shown as placeholder).
            // Vuetify's label prop wires the `<label for>` so the read-
            // only field still announces its name.
            let value = '';
            if (ctl.binding?.startsWith('@')) {
                value = `[${ctl.binding}]`;
            } else if (ctl.binding) {
                value = getDeep(data, ctl.binding) ?? '';
            }
            return h(C('VTextField'), { ...labeledProps, modelValue: String(value ?? ''), readonly: true, variant: 'outlined' });
        }

        case 'label': {
            const style = ctl.params.style ?? 'note';
            if (style === 'divider') {
                return h(C('VDivider'), { class: 'fb-divider' });
            }
            const tag = style === 'heading' ? 'h3' : style === 'help' ? 'small' : 'p';
            // The label control's content lives in ctl.label fragments;
            // it renders here as its own visual element rather than as
            // a Vuetify input's label.
            const text = renderFragmentsAsText(ctl.label, data);
            return h(tag, {
                class: `fb-label fb-label-${style}`,
                style: 'white-space:pre-line;'
            }, text || '');
        }

        default:
            return h('div', { class: 'fb-unknown' }, `${ctl.controlType}`);
    }
}

// Compound-control wrapper. Renders <fieldset> with an optional
// <legend> so the group's name is the screen-reader-recognised label
// for every input inside. aria-required and aria-describedby are
// forwarded from the a11y bundle so an unfilled compound (or a
// compound with an explain block) still surfaces those signals.
function renderFieldset(labelText, a11y, extraClass, renderBody) {
    return h('fieldset', {
        class: `fb-fieldset ${extraClass}`,
        'aria-required':    a11y['aria-required'],
        'aria-describedby': a11y['aria-describedby']
    }, [
        labelText ? h('legend', { class: 'fb-legend' }, labelText) : null,
        renderBody()
    ]);
}

// ---------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------

function resolveOptionItems(sourceName, ast, data) {
    if (!sourceName) return [];
    const src = ast.optionSources?.[sourceName];
    if (!src) return [];
    if (src.type === 'static')  return src.values ?? [];
    if (src.type === 'dynamic') {
        if (src.path?.startsWith('@')) return [];     // function-backed; needs registry
        const v = getDeep(data, src.path);
        return Array.isArray(v) ? v : [];
    }
    return [];
}

function resolveTooltipText(node, ast, data) {
    // The package's tooltip surface is exclusively `node.tooltipRef`
    // (a string referencing the top-level `tooltips` map). The
    // parser does not produce inline tooltip fragments on a node;
    // every tooltip is authored once in the `tooltips = [...]`
    // block and referenced by key. Fragment rendering happens here
    // rather than in the parser so the tooltip text picks up the
    // current data values at render time.
    if (node.tooltipRef && ast.tooltips?.[node.tooltipRef]) {
        return renderFragmentsAsText(ast.tooltips[node.tooltipRef], data);
    }
    return null;
}

// Local fragment-to-text renderer. The package exports
// `renderFragments(fragments, data, fns, { mode: 'plain' })` which
// would handle text and binding the same way. The viewer keeps a
// local renderer for one reason: the preview deliberately leaves
// {@fn} placeholders empty so the schema preview reads as a
// static-shape view ("what fields will this form bind?"). Letting
// renderFragments resolve {@fn} against window.formFunctions would
// mix runtime-evaluated values into that view and confuse the
// question the preview answers. The Live Data tab is the place to
// see resolved function output.
//
// Fragment shapes in a parser-produced AST after phase 2 are only
// `text`, `binding`, and `function` — the parser's phase-1 `ref`
// kind is rewritten to its named-text body in phase 2
// (`rewrite-fragments.js:71`) or the parse fails with INVALID_REF.
// So we handle exactly the three shapes that can arrive.
function renderFragmentsAsText(fragments, data) {
    if (!fragments?.length) return '';
    return fragments.map(f => {
        if (f.kind === 'text')    return f.text ?? '';
        if (f.kind === 'binding') return String(getDeep(data, f.path) ?? '');
        return '';                                     // 'function' (deliberately empty in preview) and any future kind
    }).join('');
}

function colsFor(width, totalCols) {
    if (!width || totalCols <= 0) return 12;
    return Math.max(1, Math.min(12, Math.round((width / totalCols) * 12)));
}

function getDeep(obj, path) {
    if (!path) return undefined;
    if (path.startsWith('@')) return undefined;          // function bindings have no readable value
    return path.split('.').reduce((a, s) => (a == null ? a : a[s]), obj);
}

function setDeep(obj, path, value) {
    if (!path) return;
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
}

function toInt(v)   { const n = parseInt(v, 10);   return Number.isFinite(n) ? n : 0; }
function toFloat(v) { const n = parseFloat(v);     return Number.isFinite(n) ? n : 0; }

function toNumberOrEmpty(v) {
    if (v === '' || v == null) return '';
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : '';
}

// Parse a string like "1.5Mb" or "500KB" or "0" or "Gb" (unit-only)
// into { amount, unit }. Both num and unit are optional in the
// pattern — a unit-only string (the recombine path writes one when
// the user picks a unit without an amount) parses cleanly to
// { amount: '', unit }. Falls back to defaultUnit when no scale
// suffix is present.
function parseSizeString(raw, defaultUnit, knownUnits) {
    if (raw == null || raw === '') return { amount: '', unit: defaultUnit };
    if (typeof raw === 'number')   return { amount: raw, unit: defaultUnit };
    const s = String(raw).trim();
    const m = s.match(/^(?<num>-?\d+(?:\.\d+)?)?\s*(?<unit>[A-Za-z]+)?\s*$/);
    if (!m) return { amount: '', unit: defaultUnit };
    const amt = m.groups.num != null ? parseFloat(m.groups.num) : '';
    let u = (m.groups.unit ?? defaultUnit).trim();
    // Match the parsed unit against knownUnits case-insensitively so the
    // dropdown's chosen casing wins. Falls back to the default if no match.
    const exact = knownUnits.find(k => k === u);
    if (exact) u = exact;
    else {
        const ci = knownUnits.find(k => k.toLowerCase() === u.toLowerCase());
        if (!ci && m.groups.unit && !_unknownUnitWarned.has(u)) {
            // Surface the silent rewrite once per unknown unit so an
            // operator who plants `5XB` in a binding sees the unit
            // wasn't matched. The dedup Set caps at 64 entries to
            // avoid unbounded growth in long-lived sessions.
            console.warn(`parseSizeString: unknown unit ${JSON.stringify(u)}; falling back to ${JSON.stringify(defaultUnit)}`);
            if (_unknownUnitWarned.size >= 64) _unknownUnitWarned.clear();
            _unknownUnitWarned.add(u);
        }
        u = ci ?? defaultUnit;
    }
    return { amount: Number.isFinite(amt) ? amt : '', unit: u };
}
const _unknownUnitWarned = new Set();

// ---------------------------------------------------------------
// Initial data — defaults from inferred schema
// ---------------------------------------------------------------

function buildInitialData(schema, ast) {
    if (!schema) return {};
    const data = {};
    // Type-default seed pass.
    for (const f of schema.fields) {
        if (f.path.includes('[]')) continue;          // repeater elements: not auto-seeded
        const val = parseDefault(f.type?.defaultValue);
        setDeep(data, f.path, val);
    }
    // Option-source seed pass — every `[...] -> {a} -> {b}` declaration
    // populates each named binding with the source's values at form-init
    // time. When a binding feeds a listManager's array, the strings are
    // translated to full item objects (one key per body-row control,
    // seeded from init= literals or type defaults) so the per-item
    // editor has something to bind to. The listManager's name field
    // gets the source value verbatim.
    const lmByBinding = collectListManagerBindings(ast?.root);
    for (const [, src] of Object.entries(ast?.optionSources ?? {})) {
        if (src.type !== 'static') continue;
        if (!Array.isArray(src.bindings) || src.bindings.length === 0) continue;
        if (!Array.isArray(src.values)) continue;
        for (const binding of src.bindings) {
            const lm = lmByBinding.get(binding);
            const value = lm
                ? src.values.map(v => seedListManagerItem(lm, v))
                : src.values.slice();
            setDeep(data, binding, value);
        }
    }
    // init=<literal> overrides the type default.
    if (ast?.root) walkControls(ast.root, (ctl) => {
        if (ctl.binding && !ctl.binding.startsWith('@') && ctl.init?.kind === 'literal') {
            setDeep(data, ctl.binding, ctl.init.value);
        }
    });
    return data;
}

// Walk the AST collecting every listManager's arrayBinding → node map.
// Used by buildInitialData so an option source feeding a listManager's
// binding can translate plain strings into full item objects matching
// the listManager's body-row schema.
function collectListManagerBindings(root) {
    const map = new Map();
    walkAst(root, (n) => {
        if (n.nodeKind === 'listManager' && n.arrayBinding) {
            map.set(n.arrayBinding, n);
        }
    });
    return map;
}

// Translate one source value into an item shaped to match the
// listManager's body schema. Two value shapes are accepted:
//
//   - string → becomes `{ name: <string>, …body defaults }`
//
//   - object (resolved from a `#name` ref to a named-object literal) →
//     start with the object's keys, then fill in any body-row binding
//     it didn't supply with the type's default. The named object's
//     primary-key marker (`__pk`, non-enumerable) carries through so
//     the listManager's excluded matching can compare on the right
//     field for this item.
//
// Mirrors ListManagerComponent's own seedNewItem so user-added items
// and source-seeded items share one schema.
function seedListManagerItem(lmNode, value) {
    let item;
    if (value && typeof value === 'object') {
        // Spread the object's enumerable fields so JSON output stays
        // clean — non-enumerable __pk isn't copied by `...obj`, so we
        // re-attach it below.
        item = { ...value };
        if (value.__pk) {
            Object.defineProperty(item, '__pk', {
                value:        value.__pk,
                enumerable:   false,
                configurable: false,
                writable:     false
            });
        }
    } else {
        item = { name: String(value ?? '') };
    }
    for (const row of (lmNode.rows || [])) {
        for (const ctl of (row.controls || [])) {
            if (!ctl.binding || ctl.binding.startsWith('@')) continue;
            if (ctl.binding in item) continue;        // honour values from the object
            const init = ctl.init?.kind === 'literal' ? ctl.init.value : null;
            item[ctl.binding] = init !== null ? init : defaultForControlType(ctl.controlType);
        }
    }
    return item;
}

// Wrapper that filters walkAst's all-nodes traversal to controls
// only. The package's walkAst visits every node (containers, rows,
// panels, controls); the viewer's compute / init / data-seed code
// only cares about controls. One filter, one walker, no divergence
// between the viewer's helpers.
function walkControls(node, visit) {
    walkAst(node, (n) => { if (n.nodeKind === 'control') visit(n); });
}

// ---------------------------------------------------------------
// ListManager — managed array editor with toolbar, scroll viewport,
// drag-reorder, per-row delete (suppressed for excluded names), and a
// modal popup that renders the body rows as the per-item editor.
// ---------------------------------------------------------------

const ListManagerComponent = {
    name: 'ListManager',
    props: {
        node: { type: Object, required: true },
        ast:  { type: Object, required: true },
        data: { type: Object, required: true }
    },
    setup(props) {
        const searchQuery   = ref('');
        const editIndex     = ref(-1);
        const dialogOpen    = ref(false);
        const dragFromIndex = ref(-1);

        const items = computed(() => {
            const arr = getDeep(props.data, props.node.arrayBinding);
            return Array.isArray(arr) ? arr : [];
        });

        // Excluded keys + the primary-key field name to compare on.
        // Source values are heterogeneous: plain strings (compared
        // verbatim against item.name) and named objects (compared on
        // each object's __pk field). The pk field is read off the
        // first object the source contains; lists with no objects
        // default to 'name'. New items added by the user inherit
        // that pk, so excluded matching is consistent.
        const excludeSpec = computed(() => {
            if (!props.node.excludedRef) return { pk: 'name', keys: [] };
            const src = props.ast.optionSources?.[props.node.excludedRef];
            if (!src || !Array.isArray(src.values)) return { pk: 'name', keys: [] };
            let pk = 'name';
            const keys = [];
            for (const v of src.values) {
                if (v && typeof v === 'object') {
                    if (typeof v.__pk === 'string' && pk === 'name') pk = v.__pk;
                    if (v[v.__pk || pk] != null) keys.push(String(v[v.__pk || pk]));
                } else {
                    keys.push(String(v));
                }
            }
            return { pk, keys };
        });

        return { searchQuery, editIndex, dialogOpen, dragFromIndex, items, excludeSpec };
    },
    methods: {
        isProtected(item) {
            const { pk, keys } = this.excludeSpec;
            const itemKey = item?.[pk];
            if (itemKey == null) return false;
            return keys.includes(String(itemKey));
        },
        filteredIndices() {
            const q = (this.searchQuery || '').toLowerCase();
            const arr = this.items;
            // Filter field — explicit `filter="<field>"` wins, otherwise
            // fall back to the human-readable convention `name`. Primary
            // keys are deliberately NOT a default: they're often opaque
            // identifiers (GUIDs, hashes, internal ids) where substring
            // matching is meaningless.
            const field = this.node.filter || 'name';
            const out = [];
            for (let i = 0; i < arr.length; i++) {
                const value = String(arr[i]?.[field] ?? '').toLowerCase();
                if (!q || value.includes(q)) out.push(i);
            }
            return out;
        },
        seedNewItem() {
            // Walk body rows so the new item gets one key per bound control,
            // initialised from `init=` literals or the type's natural default.
            const item = {};
            for (const row of (this.node.rows || [])) {
                for (const ctl of (row.controls || [])) {
                    if (!ctl.binding || ctl.binding.startsWith('@')) continue;
                    const init = ctl.init?.kind === 'literal' ? ctl.init.value : null;
                    item[ctl.binding] = init !== null ? init : defaultForControlType(ctl.controlType);
                }
            }
            if (!('name' in item)) item.name = 'New item';
            return item;
        },
        addItem() {
            const arr = this.items.slice();
            arr.push(this.seedNewItem());
            setDeep(this.data, this.node.arrayBinding, arr);
            this.editIndex  = arr.length - 1;
            this.dialogOpen = true;
        },
        deleteItem(idx) {
            const item = this.items[idx];
            if (!item || this.isProtected(item)) return;
            const arr = this.items.slice();
            arr.splice(idx, 1);
            setDeep(this.data, this.node.arrayBinding, arr);
        },
        startEdit(idx) {
            this.editIndex  = idx;
            this.dialogOpen = true;
        },
        closeEdit() {
            this.dialogOpen = false;
            this.editIndex  = -1;
        },
        onCommit() {
            const fnName = this.node.commit?.name;
            if (!fnName) return;
            const fn = (window.formFunctions || {})[fnName];
            if (typeof fn !== 'function') {
                console.info(`[listManager] commit fn '${fnName}' not in window.formFunctions; ignored`);
                return;
            }
            try { fn(this.items.slice()); }
            catch (e) { console.warn(`[listManager] commit fn '${fnName}' threw:`, e); }
        },
        onDragStart(idx, e) {
            this.dragFromIndex = idx;
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(idx));
                // The handle is the draggable; the user expects the whole
                // row's silhouette to follow the cursor. setDragImage on
                // the parent row replaces the default (just the handle)
                // with a row snapshot. The 16,height/2 offset puts the
                // anchor roughly under the cursor.
                const row = e.currentTarget?.parentElement;
                if (row && typeof row.getBoundingClientRect === 'function') {
                    const rect = row.getBoundingClientRect();
                    e.dataTransfer.setDragImage(row, 16, rect.height / 2);
                }
            }
        },
        onDragOver(idx, e) {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        },
        onDrop(idx, e) {
            e.preventDefault();
            const from = this.dragFromIndex;
            this.dragFromIndex = -1;
            if (from < 0 || from === idx) return;
            const arr = this.items.slice();
            const [moved] = arr.splice(from, 1);
            arr.splice(idx, 0, moved);
            setDeep(this.data, this.node.arrayBinding, arr);
        },
        chipStyle(item) {
            // Chip styling is convention-based: any field named bold/italic/
            // underline/strike on the item gets applied as a CSS decoration.
            // Foreground and background each accept two inputs — an ANSI
            // colour name (e.g. {fgAnsi}=red) and a custom hex picker
            // ({fg}=#abc). The ANSI value wins when both are set, so an
            // operator who picks an ANSI colour overrides whatever the
            // hex picker holds. Set the ANSI back to its empty option to
            // re-enable the picker.
            const styles = [];
            const fg = item?.fgAnsi || item?.fg;
            const bg = item?.bgAnsi || item?.bg;
            if (fg) styles.push(`color:${fg}`);
            if (bg) styles.push(`background:${bg}`);
            if (item?.bold)   styles.push('font-weight:600');
            if (item?.italic) styles.push('font-style:italic');
            const decorations = [];
            if (item?.underline) decorations.push('underline');
            if (item?.strike || item?.strikethrough) decorations.push('line-through');
            if (decorations.length) styles.push(`text-decoration:${decorations.join(' ')}`);
            return styles.join(';');
        },
        renderToolbar() {
            const node = this.node;
            return h('div', { class: 'fb-lm-toolbar' }, [
                node.search ? h(C('VTextField'), {
                    modelValue: this.searchQuery,
                    'onUpdate:modelValue': v => { this.searchQuery = v ?? ''; },
                    density: 'compact',
                    hideDetails: true,
                    placeholder: 'Filter…',
                    prependInnerIcon: 'mdi-magnify',
                    clearable: true,
                    class: 'fb-lm-search'
                }) : null,
                h(C('VBtn'), {
                    color: 'primary',
                    size: 'small',
                    prependIcon: 'mdi-plus',
                    onClick: () => this.addItem(),
                    class: 'fb-lm-add'
                }, () => node.addLabel || 'Add'),
                node.commit ? h(C('VBtn'), {
                    color: 'success',
                    size: 'small',
                    variant: 'tonal',
                    prependIcon: 'mdi-content-save-check',
                    onClick: () => this.onCommit(),
                    class: 'fb-lm-commit'
                }, () => 'Commit') : null
            ]);
        },
        renderListRow(idx) {
            const item = this.items[idx];
            const locked = this.isProtected(item);
            const draggable = !!this.node.draggable;
            // Row is the drop target only when the list is draggable.
            // Without draggable, drag handlers + handle are omitted —
            // chrome stays clean and the row visually groups its three
            // remaining elements (chip + edit + delete) tighter.
            return h('div', {
                key: idx,
                class: ['fb-lm-row', locked ? 'fb-lm-row-locked' : null].filter(Boolean).join(' '),
                onDragover:  draggable ? (e) => this.onDragOver(idx, e) : undefined,
                onDrop:      draggable ? (e) => this.onDrop(idx, e)     : undefined
            }, [
                draggable ? h('span', {
                    class: 'fb-lm-handle',
                    title: 'Drag to reorder',
                    'aria-label': 'Drag handle',
                    role: 'button',
                    draggable: 'true',
                    onDragstart: (e) => this.onDragStart(idx, e)
                }, [h('span', { 'aria-hidden': 'true' }, '⋮⋮')]) : null,
                h('span', {
                    class: 'fb-lm-chip',
                    style: this.chipStyle(item)
                }, item?.name || '(unnamed)'),
                h(C('VBtn'), {
                    icon: 'mdi-pencil-outline',
                    size: 'x-small',
                    variant: 'text',
                    onClick: () => this.startEdit(idx),
                    class: 'fb-lm-edit',
                    title: 'Edit'
                }),
                locked
                    ? h('span', {
                        class: 'fb-lm-locked',
                        title: 'Excluded — cannot delete',
                        'aria-label': 'Excluded — cannot delete'
                    }, [h('span', { 'aria-hidden': 'true' }, '🔒')])
                    : h(C('VBtn'), {
                        icon: 'mdi-trash-can-outline',
                        size: 'x-small',
                        variant: 'text',
                        color: 'error',
                        onClick: () => this.deleteItem(idx),
                        class: 'fb-lm-delete',
                        title: 'Delete'
                    })
            ]);
        },
        renderDialog() {
            const idx  = this.editIndex;
            const item = idx >= 0 ? this.items[idx] : null;
            // Stable id for aria-labelledby on the dialog so screen
            // readers announce a name (the listManager's array binding)
            // when the dialog opens, rather than the bare "dialog" cue.
            // The arrayBinding may be a dotted path like `groups.users`;
            // we sanitise to keep the id selector-safe (a CSS rule
            // keyed off `#fb-lm-dialog-title-groups.users` would treat
            // the dot as a class delimiter).
            const rawBinding = this.node.arrayBinding ?? 'lm';
            const titleId = `fb-lm-dialog-title-${rawBinding.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            return h(C('VDialog'), {
                modelValue: this.dialogOpen,
                'onUpdate:modelValue': (v) => { if (!v) this.closeEdit(); },
                maxWidth: 600,
                // Vuetify's default teleport target is document.body
                // (the overlay sits over the whole page). The host's
                // keydown gate (viewer.js's isInsideRenderedForm) walks
                // .v-overlay-container / .v-dialog ancestors so dialog-
                // internal Ctrl+Z still reaches the form-history. The
                // earlier `attach: '#vue-app-mount'` had a known risk
                // of overlay positioning under the renderer's
                // overflow:auto container.
                'aria-labelledby': titleId,
                role: 'dialog'
            }, () => item ? h(C('VCard'), null, () => [
                // Title hosts a live preview chip — the same chip the list
                // row shows, so the operator sees colour / decorator
                // changes apply in real time as they edit the body fields.
                h(C('VCardTitle'), { class: 'fb-lm-dialog-title', id: titleId }, () => [
                    h('span', { class: 'fb-lm-dialog-title-text' }, 'Edit'),
                    h('span', {
                        class: 'fb-lm-chip',
                        style: this.chipStyle(item)
                    }, item.name || '(unnamed)')
                ]),
                h(C('VCardText'), null, () =>
                    // Body rows render scoped to the item — bare bindings
                    // like {name},{fg},{bg} resolve against item directly.
                    this.node.rows.map(r =>
                        renderRow(r, this.ast, item, this.ast.columns ?? 12))
                ),
                h(C('VCardActions'), null, () => [
                    h(C('VSpacer')),
                    h(C('VBtn'), {
                        variant: 'text',
                        onClick: () => this.closeEdit()
                    }, () => 'Done')
                ])
            ]) : null);
        }
    },
    render() {
        const indices = this.filteredIndices();
        // Vertical sizing — minHeight stops an empty list from collapsing
        // to a strip of toolbar; maxHeight caps the viewport so a long
        // list scrolls inside its lane instead of pushing the form down.
        const sizing = [
            this.node.minHeight ? `min-height:${this.node.minHeight};` : '',
            this.node.maxHeight ? `max-height:${this.node.maxHeight};` : ''
        ].filter(Boolean).join('');
        const list = h('div', {
            class: 'fb-lm-list',
            style: sizing
        }, indices.length > 0
            ? indices.map(i => this.renderListRow(i))
            : [h('div', { class: 'fb-lm-empty' }, this.searchQuery
                ? 'No matches.'
                : 'List is empty — click Add to start.')]
        );
        return h('div', { class: 'fb-listmanager' }, [
            this.renderToolbar(),
            list,
            this.renderDialog()
        ]);
    }
};

// Natural empty value for a control type when nothing's seeded by an
// explicit init=. Used by listManager when adding a new item — every
// bound key gets a typed default so the popup form has stable initial
// state instead of `undefined` showing through to controls.
function defaultForControlType(t) {
    switch (t) {
        case 'check':
        case 'toggle':       return false;
        case 'number':
        case 'float':
        case 'slider':       return 0;
        case 'multiselect':  return [];
        default:             return '';
    }
}

// Convert a JS-object-literal-shaped string into something
// JSON.parse will accept. Walks the string tracking whether we
// are inside a string-delimited run, and rewrites three things:
//
//   1. A `'` that starts or ends a string-delimited run becomes
//      a `"` (the JSON delimiter).
//   2. Inside the run, an escaped apostrophe `\'` becomes a bare
//      `'` (JSON does not have a `\'` escape; an apostrophe is
//      legal inside a `"..."` string with no escape needed).
//   3. Inside the run, a bare `"` becomes `\"` (the apostrophe-
//      to-quote swap above means a literal `"` inside the value
//      now needs an escape it didn't need before).
//
// Other backslash escapes (`\\`, `\n`, `\t`, `ü`) pass
// through unchanged. Outside string-delimited runs, every
// character passes through unchanged except the bare apostrophe
// rewrite at point 1.
//
// This is best-effort, not a JSON parser. The strict-JSON-first
// attempt in parseDefault handles the round-trippable shape; this
// helper handles the looser JS-style shape a hand-written
// __properties default may carry. The package's parser does not
// produce object-literal defaults today.
function swapDelimiterQuotes(s) {
    let out = '';
    let inStr = false;
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (!inStr) {
            if (c === "'") { out += '"'; inStr = true; i++; continue; }
            out += c;
            i++;
            continue;
        }
        // Inside a string-delimited run.
        if (c === "'") { out += '"'; inStr = false; i++; continue; }
        if (c === '\\' && i + 1 < s.length) {
            const next = s[i + 1];
            // \' (escaped apostrophe in JS) -> ' (apostrophe is
            // legal inside a JSON "..." string with no escape).
            if (next === "'") { out += "'"; i += 2; continue; }
            // Any other backslash escape passes through verbatim.
            out += c + next;
            i += 2;
            continue;
        }
        // Bare " inside the value would terminate the JSON string
        // we're building. Escape it.
        if (c === '"') { out += '\\"'; i++; continue; }
        out += c;
        i++;
    }
    return out;
}

function parseDefault(defStr) {
    if (defStr == null) return null;
    if (defStr === "''")             return '';
    if (defStr === '0' || defStr === '0.0') return 0;
    if (defStr === 'false')          return false;
    if (defStr === 'true')           return true;
    if (defStr === 'null')           return null;
    if (defStr === '[]')             return [];
    if (defStr.startsWith("'") && defStr.endsWith("'")) return defStr.slice(1, -1);
    if (defStr.startsWith('{') && defStr.endsWith('}')) {
        // Object-literal defaults. Two parse attempts:
        //   1. Strict JSON. Handles values authored with double-
        //      quoted keys and double-quoted strings (the canonical
        //      JSON shape).
        //   2. JS-style with single-quote delimiters (`{name: 'x',
        //      role: 'admin'}`). swapDelimiterQuotes rewrites the
        //      string-delimiter `'` to `"`, un-escapes any `\'`
        //      inside string content, and escapes any bare `"`.
        //
        // Last resort returns an empty object so the renderer
        // doesn't crash. The package's parser does not produce
        // object-literal defaults today; this path is for hand-
        // written __properties blocks with custom types. The
        // attempt sequence covers what consumers reasonably write
        // by hand.
        //
        // Known limit: bare object keys (`{name: 'x'}` instead of
        // `{"name": 'x'}`) are not auto-quoted. The viewer accepts
        // either fully-JSON or a JS-style with quoted keys; a JS-
        // style with bare keys falls to `{}`. Quoting bare keys
        // would require a small JS-literal parser; today the
        // empty-object fallback plus the console.warn at the
        // bottom of this function surfaces the miss to the author.
        try { return JSON.parse(defStr); } catch { /* fall through */ }
        try { return JSON.parse(swapDelimiterQuotes(defStr)); } catch { return {}; }
    }
    // Unrecognised string shape. The default-collector emits one of
    // the forms above for every shipped scalar / string[] type, so a
    // miss usually means a hand-written __properties block with a
    // shape the viewer doesn't model yet (custom type vocabulary,
    // a Date literal, etc.). Surface the miss so a sink author
    // debugging a stuck control sees it. Warn once per default-string
    // so a single unsupported custom type doesn't spam the console
    // on every Process click while the user iterates.
    if (!_parseDefaultWarned.has(defStr) && typeof console !== 'undefined' && console.warn) {
        console.warn('parseDefault: unrecognised default string', JSON.stringify(defStr), '— field will seed as null');
        // Cap the dedup Set so a long-lived editor session that
        // iterates through many distinct unsupported defaults
        // doesn't accumulate them indefinitely. At 256 entries we
        // start over — at worst a user re-sees a warning they've
        // already dismissed; that's fine.
        if (_parseDefaultWarned.size >= 256) _parseDefaultWarned.clear();
        _parseDefaultWarned.add(defStr);
    }
    return null;
}
const _parseDefaultWarned = new Set();

// Smoke test: parse the documented Full Example end-to-end.
// Run with: node tests/smoke.js

import { TextFormBuilder, ERR, errorName, evaluateWhen, interpolate, renderFragments, parseDecorated, inferDataSchema, scaffoldDataObject, scaffoldDataClass, scaffoldTypeScript } from '../src/index.js';

const FULL_EXAMPLE = `columns: 20

extChoices = ["log", "ndjson", "csv"] -> {logExtension}
logTypes   = ["text", "ndjson", "csv"] -> {logOutputType}
levels     = {levelsList}

[container({title},{shorthandDescription})]

  - [select(5,#logTypes,{logOutputType})] Log Output Type

  - [textfield(10,{logDirectory})] Logging Directory
    | [textfield(6,{logFileTemplate})] File Name Template
    | [combo(4,#extChoices,{logExtension})] Extension

  - [>container(panels=[1:8,2:12])] [toggle(3,{rollingLogsEnabled})] Rolling Log Configuration

    1. Panel One
      - [number(6,{maxFileSize},min=1,max=1073741824,step=1024)] Max File Size (bytes)
      - [number(6,{maxFileCount},min=1,max=10000,step=1)] Max File Count

    2. Panel Two
      - [select(5,#levels,{logLevel})] Log Level
      - [check(3,{compressOldLogs},when="rollingLogsEnabled")] Compress Old Logs
`;

function header(title) {
    console.log(`\n=== ${title} ===`);
}

function fail(msg) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

function assertEq(actual, expected, label) {
    const a = JSON.stringify(actual, sortKeys);
    const e = JSON.stringify(expected, sortKeys);
    if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
}

function sortKeys(_, value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.keys(value).sort().reduce((o, k) => { o[k] = value[k]; return o; }, {});
    }
    return value;
}

function assertTrue(cond, label) {
    if (!cond) fail(label);
}

// 1. Parse the Full Example.
header('Parse Full Example');
const builder = new TextFormBuilder({ schemaText: FULL_EXAMPLE });
const result = builder.parse();

if (result.error !== ERR.OK) {
    console.error(`Parse failed (${errorName(result.error)}):`);
    for (const m of result.messages) console.error('  -', m);
    process.exit(1);
}

const ast = result.payload;
console.log('OK — version', ast.version, 'columns', ast.columns);

// 2. Top-level shape.
header('Top-level shape');
assertEq(ast.version, 1, 'version');
assertEq(ast.columns, 20, 'columns');
assertEq(Object.keys(ast.optionSources).sort(), ['extChoices', 'levels', 'logTypes'], 'optionSources keys');
assertEq(ast.optionSources.extChoices.type, 'static', 'extChoices type');
assertEq(ast.optionSources.extChoices.values, ['log', 'ndjson', 'csv'], 'extChoices values');
assertEq(ast.optionSources.extChoices.binding, 'logExtension', 'extChoices binding');
assertEq(ast.optionSources.levels.type, 'dynamic', 'levels type');
assertEq(ast.optionSources.levels.path, 'levelsList', 'levels path');
console.log('OK');

// 3. Root container shape.
header('Root container');
const root = ast.root;
assertEq(root.nodeKind, 'container', 'root.nodeKind');
assertEq(root.collapsible, false, 'root.collapsible');
assertEq(root.title, [{ kind: 'binding', path: 'title' }], 'root.title');
assertEq(root.description, [{ kind: 'binding', path: 'shorthandDescription' }], 'root.description');
assertEq(root.panels, null, 'root.panels');
assertEq(root.rows.length, 3, 'root.rows count');
console.log('OK');

// 4. Row 1 — single select.
header('Row 1: single select');
const r1 = root.rows[0];
assertEq(r1.controls.length, 1, 'row 1 control count');
const c1 = r1.controls[0];
assertEq(c1.controlType, 'select', 'c1 type');
assertEq(c1.width, 5, 'c1 width');
assertEq(c1.optionsSource, 'logTypes', 'c1 optionsSource');
assertEq(c1.binding, 'logOutputType', 'c1 binding');
console.log('OK');

// 5. Row 2 — three controls via | continuations.
header('Row 2: three controls');
const r2 = root.rows[1];
assertEq(r2.controls.length, 3, 'row 2 control count');
assertEq(r2.controls.map(c => c.controlType), ['textfield', 'textfield', 'combo'], 'row 2 types');
assertEq(r2.controls.map(c => c.width), [10, 6, 4], 'row 2 widths');
assertEq(r2.controls[2].optionsSource, 'extChoices', 'row 2 c3 optionsSource');
console.log('OK');

// 6. Row 3 — sub-container with header control + panels.
header('Row 3: collapsible sub-container with panels');
const r3 = root.rows[2];
assertEq(r3.controls.length, 1, 'row 3 has one item (the container)');
const sub = r3.controls[0];
assertEq(sub.nodeKind, 'container', 'sub.nodeKind');
assertEq(sub.collapsible, true, 'sub.collapsible');
assertEq(sub.headerControls.length, 1, 'sub.headerControls count');
assertEq(sub.headerControls[0].controlType, 'toggle', 'sub.headerControls[0].type');
assertEq(sub.headerControls[0].binding, 'rollingLogsEnabled', 'sub.headerControls[0].binding');
assertTrue(Array.isArray(sub.panels), 'sub has panels array');
assertEq(sub.panels.length, 2, 'sub.panels count');
assertEq(sub.panels[0].number, 1, 'panel 1 number');
assertEq(sub.panels[0].label, [{ kind: 'text', text: 'Panel One' }], 'panel 1 label');
assertEq(sub.panels[0].width, 8, 'panel 1 width');
assertEq(sub.panels[1].number, 2, 'panel 2 number');
assertEq(sub.panels[1].label, [{ kind: 'text', text: 'Panel Two' }], 'panel 2 label');
assertEq(sub.panels[1].width, 12, 'panel 2 width');
console.log('OK');

// 7. Panel 1 rows.
header('Panel 1 rows');
const p1rows = sub.panels[0].rows;
assertEq(p1rows.length, 2, 'panel 1 row count');
const p1c1 = p1rows[0].controls[0];
assertEq(p1c1.controlType, 'number', 'p1r1 type');
assertEq(p1c1.params.min, 1, 'p1r1 min');
assertEq(p1c1.params.max, 1073741824, 'p1r1 max');
assertEq(p1c1.params.step, 1024, 'p1r1 step');
console.log('OK');

// 8. Panel 2 — when= captured + parsed.
header('Panel 2 when=');
const p2rows = sub.panels[1].rows;
assertEq(p2rows[1].controls[0].controlType, 'check', 'p2r2 type');
assertEq(p2rows[1].controls[0].when, 'rollingLogsEnabled', 'p2r2 when (raw)');
assertTrue(p2rows[1].controls[0].whenAst != null, 'p2r2 when AST present');
console.log('OK');

// 9. Expression evaluator.
header('Expression evaluator');
assertEq(evaluateWhen('rollingLogsEnabled', { rollingLogsEnabled: true }), true, 'simple truthy');
assertEq(evaluateWhen('rollingLogsEnabled', { rollingLogsEnabled: false }), false, 'simple falsy');
assertEq(evaluateWhen("compression != 'none'", { compression: 'gzip' }), true, '!= literal');
assertEq(evaluateWhen("compression != 'none'", { compression: 'none' }), false, '!= equal');
assertEq(evaluateWhen("level in ['debug','trace']", { level: 'debug' }), true, 'in [list]');
assertEq(evaluateWhen("level in ['debug','trace']", { level: 'info' }), false, 'in [list] miss');
assertEq(evaluateWhen('a && b', { a: true, b: true }), true, 'and');
assertEq(evaluateWhen('a || b', { a: false, b: true }), true, 'or');
assertEq(evaluateWhen('!a', { a: false }), true, 'not');
console.log('OK');

// 10. Layout violation triggers INVALID_LAYOUT.
header('Layout violation');
const bad = new TextFormBuilder({
    schemaText: `columns: 10

[container({t},{d})]

  - [textfield(8,{a})] A
    | [textfield(8,{b})] B
`
});
const badResult = bad.parse();
assertEq(badResult.error, ERR.INVALID_LAYOUT, 'expected INVALID_LAYOUT');
assertTrue(badResult.messages.some(m => m.includes('exceeds columns')), 'message mentions exceeds');
console.log('OK —', badResult.messages[0]);

// 11. Unknown type triggers UNKNOWN_TYPE.
header('Unknown type');
const u = new TextFormBuilder({
    schemaText: `columns: 10

[container({t},{d})]

  - [numbr(5,{x})] X
`
});
const ur = u.parse();
assertEq(ur.error, ERR.UNKNOWN_TYPE, 'expected UNKNOWN_TYPE');
console.log('OK —', ur.messages[0]);

// 12. Bad option ref triggers INVALID_REF.
header('Bad option ref');
const o = new TextFormBuilder({
    schemaText: `columns: 10

[container({t},{d})]

  - [select(5,#missingOpt,{x})] X
`
});
const or_ = o.parse();
assertEq(or_.error, ERR.INVALID_REF, 'expected INVALID_REF');
console.log('OK —', or_.messages[0]);

// 13a. display() — read-only bound text.
header('display() control');
const dispResult = new TextFormBuilder({
    schemaText: `columns: 10

[container({t},{d})]

  - [display(8,{statusText})] Status
  - [display(8,{lastSyncedAt},format='YYYY-MM-DD HH:mm')] Last Synced
`
}).parse();
if (dispResult.error !== ERR.OK) {
    console.error(dispResult.messages);
    fail('display parse failed');
}
const dispCtl1 = dispResult.payload.root.rows[0].controls[0];
assertEq(dispCtl1.controlType, 'display', 'display type');
assertEq(dispCtl1.binding, 'statusText', 'display binding');
assertEq(dispCtl1.width, 8, 'display width');
assertEq(dispCtl1.readOnly, true, 'display readOnly flag');
const dispCtl2 = dispResult.payload.root.rows[1].controls[0];
assertEq(dispCtl2.params.format, 'YYYY-MM-DD HH:mm', 'display format');
console.log('OK');

// 13b. Tooltips block + tt= reference + interpolation.
header('Tooltips and tt= references');
const ttResult = new TextFormBuilder({
    schemaText: `columns: 10

tooltips = [
  "t1" = "Static tooltip text.",
  "t2" = "Hello {userName}, your level is {level}.",
  "t3" = "Computed: {@formatStatus}"
]

[container({t},{d})]

  - [textfield(10,{userName},tt="t1")] User Name
`
}).parse();
if (ttResult.error !== ERR.OK) {
    console.error(ttResult.messages);
    fail('tooltips parse failed');
}
assertEq(Object.keys(ttResult.payload.tooltips).sort(), ['t1', 't2', 't3'], 'tooltips keys');
const ctlT = ttResult.payload.root.rows[0].controls[0];
assertEq(ctlT.tooltipRef, 't1', 'control tooltipRef');

// Tooltip values are now TextFragment[] — render through renderFragments
const tt2 = ttResult.payload.tooltips.t2;
assertEq(
    renderFragments(tt2, { userName: 'Steve', level: 'admin' }),
    'Hello Steve, your level is admin.',
    'render data fragments'
);
const tt3 = ttResult.payload.tooltips.t3;
assertEq(
    renderFragments(tt3, {}, { formatStatus: () => 'OK' }),
    'Computed: OK',
    'render function fragments'
);
// Unresolved placeholders show as the original braced form
assertEq(
    renderFragments(tt2, { userName: 'Steve' }),
    'Hello Steve, your level is {level}.',
    'unresolved binding preserved'
);
// interpolate() still works on raw strings (independent helper)
assertEq(
    interpolate('Hello {name}', { name: 'Steve' }),
    'Hello Steve',
    'interpolate raw string'
);
console.log('OK');

// 13c. Tooltip cross-ref miss → INVALID_REF
header('Bad tooltip ref');
const ttBad = new TextFormBuilder({
    schemaText: `columns: 10

[container({t},{d})]

  - [textfield(10,{x},tt="missing")] X
`
}).parse();
assertEq(ttBad.error, ERR.INVALID_REF, 'expected INVALID_REF for missing tooltip');
console.log('OK —', ttBad.messages[0]);

// 13d. Function binding {@name} on display works; on writeable control fails.
header('Function bindings');
const fnOk = new TextFormBuilder({
    schemaText: `columns: 10

[container({t},{d})]

  - [display(8,{@formatStatus})] Status
`
}).parse();
if (fnOk.error !== ERR.OK) { console.error(fnOk.messages); fail('display+@fn parse failed'); }
assertEq(fnOk.payload.root.rows[0].controls[0].binding, '@formatStatus', 'fn binding preserved');
console.log('OK — display accepts @fn');

const fnBad = new TextFormBuilder({
    schemaText: `columns: 10

[container({t},{d})]

  - [textfield(8,{@formatStatus})] Status
`
}).parse();
assertEq(fnBad.error, ERR.INVALID_PARAM, 'expected INVALID_PARAM for @fn on writeable');
console.log('OK —', fnBad.messages[0]);

// 13e. Decorators in tooltip text + colors block resolution.
header('Decorators + colors');
const decResult = new TextFormBuilder({
    schemaText: `columns: 10

colors = [
    "warning" = "#F39C12",
    "danger"  = "#E74C3C"
]

tooltips = [
    "alert" = "\`b:warning\`Warning:\`\` see {detail}",
    "boom"  = "\`+b#F00\`Critical\`\` failure",
    "noref" = "Plain \`b\`bold\`\` text",
    "themed" = "\`:custom\`Themed\`\`"
]

[container({t},{d})]

  - [textfield(10,{userName},tt="alert")] User Name
`
}).parse();
if (decResult.error !== ERR.OK) {
    console.error(decResult.messages);
    fail('decorators parse failed');
}

// Resolved color
const alert = decResult.payload.tooltips.alert;
assertEq(alert[0], { kind: 'text', text: 'Warning:', style: { bold: true, fg: { name: 'warning', resolved: '#F39C12' } } }, 'alert frag 0');
assertEq(alert[1].kind, 'text', 'alert frag 1 kind');
assertEq(alert[1].text, ' see ', 'alert frag 1 text (no style)');
assertEq(alert[2], { kind: 'binding', path: 'detail' }, 'alert frag 2 binding');

// Hex direct + stacked size + bold
const boom = decResult.payload.tooltips.boom;
assertEq(boom[0].style, { bold: true, sizeStep: 1, fg: { name: null, resolved: '#FF0000' } }, 'boom style');

// Plain text with bold span — three fragments: pre, styled, post
const noref = decResult.payload.tooltips.noref;
assertEq(noref.length, 3, 'noref fragment count');
assertEq(noref[0], { kind: 'text', text: 'Plain ' }, 'noref frag 0 plain');
assertEq(noref[1], { kind: 'text', text: 'bold', style: { bold: true } }, 'noref frag 1 styled');
assertEq(noref[2], { kind: 'text', text: ' text' }, 'noref frag 2 plain');

// Unresolved color name passes through with resolved=null
const themed = decResult.payload.tooltips.themed;
assertEq(themed[0].style.fg, { name: 'custom', resolved: null }, 'unresolved color preserved');
console.log('OK');

// 13f. Label capture — controls now carry their visible label as fragments.
header('Label capture');
const labResult = new TextFormBuilder({
    schemaText: `columns: 10

[container({t},{d})]

  - [textfield(10,{x})] User Name
`
}).parse();
const ctlLab = labResult.payload.root.rows[0].controls[0];
assertEq(ctlLab.label, [{ kind: 'text', text: 'User Name' }], 'control label fragments');
console.log('OK');

// 13g. Colors block: bad hex value → PARSE_ERROR
header('Bad color hex');
const badHex = new TextFormBuilder({
    schemaText: `columns: 10

colors = [ "warn" = "#GGG" ]

[container({t},{d})]
  - [textfield(10,{x})] X
`
}).parse();
assertEq(badHex.error, ERR.PARSE_ERROR, 'bad hex should be PARSE_ERROR');
console.log('OK —', badHex.messages[0]);

// 13h. parseDecorated standalone
header('parseDecorated standalone');
const standalone = parseDecorated('`b#0F0`green bold`` plain', { });
assertEq(standalone.length, 2, 'standalone frag count');
assertEq(standalone[0].style, { bold: true, fg: { name: null, resolved: '#00FF00' } }, 'standalone style');
assertEq(standalone[1], { kind: 'text', text: ' plain' }, 'standalone trailing');
console.log('OK');

// 13i. Named-text declarations + literal + #ref in container params.
header('Named text + container literal/ref');
const ntResult = new TextFormBuilder({
    schemaText: `columns: 10

shorthandDescription = "\`+b\`Directory\`\` \`i\`(server path)\`\`"

[container("Text File",#shorthandDescription)]

  - [textfield(10,{logDirectory})] Logging Directory
`
}).parse();
if (ntResult.error !== ERR.OK) {
    console.error(ntResult.messages);
    fail('named-text parse failed');
}
const ntRoot = ntResult.payload.root;
assertEq(ntRoot.title, [{ kind: 'text', text: 'Text File' }], 'literal title');
assertEq(ntRoot.description.length, 3, 'inlined named-text desc fragment count');
assertEq(ntRoot.description[0].style, { bold: true, sizeStep: 1 }, 'desc frag 0 style');
assertEq(ntRoot.description[0].text, 'Directory', 'desc frag 0 text');
assertEq(ntRoot.description[2].style, { italic: true }, 'desc frag 2 style');
assertEq(Object.keys(ntResult.payload.namedText), ['shorthandDescription'], 'namedText map populated');
console.log('OK');

// 13j. Unresolved #ref in container passes through (renderer's job)
header('Unresolved container ref');
// Reference policy: every #name must be declared in the same
// document. Only {@function} references resolve externally. So an
// unresolved #ref is INVALID_REF, not a pass-through.
const urResult = new TextFormBuilder({
    schemaText: `columns: 10

[container("Title",#missingThing)]

  - [textfield(10,{x})] X
`
}).parse();
if (urResult.error !== ERR.INVALID_REF) {
    console.error(urResult.messages);
    fail(`unresolved #ref should raise INVALID_REF, got ${urResult.error}`);
}
if (!urResult.messages.some(m => m.includes('missingThing'))) {
    fail(`error message should mention 'missingThing', got: ${urResult.messages.join(' | ')}`);
}
console.log('OK');

// 13k. init= capability — literal, binding, function
header('init= variants');
const initResult = new TextFormBuilder({
    schemaText: `columns: 10

[container({t},{d})]

  - [textfield(10,{logLevel},init="debug")] Log Level
  - [number(5,{port},init=8080)] Port
  - [check(3,{rolling},init=true)] Rolling
  - [textfield(10,{userName},init={defaultUser})] User Name
  - [display(8,{@formatStatus},init={@computeDefault})] Status
`
}).parse();
if (initResult.error !== ERR.OK) {
    console.error(initResult.messages);
    fail('init parse failed');
}
const ctls = initResult.payload.root.rows.map(r => r.controls[0]);
assertEq(ctls[0].init, { kind: 'literal',  value: 'debug' },          'init string literal');
assertEq(ctls[1].init, { kind: 'literal',  value: 8080 },             'init integer literal');
assertEq(ctls[2].init, { kind: 'literal',  value: true },             'init boolean literal');
assertEq(ctls[3].init, { kind: 'binding',  path: 'defaultUser' },     'init data binding');
assertEq(ctls[4].init, { kind: 'function', name: 'computeDefault' }, 'init function ref');
console.log('OK');

// 13l. Schema inference on a small form.
header('Infer data schema');
const inferAst = new TextFormBuilder({
    schemaText: `columns: 12

[container({title},{description})]

  - [textfield(8,{userName})] Name
  - [number(4,{age})] Age
  - [check(4,{active})] Active
  - [display(8,{@formatStatus})] Status
  - [repeater({routes},min=1)] Routes
      - [textfield(6,{this.match})] Match
        | [textfield(6,{this.target})] Target
`
}).parse();
if (inferAst.error !== ERR.OK) {
    console.error(inferAst.messages);
    fail('infer parse failed');
}
const inferred = inferDataSchema(inferAst.payload);
const paths = inferred.fields.map(f => f.path).sort();
assertTrue(paths.includes('userName'),         'fields include userName');
assertTrue(paths.includes('age'),              'fields include age');
assertTrue(paths.includes('active'),           'fields include active');
assertTrue(paths.includes('routes'),           'fields include repeater array');
assertTrue(paths.includes('routes[].match'),   'fields include repeater element prop match');
assertTrue(paths.includes('routes[].target'),  'fields include repeater element prop target');
assertTrue(inferred.functions.some(f => f.name === 'formatStatus'), 'function formatStatus inferred');

// Scaffolds produce something that looks right
const obj = scaffoldDataObject(inferred);
assertTrue(obj.includes('userName:'),  'object scaffold has userName');
assertTrue(obj.includes('routes: ['),  'object scaffold has routes array');
assertTrue(obj.includes('match:'),     'object scaffold has match (element)');

const cls = scaffoldDataClass(inferred, 'MyData');
assertTrue(cls.includes('class MyData'),                'class header');
assertTrue(cls.includes('this.userName'),               'class assigns userName');
assertTrue(cls.includes('formatStatus(data)'),          'class scaffolds function');

const ts = scaffoldTypeScript(inferred, 'MyForm');
assertTrue(ts.includes('interface MyForm'),       'TS interface');
assertTrue(ts.includes('userName: string'),       'TS prop');
assertTrue(ts.includes('routes: {'),              'TS array-of element');

console.log('OK');

// 14. Custom control type via registerControl.
header('Custom control type');
const c = new TextFormBuilder({
    schemaText: `columns: 10

[container({t},{d})]

  - [json(6,{schemaDoc},rows=12)] Schema
`
});
c.registerControl('json', { params: { rows: { type: 'integer', default: 8 } } });
const cr = c.parse();
if (cr.error !== ERR.OK) {
    console.error(cr.messages);
    fail('custom type parse failed');
}
const customCtl = cr.payload.root.rows[0].controls[0];
assertEq(customCtl.controlType, 'json', 'custom type');
assertEq(customCtl.params.rows, 12, 'custom param rows');
console.log('OK');

// 15. Trailing ` # comment` on logical lines (space before #, space or EOL after #).
header('Trailing end-of-line comments');
const tr = new TextFormBuilder({
    schemaText: `columns: 10  # grid

[container({a},{b})]

  - [textfield(5,{x})] X  # one field
`
}).parse();
if (tr.error !== ERR.OK) {
    for (const m of tr.messages) console.error('  -', m);
    fail('trailing comment parse');
}
assertEq(tr.payload.columns, 10, 'columns with EOL comment');
console.log('OK');

console.log('\nAll smoke tests passed.\n');

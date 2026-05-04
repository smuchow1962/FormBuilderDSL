# Technical analysis: @mmpworks/formbuilder-dsl

A Principal Engineer reading the package end-to-end. Names what the
code does well, what the central abstractions buy, where the seams
are crisp, and where there is room to grow without breaking the
shape of the package.

> Companion docs:
> [architecture.md](architecture.md) for the AST + module layout,
> [design-philosophy.md](design-philosophy.md) for CUPID + DRY rules,
> [expression-trust.md](expression-trust.md) for the `when=` trust
> story, [architecture-no-ast-caching.md](architecture-no-ast-caching.md)
> for the hard rule on AST walks. This doc summarises the strengths
> in one place and shows worked examples a consumer can read without
> opening the source.

---

## 1. What the package solves

A long form with conditional fields, curated dropdowns, tooltips,
and a per-host renderer. The traditional shape is:

- One JSON Schema with vendor extensions for layout.
- One bespoke renderer per UI stack.
- A second copy of the form in the partner-facing UI.
- A third copy when the spec leaves the engineering team.

The package replaces that with a single text definition, a stable
AST, and a renderer of the consumer's choosing. The DSL stays
portable. The host UI moves independently.

```
.mmpform text  →  TextFormBuilder.parse()  →  AST  →  any renderer
                                              │
                                              └── Vue, React, Blazor,
                                                  ASCII preview, ML
                                                  scaffold, code-gen,
                                                  …
```

---

## 2. Strengths

### 2.1 Control vocabulary is data, not code

The single most important architectural decision in the package.
The parser does not know any control type by name. It knows the
*shape* of a control declaration: an LBRACKET, a type identifier,
a parens block, an RBRACKET. The vocabulary lives in a control
spec the consumer hands in.

Adding a `json` control with rows + schema parameters is one entry:

```js
const result = builder.registerControl('json', {
    params: {
        rows:   { type: 'integer', default: 8 },
        schema: { type: 'string' }
    }
});
```

The parser does not gain a code path. It looks the type up, applies
defaults from the spec, and emits a `ControlNode` with
`controlType: 'json'`. The renderer decides what `json` means.

The same trick keeps the `__common` block out of every control
type's own params: `when=`, `tt=`, `init=`, `compute=`, `explain=`,
and `__dataType=` are universal across every control, so the spec
declares them once and the parser hoists them onto the node's
top-level fields. New universal params are one entry, not a
sweep through every control type.

### 2.2 Symmetric reader / writer for string content

`src/string-literal.js` defines one grammar for quoted strings and
exports two functions over it: `readQuotedString` for the parser
and `writeQuotedString` for the property-block renderer. The
reader rejects bare C0 control bytes, DEL, and a bare CR; the
writer raises `TypeError` on the same bytes. Round-trip is honest
by construction — bytes the writer cannot emit cannot reach the
reader, and bytes the reader rejects cannot land in a parsed
default.

That contract makes the property-block round trip stable across
every value the parser accepts, including newlines, tabs, quotes,
backslashes, and Unicode (umlauts, CJK, emoji). The README's "byte-
for-byte stable across the cycle" claim is something the package
can actually keep, not just hope for.

### 2.3 Three-layer prototype-walking defence

`src/safe-keys.js` carries the rule for the three names that walk
the JavaScript prototype chain (`__proto__`, `prototype`,
`constructor`). The same Set drives:

1. **Read-time walks** through host data (`{path}` in
   `interpolate`, decorated `{binding}` fragments, `when=` path
   resolution). `resolveSafePath` refuses to follow any segment in
   the Set and only reads own properties on each step.
2. **Parse-time writes** where a parsed identifier becomes an
   object property key (control bindings, named-text keys, color
   keys, tooltip keys, named-object keys, option-source names).
   `assertSafeObjectKey` raises `INVALID_PARAM` with the offending
   token's line and column.
3. **Read-side bracket access** on every model-owned dictionary.
   `safeGet(map, key)` does the own-property check and skips the
   reserved names regardless of the map's prototype.

Belt, suspenders, and a third belt. The exported `RESERVED_OBJECT_KEYS`
view is a `Proxy` that throws on `add` / `delete` / `clear`, so a
downstream tampering attempt cannot widen or narrow the rule at
runtime. One Set, one rule, three sites, no drift.

### 2.4 Honest costs (no AST caching)

The package re-walks the AST on every helper call. `parse()`
re-tokenizes, `process()` re-collects, `inferDataSchema(ast)`
re-walks, `renderFormPreview(ast)` re-walks. There is no
`processFromAst(ast)` shortcut, no memoization, no "fast path."

The trust posture is: the result is honest because the walk is
honest. A cache layer would force the consumer to reason about
freshness — does this AST reflect the source the consumer last
edited; does this property list reflect the bindings the renderer
actually emitted. Re-walking removes that reasoning. The cost is
sub-millisecond on realistic forms.

The escape hatch is documented: a renderer that re-evaluates a
`when=` on every keystroke calls `parseWhen(source)` once and
feeds the AST through `evaluateAst(ast, data)`. The package gives
one straight answer per call; the consumer decides how often to
call.

### 2.5 The `TupleResponse` envelope

Every public method that can fail returns one shape:

```js
{ error: 0|1|2|3|…, payload: <result>|null, messages: string[] }
```

The consumer branches on `error === ERR.OK` once and reads
`payload` or `messages` after. There is no second envelope, no
exception path the consumer has to wrap, no inconsistent
"sometimes returns null, sometimes throws" surface. Even an
unexpected exception inside the parser becomes
`ERR.INTERNAL_ERROR` with a scrubbed first stack frame in the
messages — the path is closed.

The `TupleResponse.fail(code, value)` factory normalises whatever
the caller passes (string, string[], `Error`, or anything else
via `String(value)`), so the parser's pre-formatted strings and a
consumer-side validator's exceptions ride out through one shape.

### 2.6 Editor-aligned error positions across folded declarations

The tokenizer's two-stage design (LineSplitter + LineTokenizer)
folds bracket-balanced declarations into a single logical line so
the parser's grammar stays simple. The folding used to come at a
cost: a parse error on the sixth physical line of a six-line
container declaration would report a column past 300 on the
folded line — meaningless to an editor that wants to highlight
the actual row.

The current implementation records a `breaks` map at fold time:
each merged newline records the offset where the next physical
line starts, plus the physical line number and the column at that
offset. The LineTokenizer translates every emitted token's
position back through the map, so a `ParseError` carries the
physical `(line, col)` an editor can highlight. Tokens still
carry the merged-content offset for slicing (label-text capture)
because that's a one-way path; the two coordinates serve their
own purposes and the comments name which is which.

### 2.7 Layered limits on hostile input

The parser bounds adversarial work at multiple layers:

- **DSL source length** — `DEFAULT_MAX_INPUT_LENGTH` (1 MB),
  configurable per builder via `maxInputLength`. Refused before
  the lexer reads a single character.
- **Logical-line count** — `MAX_LOGICAL_LINES` (100 000) inside
  `LineSplitter`. Bounds the AST size next to the input cap so a
  1 MB blob of mostly-empty lines can't spike memory.
- **Numeric literal length** — 20 chars (well past
  `Number.MAX_SAFE_INTEGER`). A "numeric literal too long" error
  is more useful than `Infinity` rippling through layout sums.
- **Integer precision** — bare integers past
  `Number.MAX_SAFE_INTEGER` are refused at parse time so a
  rounded value never lands as a control width or a layout sum.
- **Container nesting** — `MAX_NESTING_DEPTH` (16), configurable
  via `maxNestingDepth`.
- **`when=` source length** — `DEFAULT_MAX_WHEN_SOURCE_LENGTH`
  (8 KB).
- **`when=` token count** — `DEFAULT_MAX_WHEN_TOKENS` (2048).

Every cap has a focused error message that names the cap and the
offending value. A consumer hosting untrusted DSL text can pin
each cap downward.

### 2.8 Auto-sync that respects user input

Auto-sync of the `__properties` block keeps the source in step
with what the parser sees: insert the block when missing, refresh
it when controls add or rename a binding. What it must not do is
rewrite a block that already parses to the same dictionary just
because the canonical text shape happens to differ from the
user's typed shape.

The classic case: a user typed `default: "30"` (a string literal)
on an `int` property. The parser coerces `"30"` to the number
`30`, so the canonical text comes back as `default: 30`. Without
the gate, every Process pass would silently rewrite the user's
`"30"` to `30` — the user reads that as their edit being
"stale-reverted."

`viewer/properties-sync.js` adds `arePropertiesSemanticallyEqual`,
which runs the source's existing block through the parser in
isolation and compares the dictionary it produces against the
canonical dictionary. Equal means skip the rewrite. Any genuine
divergence — missing key, init= override, structural change —
falls through to the canonical rewrite.

Defensive on edge cases: a malformed block, a parse error in the
mini-doc, or a missing block all return false, which the caller
treats as "rewrite needed." The gate never blocks an honest
rewrite.

### 2.9 Form-state undo/redo with a pinned seed

`viewer/form-history.js` ships a 32-deep ring buffer for the
rendered form's reactive data. The cursor-first dedup makes
undo + restore round-trips a no-op (the renderer's debounced
`onDataChange` refires after `restoreInto` mutates the live root,
and dedup against the cursor closes the loop without truncating
the redo branch). The seed at index 0 is pinned across the cap so
`seekToSeed()` always returns the post-Process state — Reset
matches its name even after long editing sessions.

`File` / `Blob` / `FileList` values are pre-processed to JSON-
serialisable markers before the snapshot is taken, so two
distinct file picks dedup as different. Without the markers,
`JSON.stringify(File)` would return `"{}"` and the second pick
would silently collapse against the first.

### 2.10 Tests as architecture documentation

The regression-rN files (one per round) are the package's
architectural memory. A future contributor reading the source
sees the comments name what the code prevents in concrete user
terms — "a fast-typing user who clicks Process before the 350 ms
timer fires" — and can find the test that locked the behaviour
in.

Coverage gates in CI keep the boundaries honest:

| Metric | Threshold |
|---|---:|
| Lines | 85% |
| Branches | 75% |
| Functions | 85% |
| Statements | 85% |

The test runner is the built-in `node --test`. No external test
framework. No assertion library. Just `assert.equal`,
`assert.deepEqual`, and the structure the runtime gives.

---

## 3. Novel concepts

### 3.1 Parser is a thin walker over a token stream

The parser does no rendering, holds no DOM, and has no opinion
about what a control type means visually. Three boundaries stay
clean:

| Boundary | Owner |
|---|---|
| Grammar (bracket / paren / marker rules) | Parser |
| Vocabulary (what types exist, what they accept) | Spec |
| Behaviour (what a type does visually) | Consumer's renderer |

Each boundary moves independently. Adding a new control type
does not rebuild the parser. Retargeting a different UI library
does not rebuild the spec. Adding a new component does not force
the consumer's host to learn the grammar.

### 3.2 Two-stage tokenizer with bracket-balanced folding

The LineSplitter folds bracket-balanced multi-line declarations
into single logical lines so the parser stays line-oriented. The
LineTokenizer then walks one logical line and emits tokens that
carry both the merged offset (for slicing) and the physical
(line, col) (for error reporting). Two independent coordinates,
one consistent contract.

The fold also makes the grammar simpler: the parser does not
need a `\` continuation rule, does not need a "look-ahead until
the bracket closes" pre-pass, and does not need to track depth
itself. The splitter handed it a flat array of declarations.

### 3.3 Phase-2 fragment rewrite

Title text, description text, and label text on every container
and control start life as raw strings during phase 1. After
phase 1 finishes (so the colors map and the named-text map are
both fully populated), `rewrite-fragments.js` walks the model
once and rewrites each raw string into a `TextFragment[]`. By
the time the consumer reads the AST, every text field is a
fragment array — the renderer never touches a raw string and a
single rule covers decorated text, `{binding}`, and `#named-text`
references.

### 3.4 `CONTAINER_PARAM_HANDLERS` dispatch table

Container parameter parsing (`title=`, `panels=`, `addLabel=`,
`commit=`, `excluded=`, `minHeight=`, `height=`, …) is a single
table in `parse-containers.js`. The dispatcher does not know any
specific keys; it looks each one up. A new parameter is one
entry. Constraints (`nodeKinds: ['listManager']`) stay
declarative instead of scattering through if / else conditions.

### 3.5 INTERNAL_ERROR with scrubbed stack frames

When the parser throws something other than a `ParseError` (a
`TypeError`, a `RangeError`, anything unexpected), `runParse`
converts it to `ERR.INTERNAL_ERROR` and includes the error name,
message, and the *first* stack frame. The path inside the frame
is scrubbed down to the basename (`parse-controls.js:135:5`)
because a V8 frame embeds the absolute file URL and a response
surfaced to an untrusted caller would otherwise leak the host
filesystem layout. The line and column survive.

The consumer never wraps `parse()` in try / catch. Every failure
mode comes back through the response envelope.

### 3.6 Local-only review docs (`principal-review.md`,
`npm-package.md`)

`docs/principal-review.md` and `docs/npm-package.md` are
gitignored by design. They are local-only working surfaces for
reviewer iteration — a reviewer rewrites the doc in place,
discusses, and the file never lands in the repo. The README
points at the public docs (`architecture.md`, `user-guide.md`,
`design-philosophy.md`, `expression-trust.md`) and stays clean of
the reviewer's iteration trail. The two surfaces serve different
audiences without blurring the boundary.

---

## 4. Use cases (worked examples)

### 4.1 Sink configuration in the Herald ecosystem

Each sink in `Modules/Herald.Sinks/` ships a
`configuration-{kind}.mmpform` next to its source. The Dashboard
parses the file at runtime and renders a form for the sink's
settings. There is no per-sink frontend code — adding a new sink
ships one configuration file and the renderer picks it up.

```dsl
columns: 16

severities = ["Trace", "Debug", "Info", "Warn", "Error"] -> {minimumLevel}

[container({title})]

  - [select(6,#severities,{minimumLevel})] Minimum level
  - [textfield(10,{outputPath})] Output path
  - [number(4,{rotateMb:int},init=64)] Rotate (MB)
  - [check(4,{compress})] Compress rotated files
```

The same AST drives the Dashboard's preview, the configuration
test harness's smoke render, and the documentation site's static
example output.

### 4.2 Banking / treasury configuration

Product parameters that change with jurisdiction or client tier.
Conditional sections gated on yes/no answers. From the README's
example:

```dsl
- [toggle(4,{nonDomestic})] Non-domestic entity
  | [toggle(4,{highExposure})] Above policy threshold

- [>container(panels=[1:10,2:10],when="nonDomestic || highExposure")] Jurisdiction review
  1. Sanctions & screening
    - [textfield(10,{sanctionsRef})] Screening case reference
    - [check(3,{eddComplete})] EDD package complete

  2. FX & hedging
    - [select(5,#fxRoutes,{fxDisclosureRoute})] Disclosure route
```

The `when=` expression is parsed at parse time and stored on the
control as `when` (raw source) and `whenAst` (pre-parsed AST).
The renderer evaluates the AST against current data on every
re-render.

### 4.3 Healthcare protocol entry

A protocol form with curated lists, tooltips for safety copy,
and a `__properties` block that drives the data layer:

```dsl
columns: 14

tooltips = [
    "consent" = "Patient must sign before any sample collection."
]

assays = [#cbc, #panel] -> {assayType}
cbc    = { !name: "cbc",   label: "Complete Blood Count", code: "CBC" }
panel  = { !name: "panel", label: "Comprehensive Panel",  code: "BMP" }

[container({title})]
  - [select(6,#assays,{assayType})] Assay
  - [date(4,{collectionDate})] Collection date
  - [check(4,{consentGiven},tt="consent")] Consent obtained
```

Named objects drive the option list. Each picked value is the
resolved object body, not just a label string. The renderer can
read `code` directly from the picked entry.

### 4.4 Scientific instrument run config

Operator-facing run configuration with guardrails. Numeric
ranges, file pickers, and conditional advanced sections:

```dsl
columns: 18

[container({title})]
  - [number(4,{runDurationSec:int},min=10,max=86400,init=3600)] Duration (sec)
  - [number(4,{sampleRateHz:int},min=1000,max=200000,init=50000)] Sample rate (Hz)
  - [toggle(3,{advanced})] Show advanced

  - [>container(when="advanced")] Advanced
    - [textfield(10,{calibrationProfile})] Calibration profile
    - [number(4,{rolloffFactor:float},min=0.1,max=2.0,step=0.05,init=0.7)] Rolloff
```

The `min=` / `max=` / `step=` parameters land in `params` on the
control. The renderer reads them as constraints; the parser does
not enforce ranges (the `validate.js` pass is for cross-references
and binding policy, not value bounds).

### 4.5 Code-generation from the AST

`inferDataSchema` walks the AST and emits a flat description of
the form's data shape. `scaffoldDataObject`, `scaffoldDataClass`,
`scaffoldTypeScript`, and `scaffoldJsonSchema` consume that
description to produce JS objects, JS classes, TypeScript
interfaces, or JSON Schema documents.

```js
import {
    TextFormBuilder,
    inferDataSchema,
    scaffoldTypeScript
} from '@mmpworks/formbuilder-dsl';

const ast    = new TextFormBuilder({ schemaText }).process().payload;
const schema = inferDataSchema(ast);
const ts     = scaffoldTypeScript(schema, 'FormData');
// → "interface FormData { runDurationSec: number; ... }"
```

The viewer's Object View tab uses the same path to render every
shape live as the user types.

### 4.6 ASCII preview for CI snapshots

`renderFormPreview(ast, { width })` produces a fixed-width text
visualisation of the form. The CI snapshot tests render every
sample form to ASCII and diff against a checked-in baseline, so
a layout-affecting change to the parser is impossible to ship
silently. The same surface drives CLI tooling that wants to dump
a form's structure to a terminal.

---

## 5. Where there is room to grow

### 5.1 Diagnostic accumulation for live editing

The parser is fail-fast: the first error stops the parse, raises
a `ParseError`, and `runParse` converts it to a single-message
`TupleResponse.fail`. An editor surface that wants to highlight
every problem at once (a la TypeScript's "show all errors")
needs to call `parse()` after each fix to see the next
diagnostic.

The architecture doc names this as a future concern. The cost of
the change is real: error-recovery in a hand-written
recursive-descent parser means picking sync points (RBRACKET,
NEWLINE-at-depth-0) and continuing past them after a thrown
ParseError. Layout-check already aggregates (it can report
multiple `INVALID_LAYOUT` rows), so the response envelope
already supports a multi-message failure shape — the missing
piece is the parser's continuation logic.

Complexity: medium. Risk: a half-implemented recovery would
produce noisier errors for the common case (a typo in a single
control). Worth scoping behind an explicit `recoverErrors:
true` option.

### 5.2 Cross-field validation in the DSL itself

Today, value-range checks (`min=` / `max=` / `step=`) ride out
on the AST as parameters; the renderer enforces them. Cross-field
rules (e.g. "endDate must be ≥ startDate") need consumer code.
The `when=` grammar would need a small extension to support
authoring a rule:

```dsl
[number(5,{endDate:int},assert="endDate >= startDate")] End date
```

The grammar already supports `==`, `!=`, `&&`, `||`, `!`, `in
[...]`. Adding `>=`, `<=`, `>`, `<` to the comparison rule is the
cheap part. The expensive part is deciding what an `assert=`
failure does at render time: an inline error, a save block, an
admin warning. The renderer owns that decision today; pushing it
into the DSL means the AST carries the policy, not just the
predicate.

Complexity: low for the grammar; medium for the renderer
contract. Worth an architecture-decision note before
implementing.

### 5.3 I18n / localisation surface

Label fragments and tooltip bodies pass through the parser
unchanged. A form that needs Japanese, English, and German on
the same definition either ships three .mmpform files or pushes
localisation into the renderer's text resolver.

A clean way to add this without breaking the AST: a top-level
`locales = { "en" = { ... }, "ja" = { ... } }` block that holds
override maps for tooltip keys, named-text keys, and label
slots. The `interpolate` path could accept a `locale` option
that resolves from the appropriate map first, then the default
top-level entries. The `TextFragment` shape doesn't change;
only the resolution rule does.

Complexity: medium. A larger surface area to test (round-trip
across locales).

### 5.4 Editor experience: incremental re-parse

The viewer's live-preview re-parses on every keystroke after a
300 ms debounce. A 10 KB form parses in well under that, so the
debounce is the throttle, not the parser. As forms grow into the
50 KB+ range, an incremental re-parse (parse only the changed
declaration, splice into the existing AST) would keep the
debounce honest.

This bumps directly against the no-AST-caching rule and would
need its own architecture note before implementation. The honest
path is probably to keep the rule and tighten the debounce
adaptively (longer for larger sources) before adding incremental
machinery.

### 5.5 First-class async option-source loaders

`{@loadLevels}` is documented as a dynamic option-source path,
and the renderer wires the function at form-init time. The
package has no opinion on whether the function is sync or async;
the renderer decides. Documenting the contract on the
`OptionSource` AST type ("path may be `{@fn}`; renderer may
treat the return value as `Array | Promise<Array>`") would
remove a per-renderer judgment call.

Complexity: low (documentation + a JSDoc tweak on the AST type
in `architecture.md`).

---

## 6. Things the package could be tempted to do, and shouldn't

A few patterns are common in similar tools and are deliberately
absent here. Future contributors reading the source might be
tempted to add them; the audit notes them as resolved decisions.

| Pattern | Why it isn't here |
|---|---|
| AST cache on `process()` keyed by source | Fail-fast trust posture; the consumer caches if they want. See `architecture-no-ast-caching.md`. |
| `processFromAst(ast)` shortcut | Same rule. The consumer holds the AST themselves between calls. |
| Schema validation engine bundled in the package | Renderers vary too much. The AST gives every consumer the data; the consumer plugs in `ajv`, `zod`, or a hand-rolled rule set as fits. |
| Built-in widget components | The package would either bundle React/Vue/Vuetify (huge install footprint) or pick one and exclude the others. The AST + spec + renderer split is the win. |
| Prototype-based parser class | Composition over inheritance is the rule (`design-philosophy.md`). Each parse-* file is a named function taking a `state` arg. Jump-to-definition lands on the actual file. |
| Error-accumulation by default | The parser is fail-fast on purpose. Layout-check is the one pass that aggregates because it is non-destructive (it only reads). A future opt-in for editor surfaces is fine; the default stays fast. |

---

## 7. Bottom line

The package gives consumers three independent moves: change the
DSL, change the spec, change the renderer. Each one is small. The
AST contract carries a `version` field consumers can pin to. The
test suite locks in the behaviour at every round. The trust
boundaries on prototype walking, on string round-trip, and on
input caps are all in one place each.

The recent additions — a semantic-equality gate that protects
user-typed defaults from canonical rewrites, an editor-aligned
error position translator across folded multi-line declarations,
a live-preview default that matches what most users want — all
fit the same shape: they remove a class of surprise without
expanding the public surface.

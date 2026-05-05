# Roadmap

Forward-looking notes about possible additions to the package and the viewer. Items here are not commitments — they are sketched ideas that the principal-engineer reviews flagged as worth considering. Each item names what it would add, what it would cost, and what open questions still need to be settled.

A reader looking for the contract today should read [`architecture.md`](architecture.md), [`expression-trust.md`](expression-trust.md), and the README. This file is for future-direction discussion only.

---

## Language

### Dynamic membership test in `when=` expressions

Today `in` only accepts a literal list on its right side. The grammar requires `[ literal, literal, ... ]` after `IN` and rejects everything else at parse time. A common-enough author wish is to test membership against a runtime array on `data`:

```dsl
# Today: works (literal list).
[textfield(5,{x},when="status in ['draft','review','final']")] X

# Today: PARSE_ERROR. Not yet supported.
[textfield(5,{x},when="status in allowedStatuses")] X
```

The not-yet-supported form would let `allowedStatuses` resolve through the same `resolveSafePath` rule as any other dotted path. Two open questions before adding it:

1. **Type of the right side at runtime.** Today `in` does `node.list.includes(value)`. A dynamic right side could be a string (substring? exact equality? list-of-one?), an array, a Set, a Map, a function-backed lookup. Settling on "must be an array, anything else evaluates false" is the simplest rule that mirrors the literal case.
2. **Strict vs lenient handling of missing.** `when="status in missingPath"` against `{}` should evaluate to `false` (matches the missing-field rule for `==`); the implementation needs to make sure `Array.isArray(undefined)` ends up at the right answer without throwing.

Until that lands, the workaround is to declare the list as an option source and reference `#name` in the value list directly, which keeps the membership rule out of the expression evaluator entirely.

---

## Package API

### Run-time validation messages on the AST

`ParamSpec.message` covers parse-time messages today (a typo on a control's `port=` parameter surfaces the spec author's chosen text). The other half is render-time validation: a `validate=` parameter on a binding that runs a `when=`-style expression against the data object and surfaces an error string when it returns false. A consumer wiring their own onSubmit handler today does this work themselves; lifting it into the AST would let the package's renderer surface field-level errors uniformly.

Cost: medium. Adds a new param type to the spec, a new evaluation step in the renderer or a public helper, and a story for surfacing the resulting error strings. The trust model is the same as `evaluateWhen`'s.

### Form-state lifecycle hooks

`onLoad`, `onSubmit`, `onChange`, `onValidate`. Peers (Form.io, JSONForms) ship explicit hook points so a form author can declare side-effects in the DSL. Today the consumer wires their own.

Cost: medium. New top-level block (`hooks = [...]`), typed registry shape, lifecycle trust story (hooks are user-declared but resolve against a function registry — same `hasOwnProperty` rule as `{@fn}` placeholders).

### Refinement composability

Refinements like `min` / `max` on `number`, `pattern` on `textfield`, `length` on `string[]` live as ad-hoc per-control params rather than a shared `refinement` shape. Routing them through one composable helper would let `validateProperties` enforce the same refinements at sink-load time.

### Repeater cross-row validation

"All routes must have unique match patterns." Today `repeater` and `listManager` declare per-row controls; cross-row validation is the consumer's problem. A `where=` or `unique=` parameter at the container level plus a validator pass on the AST would close the loop.

### Internationalisation

No story for swapping label text by locale. A `locale="..."` parameter on labels (or a separate `messages = [...]` block keyed by locale) would close the gap. Cost: medium — block grammar + per-locale resolution at render time + tests for the trust story (locales are user data; the registry must own-property-check).

### `validateAgainstSchema(ast, data)`

Inverse of `scaffoldJsonSchema` (which ships today). Wraps Ajv or an inline checker over the inferred schema. Useful when a consumer hands the form data back to the package for validation.

### Multi-step / wizard layout

`panels` give horizontal lanes or accordion. Peers ship a wizard step shape (Next / Previous, progress bar). Today an author models this with multiple collapsible containers and a `when=` per step. A first-class step nodeKind would make the renderer's job easier and give a stable AST for tooling. Cost: medium — new nodeKind, new container-parameter handler, new viewer component, AST versioning bump.

### Accumulating-error parse mode

Today the parser is fail-fast. An author with three typos has to fix them one at a time. A `{ accumulateErrors: true }` mode that collects diagnostics into the `messages` array without throwing on the first one would be a real improvement for a live editor (matches what TSC and Roslyn do). Cost: every `throw new ParseError` site needs to learn the new mode and either record-and-continue or skip-this-node-and-continue.

### Streaming / incremental parse

The current parser reads the full input into a `LineSplitter.split()` array and walks it. For the documented 1 MB cap, fine. A streaming variant would let a consumer parse multi-megabyte forms without freezing a UI thread. Significant rework — the line splitter is bracket-balance-aware and panel / row resolution is non-streaming.

---

## Viewer

### Live-preview server / playground

The viewer requires a static HTTP server (`python -m http.server`); peers ship a hosted playground at a URL. The Share button is the closest current equivalent (browser-side gzip + base64 into the URL hash). Cost: small if the team is willing to point a CDN at `viewer/index.html` and use the existing share-link encoding.

### Full a11y deep-pass

The viewer wires semantic `<label>` elements with `aria-labelledby`, `role="group"`, and `aria-required` on the form-control wrapper. Vuetify's individual inputs still receive their visible label via the renderer's stack rather than via Vuetify's built-in `label` prop. A pass that switches every control to use Vuetify's `label` prop and wires error-message id linkage would be the proper fix; the cost is restructuring `renderControl` to fold the label text into each control's props rather than rendering it as a sibling div.

### Form-state diff / undo across edits

Vue's reactive proxy already gives the change events; a wrapper history-stack on the viewer would handle undo/redo without touching the package. Cost: small to medium.

---

## Edition / tier awareness on controls

A consumer surfaced this when planning a configuration UI where some fields are unlocked only above a certain product tier (Community / Pro / Enterprise). The current grammar has no first-class way for a control to declare "this field requires Pro" — the consumer has to either pre-filter the `.mmpform` text server-side or wrap the rendered output in conditional Vuetify shell.

Sketch of what would land:

```dsl
- [number(4,{maxBatchDelayMs}, tier="Pro", tierPitch="Pro unlocks larger-batch tuning.")] Max delay (ms)

[container("Audit chain", tier="Enterprise")]
  - [textfield(12,{auditPath})] Audit file path
  - [check(3,{verifyOnLoad})] Verify on load
```

Two attributes on either a control or a container:

- `tier="Community" | "Pro" | "Enterprise"` — minimum edition for the control to be enabled.
- `tierPitch="..."` — short text shown in a tooltip or hover when the running edition is below the tier. Kept short on purpose; longer pitches belong in the consumer's diagnostics surface.

The renderer reads the running edition from a context variable (`tier` on the form's data, like the existing `{path}` bindings) and either disables the control with the pitch as tooltip, or hides it entirely if the consumer prefers (a `tierMode="disabled" | "hidden"` config knob at the form level). The trust story is the same as `evaluateWhen` — `tier` is a plain string compared against a known set, no expression evaluation involved.

Why this is worth landing:

1. The pattern shows up in any commercial product with capability-based tiering. Today every consumer reinvents it.
2. Tier-locked fields in the DSL surface read as part of the form, not as a separate concern bolted on top — operators see the *full* set of capabilities and what they'd unlock by upgrading, which is product-shaped feedback (see Herald's Dashboard plan, where this drives the per-step picker).
3. The cost is small. New attribute, one render-time check, one new context variable. No grammar surgery; `tier=...` slots in next to `tt=...` and `when=...` as just another control parameter.

Open questions:

1. **Granularity.** Do we honour `tier` only on controls, or also on containers (whole panel disabled), top-level form (whole form gated), or `listManager` add-button (can't add new entries above the tier)? Container-level is the natural extension; list-manager-level is the trickier case worth considering.
2. **Multiple tier dimensions.** Today the example assumes a single edition axis. Some products have orthogonal axes (free vs paid × on-prem vs cloud). The DSL could either restrict `tier` to a single string or accept a comma-separated set. Restrict to single until a consumer asks for more.
3. **How the renderer surfaces "would unlock."** A grey-with-tooltip shape is the simplest. A dedicated `<aside>` panel listing all tier-locked fields with their pitches is what some product UIs prefer. The DSL stays out of this — consumer's choice via the rendered output.

Cost: small. New ParamSpec entry, one renderer hook, one context variable, tests for the disabled-vs-hidden modes. Trust story is unchanged. AST versioning bump if the consumer wants to round-trip the attribute through scaffolds.

### API-sourced option lists (adjacent)

Today every option source in a `select` / `combo` / `listManager` is a literal array (`["log", "ndjson", "csv"]`) or an alias to one. Consumers who want options that come from a server endpoint at form-render time work around it via `compute={@function}` — but `compute` evaluates against the form's data, not against a fetch.

The cleaner shape lands once **Form-state lifecycle hooks** (above) ship: an `onLoad` hook that runs before the form renders, returns a value, and binds it to a state variable that an option source then reads. That gives the DSL one hook for "fill in things that come from outside" rather than splitting fetch concerns from compute concerns.

Until lifecycle hooks land, the workaround is the consumer pre-renders the option list into the `.mmpform` text server-side. That's not pretty but it works for the dashboard's needs today.

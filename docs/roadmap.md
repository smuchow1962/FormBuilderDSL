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

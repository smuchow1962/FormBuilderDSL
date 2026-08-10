# Design philosophy

The package follows two design rules: **CUPID** (a vocabulary for how the code feels to work with) and **DRY** (a rule about not duplicating knowledge). This document names where each shows up so a contributor reading the source can recognise the pattern.

## CUPID

**[CUPID](https://cupid.dev/)** is a set of properties Dan North proposed as an alternative to SOLID: code that is **C**omposable, follows the **U**nix philosophy, is **P**redictable, **I**diomatic, and **D**omain-based. The five properties are guidelines about how software *feels* to work with rather than rules about its structure.

Where each property shows up here:

- **Composable.** The control vocabulary is data, not code. A consumer adds a `json` control type with one entry in their spec; the parser does not gain a code path. Subpath imports let consumers pull just `interpolate` or `evaluateWhen` without loading the whole package.
- **Unix philosophy.** Each file in `src/parser/` does one thing and does it well. The tokenizer just tokenizes. The parser just parses. `validate.js` validates. `layout-check.js` checks layout. `rewrite-fragments.js` rewrites text. None of them know what the others do beyond the shape they hand each other.
- **Predictable.** Every public method that can fail returns a `TupleResponse`. There is exactly one branching point on the consumer side (`error === 0`) and one stable place to look for both data and messages.
- **Idiomatic.** ES modules, JSDoc with `@throws` annotations, modern JavaScript (`Object.freeze`, `??`, optional chaining, destructuring). Tests run on Jest, loading the package as native ES modules with no transpile step. The codebase reads as plain JavaScript with no framework or build-step magic between source and runtime.
- **Domain-based.** The vocabulary in the AST and the source code matches the form-building domain: `control`, `container`, `panel`, `repeater`, `listManager`, `tooltipRef`, `optionsSource`, `binding`. A reader who understands forms understands the names.

## DRY

**DRY** (Don't Repeat Yourself) is the rule about not duplicating *knowledge*, not about avoiding similar-looking code. Where the codebase deliberately avoids duplication:

- **The control-spec registry** is the single source of truth for what each control type accepts. If `validateControlSpec` accepts a width-shape, the parser honours it. If a shape is added to `defaultControlSpec`, it is automatically valid input. There is no parallel "what control types exist" list anywhere else in the source.
- **`CONTAINER_PARAM_HANDLERS`** is the single source of truth for what container parameters exist. Adding `addLabel="..."` was one table entry. The dispatcher in `parseContainerParams` does not know any specific keys; it looks them up.
- **`placeholder.resolvePlaceholder`** is the shared core for `interpolate` and `text-fragment.fragmentToText`. Both surfaces share one regex shape, one trust story, one set of strict-mode error messages, and one lenient fallback.
- **`literal-types.defaultMatchesType`** is the shared validator for `__properties` defaults and inline `init=` literals. One known-types vocabulary, one error message shape.
- **`string-literal.readQuotedString` / `writeQuotedString`** are symmetric. The reader rejects bytes the writer cannot emit; the writer refuses bytes the reader cannot accept. Round-trip is honest by construction.
- **`TupleResponse._normalizeMessages`** centralises the string / array / Error / object normalisation. Every caller gets the same coercion rules.
- **`parseBindingPath` and `collectLabel`** live in `binding-helpers.js`, not duplicated in each grammar file that uses them.
- **`parseBool`** in `parse-containers.js` collapses the identical `true`/`false` coercion that the `search` and `draggable` parameters used.
- **`SUB_CONTAINER_KINDS`** in `render-preview.js` is one set of node kinds that render as nested headers; the row-rendering branch and the recursion branch both consult it.

Where the codebase deliberately *keeps* similar-looking code:

- The per-parameter coercion arms in `parseTypedValue` (one branch per `paramSpec.type`) read as duplication but each arm encodes a different rule. Combining them would force a generic validator that is harder to follow than the explicit switch.
- The error-throwing patterns at each grammar checkpoint (`throw new ParseError(...)`) repeat by design. A wrapper would add indirection without removing knowledge.

The general rule: extract a helper when the same *decision* lives in two places. Do not extract a helper just because two snippets look alike.

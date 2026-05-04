# `when=` expressions: trust and evaluation

FormBuilderDSL compiles `when="..."` on controls and containers into a small boolean AST and evaluates it at render time with **`evaluateWhen(source, data, options?)`**.

## Threat model

- **Trusted data:** Treat `data` as a plain object you own (for example Vue `reactive` state for a sink config screen). Do not pass unsanitized attacker-controlled objects into `evaluateWhen` if those objects can carry unexpected property names.
- **Not a sandbox:** The language is intentionally tiny (comparisons, `&&`, `||`, `!`, `in [...]`, and dotted paths). It is not a general expression sandbox.

## Hardening (current behavior)

1. **Path segments** `__proto__`, `prototype`, and `constructor` are never read from `data`. They resolve as `undefined`, so comparisons involving them evaluate false rather than walking the prototype chain.
2. **Property reads** use `Object.prototype.hasOwnProperty`: inherited enumerable properties on `Object.prototype` (or the prototype chain) are **not** visible to `when` paths. Only **own** enumerable properties on each step are read.
3. **Size caps:** `parseWhen` and `evaluateWhen` accept optional `maxSourceLength` (default 8192) and `maxTokens` (default 2048) to bound lexer work on hostile strings.
4. **Read-only forbidden list:** `FORBIDDEN_PATH_SEGMENTS` is exported as a Proxy over the internal Set. Calling `add`, `delete`, or `clear` on it throws `TypeError`. `has`, `size`, and iteration work normally.

## Parse-time map lookups (related guarantee)

The trust story above covers the read-time `when=` and `{path}` paths. The same rule applies parse-time: every map keyed by a user-supplied identifier (`namedText`, `namedObjects`, `tooltips`, `colors`, `optionSources`, plus the dispatch tables in `parse-controls.js` and `parse-containers.js`) is either built with `Object.create(null)` or read through `safeGet(map, key)`. The combination is:

- **`assertSafeObjectKey(name, role, loc)`** at every parse-time write site. A reserved name in source raises `INVALID_PARAM` with the offending token's line and column.
- **`Object.create(null)`** for every model-owned dictionary. A missed write screen still can't pollute the prototype slot.
- **`safeGet(map, key)`** at every read-side bracket access on a model map or dispatch table. A reserved key returns `undefined` regardless of the map's prototype.

Three lines of defence, one rule. The same `RESERVED_INTERNAL` Set drives all three; the same `safe-keys.js` helper file holds the implementations. A consumer building a custom control spec inherits all three guarantees automatically.

## Function-arm safety (`{@name}` placeholders)

`interpolate` and `renderFragments` accept `{@name}` placeholders that look up `name` in a caller-supplied function registry. The same trust posture applies on this arm:

- **`hasOwnProperty` check.** `placeholder.resolvePlaceholder` reads the function via `Object.prototype.hasOwnProperty.call(functions, name)` rather than `functions[name]`. Without the check, `{@constructor}` or `{@toString}` on an empty registry (`{}`) would resolve to the corresponding `Object.prototype` member and call it as if the consumer had registered it.
- **Reserved-segment screen, parse-time.** `interpolate` and `parseDecorated` both refuse `{@__proto__}`, `{@constructor}`, and `{@prototype}` at parse time with `ParseError(PARSE_ERROR)` regardless of what is in the registry. The pre-scan runs before any substitution begins; lenient and strict mode both throw.
- **Symmetry with the data arm.** A reserved-segment placeholder fires the same parse-time error whether it is a data path (`{__proto__}`) or a function reference (`{@constructor}`). One rule across both surfaces.

Other `Object.prototype` member names (`toString`, `hasOwnProperty`, `valueOf`, `isPrototypeOf`) are not in the reserved set. They reach the `hasOwnProperty` check at render time: lenient mode renders the literal `{@name}` placeholder, strict mode throws the documented "no function registered" error. The runtime guard catches them either way; the parse-time fail-fast applies only to the three names that name a prototype-walking attack.

## Semantics

A few details that aren't obvious from the grammar.

### String literals support escape sequences

Quoted strings inside a `when=` expression understand the same escape sequences as the outer DSL tokenizer: `\\`, `\'`, `\"`, `\n`, `\t`. Any other backslash sequence passes the next character through literally. So `when="status == 'O\'Brien'"` works.

### Equality against missing fields

`==` and `!=` use strict JavaScript comparison after path resolution. A path that doesn't resolve returns `undefined`, which means:

- `when="missingField == 'x'"` evaluates to **false**.
- `when="missingField != 'x'"` evaluates to **true**.

This is consistent with `===` / `!==` semantics: `undefined === 'x'` is false, and `undefined !== 'x'` is true. If you want both sides to fail when the field hasn't loaded yet, gate on the field's existence first (e.g. `field && field == 'x'`).

### `in` uses SameValueZero on parsed literals

`x in [1, "1"]` walks the parsed list looking for a strict-equal match (the same equality `Array.includes` uses). The list's literals come from the parser, so `1` is a number and `"1"` is a string. If `data.x` is the number `1`, only the first matches. If it's the string `"1"`, only the second matches. Form data that arrives from JSON keeps its original types; form data that comes back from an HTML form is usually a string. Pick the literal type that matches the source the data flows in from.

Forward-looking notes about possible language additions live in [`docs/roadmap.md`](roadmap.md), not in this trust document. This file describes the trust contract today's grammar offers.

## Recommended use

- Use **`evaluateWhen`** only in **authenticated admin** or **local tooling** contexts where the DSL file is trusted.
- For untrusted DSL text, keep caps tight and validate file size before parse.

## Performance posture

A reader thinking about performance under load should know that the package re-walks the AST on every invocation that takes one. There is no caching, no memoization, no `processFromAst(ast)` shortcut. The choice is deliberate: a cache layer makes the consumer reason about cache invalidation, freshness, and whether a mutation between calls will be reflected. Re-walking on every call removes that whole class of bug. The cost is sub-millisecond on realistic forms; the simplicity is the win.

`evaluateWhen` follows the same rule. Each call re-tokenizes the source and re-walks the resulting AST. A consumer rendering a form whose visibility depends on a `when=` expression that runs on every keystroke caches the AST themselves by holding `parseWhen(source)` once and feeding the result through `evaluateAst(ast, data)` — the package's documented escape hatch from the no-caching rule.

See `docs/architecture-no-ast-caching.md` for the package-wide rule.

## API

### One-shot evaluation

```js
import {
    evaluateWhen,
    FORBIDDEN_PATH_SEGMENTS,
    DEFAULT_MAX_WHEN_SOURCE_LENGTH
} from '@mmpworks/formbuilder-dsl';

evaluateWhen('flags.enabled == true', flags, { maxSourceLength: 512 });
```

### Cache-the-parse pattern

For a form whose visibility re-evaluates on every keystroke, parse once at form-load time and feed the AST back per render:

```js
import { parseWhen, evaluateAst } from '@mmpworks/formbuilder-dsl';

// At form-load:
const visibilityAst = parseWhen('flags.enabled == true');

// On every render:
const visible = evaluateAst(visibilityAst, currentData);
```

`evaluateAst` accepts the typed `WhenAst | null` shape — `null` evaluates to `true` (no `when=` means always-visible). The trust model is identical to `evaluateWhen`: same `resolveSafePath`, same own-property rule, same reserved-segment screen via the parse stage that already happened.

See `src/expression.js` for defaults and `tests/expression-trust.test.js` for regression coverage.

# Security review: @mmpworks/formbuilder-dsl

A consolidated security read of the package: what the attack
surface looks like, what the code defends against today, what the
trust boundaries are, and where a consumer's deployment shape
matters more than the package's own posture.

> Companion docs:
> [expression-trust.md](expression-trust.md) for the full `when=`
> trust model;
> [architecture.md](architecture.md) for the AST + module shape.
> This doc summarises the package-wide security posture and points
> at the source files that enforce each rule.

---

## 1. Trust model in one paragraph

The parser turns trusted-or-untrusted DSL **text** into a plain
data **AST**. The AST contains no executable code, no callbacks,
no closures — just strings, numbers, booleans, arrays, and plain
objects. Rendering happens elsewhere, against trusted host data.
The DSL text can come from anywhere; the parser bounds the work
it does on hostile input and never lets a parsed identifier
walk the JavaScript prototype chain. `when=` evaluation expects
**trusted host data** (typically an admin UI's reactive object).
Pointing `evaluateWhen` at unsanitised attacker-controlled
objects with arbitrary property names is the consumer's call to
make.

---

## 2. Threat model

### 2.1 Inputs by trust tier

| Input | Trust tier | Where it enters |
|---|---|---|
| DSL source text | **Untrusted-by-default** | `TextFormBuilder({ schemaText })` |
| Control spec object | Trusted (consumer-supplied) | `TextFormBuilder({ controlSpec })` / `registerControl` |
| Host data object | Trusted | `evaluateWhen(source, data)` / `interpolate(text, data, fns)` |
| Function registry | Trusted | `interpolate(text, data, functions)` / `renderFragments(... { functions })` |
| `__properties` block | Trusted | Embedded in the DSL source |

The DSL text is the one tier where the package assumes the
attacker. Every other input is explicitly handed in by the
consumer. A consumer who hands in untrusted host data has a
deployment problem the package can't solve — but the trust
boundaries below describe exactly how far an untrusted DSL can
reach.

### 2.2 What the package defends against

| Threat | Defence | Source |
|---|---|---|
| Prototype pollution via parsed identifier | `assertSafeObjectKey` write screen, `Object.create(null)` model maps, `safeGet` read screen, `resolveSafePath` walk screen | `src/safe-keys.js` |
| `__proto__` / `prototype` / `constructor` reached through `{path}` | Reserved-segment list shared across `{path}`, `{@fn}`, `when=`, decorated `{binding}` | `src/safe-keys.js`, `src/expression.js`, `src/interpolate.js`, `src/placeholder.js` |
| Runaway lexer on large input | 1 MB source cap (configurable), 100 000 logical-line cap, 20-char numeric literal cap, integer precision check | `src/parser/run-parse.js`, `src/tokenizer.js` |
| Quadratic / exponential parser regex | Every regex is anchored with bounded character classes; no nested quantifiers; no back-references | `src/tokenizer.js`, `src/expression.js`, `src/interpolate.js` |
| Unbounded `when=` expression | 8 KB source cap + 2048 token cap (both configurable per call) | `src/expression.js` |
| Container nesting beyond a known depth | `MAX_NESTING_DEPTH` (16, configurable) | `src/parser/parse-containers.js` |
| Bare control bytes round-tripping silently through string literals | Reader rejects C0 / DEL / bare CR; writer raises `TypeError` on the same bytes | `src/string-literal.js` |
| Filesystem path leaked through `INTERNAL_ERROR` | V8 stack frame paths scrubbed to basename | `src/parser/run-parse.js` |
| `Object.prototype` member reached via `{@fn}` lookup | `Object.prototype.hasOwnProperty.call(functions, name)` | `src/placeholder.js` |
| Reserved control type registered into a custom spec | `registerControl` rejects `__proto__` / `prototype` / `constructor` | `src/text-form-builder.js` |
| Frozen default spec mutated by `registerControl` | Defensive shallow copy when the live spec is the frozen default or any frozen object | `src/text-form-builder.js` |
| Caller's exception bubbling past the response envelope | Every public method wraps thrown values into `ERR.INTERNAL_ERROR` | `src/parser/run-parse.js`, `src/text-form-builder.js` |

### 2.3 What the package does NOT defend against

| Threat | Why not |
|---|---|
| Malicious renderer | The package emits a plain AST. The renderer decides what to do with each node. A renderer that injects unsanitised binding values into HTML is the renderer's bug. |
| Malicious host data passed to `evaluateWhen` / `interpolate` | The trust contract names the host data as trusted. A consumer who points either function at attacker-controlled data needs to first sanitise the keys against a known schema. |
| Malicious function registry passed to `{@fn}` resolver | The registered functions run as written. A function that wipes the user's data when called is not a parser concern. |
| DoS via legitimate but expensive forms | The caps catch hostile inputs, not honest large forms. A 100k-control form parses fine and is bounded; a renderer trying to mount that as one DOM tree is its own conversation. |
| Cross-site scripting in the viewer | The viewer renders through Vue's `h()` helpers, which escape text by default. `innerHTML` appears once in `viewer/render-vue.js` and only for clearing (`rootEl.innerHTML = ''`). A regression test (`tests/regression-r27.test.js`) explicitly forbids the old "Vue render failed" innerHTML path from coming back. |

---

## 3. Defence walkthrough by attack class

### 3.1 Prototype pollution

JavaScript's classic foot-gun: a parsed identifier `__proto__`
landed as an object key reaches the prototype slot via the
literal-shorthand setter, and every plain object in the process
inherits the polluted member. The package puts the rule in one
file (`src/safe-keys.js`) and applies it three ways.

**Write side.** Every parser site that creates an object key
from a parsed identifier calls `assertSafeObjectKey(name, role,
loc)`. A reserved name in source raises `INVALID_PARAM` with
the offending token's line and column:

```
'__proto__' is a reserved JavaScript object key and cannot be used as a binding name
```

**Walk side.** `resolveSafePath(data, path)` refuses to follow
any segment in `RESERVED_INTERNAL` and uses
`Object.prototype.hasOwnProperty.call(cur, seg)` on each step,
so even an attacker-controlled host object cannot reach an
inherited member through a `{path}` placeholder, a decorated
`{binding}` fragment, or a `when=` path.

**Read side.** `safeGet(map, key)` does the own-property check
and skips reserved names regardless of the map's prototype. The
combination is belt-and-suspenders: the map can't carry an
inherited entry (null prototype), the parser refuses to write a
reserved name, and any read goes through one own-property
check.

The exported `RESERVED_OBJECT_KEYS` view is a `Proxy` that
throws on `add` / `delete` / `clear`. A downstream consumer
cannot widen or narrow the rule at runtime by mutating the
exported Set. Reading and iteration work normally; mutation
does not.

### 3.2 Regex denial of service (ReDoS)

Every regex in the package is bounded:

| Regex | Shape | Bounded by |
|---|---|---|
| `IDENT_RX` (`tokenizer.js`) | `^[A-Za-z_][A-Za-z0-9_]*` | Greedy, anchored, no nested quantifiers. |
| `DATE_RX` (`tokenizer.js`) | `^(?<y>\d{4})-(?<m>\d{2})-(?<d>\d{2})` | Fixed-length groups. |
| `RX.ident` (`expression.js`) | `^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*` | Outer Kleene over a bounded segment; non-overlapping alternation. |
| `RX.num` (`expression.js`) | `^-?\d+(?:\.(?<frac>\d+))?` | One greedy digit run + one optional bounded run. |
| `PLACEHOLDER` (`interpolate.js`) | `\{(?<at>@?)(?<name>[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}` | Same shape as `RX.ident` wrapped in literal braces. |
| `BARE_NAMED_TEXT_RX` (`parser/constants.js`) | Bounded named-capture form for ``name = `…` `` | Fixed delimiter, single greedy run. |

No regex carries a back-reference or nested quantifier. Inputs
stay bounded by `DEFAULT_MAX_INPUT_LENGTH` (1 MB) at the source
level and `DEFAULT_MAX_WHEN_SOURCE_LENGTH` (8 KB) at the
expression level.

### 3.3 Memory exhaustion

The 1 MB DSL cap (configurable per builder) bounds raw bytes;
the 100 000 logical-line cap (`MAX_LOGICAL_LINES` in
`tokenizer.js`) bounds the resulting structure size next to it.
A 1 MB blob of `[\n][\n][\n]…` (mostly-empty lines) cannot build
a 200k-entry placeholder array — the second cap catches the
attack the first cap doesn't. Both caps fire as `LEX_ERROR`
with focused messages.

The 16-deep nesting cap (`MAX_NESTING_DEPTH`) bounds container
recursion. A consumer hosting machine-generated forms can raise
it; a consumer hosting hostile input can drop it.

### 3.4 String-literal round-trip

A bare C0 control byte, DEL, or a bare CR has no DSL escape.
The reader rejects them at parse time:

```
String literal contains a bare control character (0x07); the grammar has no escape for it. Recognised escapes inside strings: \\ \' \" \n \t.
```

The writer (`writeQuotedString`) raises `TypeError` for the same
bytes. The reader's parse-time rejection means a parsed value
never contains those bytes, and the writer's `TypeError` only
fires for a consumer hand-building a properties dictionary with
bytes the grammar cannot represent. Round-trip is honest by
construction.

The asymmetry that matters: `\n` and `\t` *are* recognised, so a
multi-line string literal value works fine through both
surfaces. The refused bytes are the ones with no escape syntax.

### 3.5 Numeric overflow

`parseInt('9007199254740993', 10)` returns
`9007199254740992` (off by one, silent). A control width or a
layout sum carrying that rounded value would render the wrong
form, and the displayed error would name the rounded value, not
the typo. The tokenizer refuses any integer literal past
`Number.MAX_SAFE_INTEGER`:

```
Integer literal '9007199254740993' exceeds Number.MAX_SAFE_INTEGER (9007199254740991); values beyond this lose precision when parsed
```

The 20-character literal cap is the upstream guard before this
check runs. Together they convert "infinity contaminating a
layout sum" into "literal too long" / "exceeds MAX_SAFE_INTEGER"
parse errors.

### 3.6 Filesystem path leak

When the parser throws something other than a `ParseError`, the
response envelope picks up `ERR.INTERNAL_ERROR` with the error
name, message, and the **first** stack frame. V8 frames embed
the absolute file URL:

```
at parseControlDecl (file:///E:/dev/herald/.../parse-controls.js:135:5)
```

A response surfaced to an untrusted caller would otherwise leak
the host filesystem layout. `scrubStackPath` (in
`src/parser/run-parse.js`) replaces the URL with the basename:

```
at parseControlDecl (parse-controls.js:135:5)
```

Line and column survive. The scrub is V8-shaped (the package
targets Node 18+ per `package.json:engines`); SpiderMonkey or
JavaScriptCore stack formats differ, so the scrub refuses to
touch lines that don't look like V8 frames. A file URL embedded
in a non-V8 host would land unscrubbed — which is a known
limitation, not a silent bypass.

### 3.7 Function registry poisoning

`{@fn}` placeholders look up `fn` in a caller-supplied registry.
A naive `functions[name]` would resolve `{@constructor}` or
`{@toString}` to `Object.prototype` members on an empty
registry. `placeholder.resolvePlaceholder` reads via
`Object.prototype.hasOwnProperty.call(functions, name)` so the
registry is always own-property only.

`interpolate` and `parseDecorated` additionally pre-scan for
reserved-segment names (`{@__proto__}`, `{@constructor}`,
`{@prototype}`) and raise `ParseError(PARSE_ERROR)` at parse
time, regardless of strict / lenient mode. The two surfaces
agree: a reserved-segment placeholder is a typo or an attack
and never reaches the substitution loop.

### 3.8 Spec corruption via `registerControl`

Two related risks. First, a consumer registering a reserved name
(`__proto__`) as a control type — the `controlSpec[name] =
spec` assignment would otherwise reach `Object.prototype`'s
`__proto__` setter (bracket assignment does not bypass it).
`TextFormBuilder.registerControl` checks `isReservedObjectKey`
and rejects the registration with `ERR.INVALID_SPEC` before
touching the live spec.

Second, the live spec being the frozen `defaultControlSpec` (or
any frozen object the consumer handed in). The bare assignment
would throw under strict mode (ESM modules run in strict mode).
The method makes a defensive shallow copy of the live spec
before writing the new entry, then validates the **candidate**
spec (the live spec plus the proposed new entry). A malformed
spec leaves `controlSpec` untouched and surfaces the error at
the call site instead of at the next `parse()`.

A future depth dependency to watch: today the `__common` block
has one nested map (`params`). The shallow copy clones
`__common` but not its `params`. A future addition to
`__common` carrying nested mutable state (per-control hooks,
sub-fields) would need to recurse one more level — otherwise
`registerControl` on a frozen default would mutate state
shared with the unmutated default. The source carries an
explicit comment naming this dependency.

---

## 4. Viewer-specific surface

The npm package itself is just the parser. The bundled viewer
(`viewer/`) is a reference renderer for local development and
is **not** shipped in the npm tarball. Its security posture
matters when a consumer self-hosts it.

### 4.1 Vue rendering escapes by default

`render-vue.js` builds the form with `h()` calls that take
strings as text content. Vue's `h()` function escapes text-node
content. The audit grep:

| Pattern | Hits | Use |
|---|---:|---|
| `innerHTML` | 1 | `rootEl.innerHTML = ''` (clearing the mount). |
| `outerHTML` | 0 | — |
| `v-html` | 0 | — |
| `insertAdjacentHTML` | 0 | — |
| `document.write` | 0 | — |
| `eval(` | 0 | — |
| `new Function` | 0 | — |

`tests/regression-r27.test.js` explicitly asserts that the
historical `els.vueMount.innerHTML = '<pre>Vue render failed…'`
injection is gone and stays gone.

The diagnostic banner painted under the `?debug=1` flag uses
`textContent` for every dynamic value (Vue version, Vuetify
version, component count). The error pre-tag uses `textContent`
on the message. No raw HTML reaches the DOM from user input.

### 4.2 Share-link decode is data-only

`viewer.js` carries a Share button that gzip-compresses the
source text and base64-url-encodes it into the URL hash:

```
${origin}${pathname}#share=<base64-gzip-source>
```

On load, the hash is decompressed and the resulting text is
passed to `setEditorText` (Ace's `setValue`). The decoded text
is **never** evaluated, never injected into HTML, never passed
to `new Function`. A malicious share link can only:

- Pre-fill the editor with a parse error the user sees inline.
- Pre-fill the editor with a form definition that, when the
  user clicks Process, exercises the parser.

The parser's input caps and trust posture cover the second
case. The first is a UX consideration, not a security one.

If the decode itself fails (corrupt base64, gzip stream error),
the failure surfaces through `setStatus(...'err')` and the
viewer falls through to the bundled sample. No partial-decoded
state reaches the editor.

### 4.3 `?show=1` flag and the sinks bridge

The URL flag `?show=1` reveals the sinks bridge — a private
module under `viewer/private/sinks-bridge.js` that wires the
viewer's open / save / status surfaces to internal sink
tooling. The import is dynamic (`import('./private/sinks-
bridge.js')`) and only fires when the flag is set. Without the
flag, the bridge module never reaches the network. With the
flag, the bridge runs only as much code as the consumer's
`viewer/private/` directory ships; if the directory is absent
(common on a public deploy), the import rejects and the viewer
runs without the bridge.

The flag is read once at module load. A page refresh is needed
to flip it. That's the right shape — the page-shell decides
what to show before any rendering happens, not after.

### 4.4 Form-history snapshots

`form-history.js` deep-clones state via `structuredClone` and
strips known internal markers (`__pk` from the parser's named-
object metadata) before stashing the snapshot. The clone runs
on every `snapshot()` and on every `undo()` / `redo()` /
`seekToSeed()` return so the history can never hand the caller
a reference into its own ring buffer.

The clone strategy uses markers for `File` / `Blob` /
`FileList` so two distinct file picks dedup as different. The
markers carry a name, size, and a deterministic hash of the
content; a malicious file pick cannot poison the dedup key
because the hash depends on the file's bytes, not on its
metadata.

### 4.5 Globals exposed by the viewer

| Global | Set by | Purpose |
|---|---|---|
| `globalThis.__formBuilderDefaultSpec` | `viewer.js` | Hands the default spec to the Ace mode loaded earlier |
| `globalThis.__FB_VIEWER_DEBUG__` | `viewer.js` | URL `?debug=1` toggle for `render-vue.js` diagnostics |
| `window.formFunctions` | `default-functions.js` | `{@fn}` registry the renderer reads |

These are documented module-load coupling channels, not part of
the package's public API. A future refactor that threads the
values through explicit imports would tighten the surface;
the current shape is acceptable for a viewer page.

---

## 5. Build and supply chain

The package's runtime dependencies are zero. Lockfile aside,
`devDependencies` are limited to:

| Package | Role |
|---|---|
| `@eslint/js` | Lint rules |
| `eslint` | Lint runner |
| `c8` | Coverage measurement |

No test framework, no transform pipeline, no build step that
would inject code into `src/`. The npm `prepack` hook runs
`scripts/sync-version.mjs`, which reads `package.json:version`
and writes it into `src/version-generated.js`. The script is
small, has no network access, and writes a single literal
file.

The published package's `files` allow-list is `["src",
"types"]`. Tests, the viewer, the editor bundle, and the
`tools/` directory are excluded from the tarball. The
`exports` map narrows the surface further: only the named
subpath imports resolve. A consumer who tries to import a
helper from a deeper path (e.g.
`@mmpworks/formbuilder-dsl/src/parser/parse-controls.js`)
hits Node's package-exports rejection.

`tools/npm-test.py` is a Python harness that builds an npm pack
locally and runs a smoke test against the resulting tarball.
It is not shipped with the package.

---

## 6. Operational guidance for consumers

### 6.1 Hostile DSL text

Pin caps tighter than the defaults:

```js
const builder = new TextFormBuilder({
    schemaText,
    maxInputLength:  64 * 1024,   // 64 KB instead of 1 MB
    maxNestingDepth: 8            // 8 instead of 16
});
```

A consumer hosting hostile text should also pin the `when=`
caps when calling `evaluateWhen`:

```js
evaluateWhen(source, data, {
    maxSourceLength: 512,
    maxTokens:       128
});
```

### 6.2 Untrusted host data

`evaluateWhen` and `interpolate` expect trusted host data. A
consumer who must point either function at attacker-controlled
data should first project the data through a known schema (a
`zod` parse, an `ajv` validator, a hand-rolled allow-list)
so the keys are bounded.

The package's reserved-segment screen catches the worst case
(a `{__proto__}` or `{constructor}` placeholder), but it does
not validate the *shape* of the data — that's the consumer's
contract.

### 6.3 Renderer responsibilities

The AST emitted by the parser is plain data. A renderer that
injects a binding's value into HTML without escaping is the
renderer's bug, not the parser's. The bundled `render-vue.js`
goes through `h()` for every text node and uses `textContent`
for every diagnostic — a custom renderer should hold itself to
the same rule.

### 6.4 INTERNAL_ERROR handling

A response with `error === ERR.INTERNAL_ERROR` is a parser bug
the consumer should report. The response carries the error
name, message, and a scrubbed first stack frame — that's
enough to file an actionable issue. The consumer should never
see this in steady state; if it appears, treat it as a real
defect, not a transient glitch.

---

## 7. Open items

None of these are blocking. They are the security-relevant items
the audit would carry forward into next-cycle review.

### 7.1 Non-V8 stack-frame scrub

The `INTERNAL_ERROR` path scrub is V8-shaped. SpiderMonkey
(`fn@file:line:col`) and JavaScriptCore stack formats differ.
The package targets Node 18+ per `package.json:engines`, and
the README's install section names V8 explicitly, so this is
not a defect. A future port to a non-V8 host would need a
second branch in `scrubStackPath` and a second test fixture.

Complexity: low (one helper + one regression test).

### 7.2 Documented "defended bytes" set

`string-literal.js` rejects C0 / DEL / bare CR. The list lives
in code; the user-facing error message names the offending byte
in hex. An explicit table in the user-guide ("which bytes are
refused, and how to encode them") would close a small
education gap.

Complexity: trivial (one table in the user-guide).

### 7.3 Globals lifecycle in the viewer

The viewer sets three module-load globals. If a future host
embeds the viewer twice on the same page (multi-tenant editor,
side-by-side diff view), the globals would collide. A short
note in `viewer/README.md` naming the globals as "single
viewer per page" boundaries would prevent the surprise.

Complexity: trivial.

### 7.4 Audit cadence

Every public release should run the canned grep set:

```bash
# Disallowed unsafe patterns in the source tree
grep -RnE 'innerHTML|outerHTML|v-html|insertAdjacent|document\.write|eval\(|new Function|setAttribute\(.{1,40}href' src/ viewer/ tests/
```

Today's hits: one `innerHTML` (clearing) plus a few
test-fixture references that explicitly assert the path is
forbidden. Any new hit on a release-time grep is a release
blocker.

---

## 8. Bottom line

The package's security posture is built around three rules:

1. **Plain data in, plain data out.** The AST is data. The
   parser does not synthesise code.
2. **Reserved names are blocked at every site.** One Set, three
   helpers, every read and write goes through one of them.
3. **Hostile input is bounded by layered caps.** Source,
   logical-line count, numeric literal, container depth,
   expression source, expression token count.

The shipping artefacts are aligned with the rules. The
viewer's renderer takes care to escape, the response envelope
catches every exception path, the round-trip story is honest,
and the test suite locks the boundaries in. A consumer
deploying the package follows the operational guidance above
and the trust contract holds.

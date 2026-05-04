# Using the library from code (CDN, ESM, TypeScript)

This page is for **programmers** who want to load **@mmpworks/formbuilder-dsl** in a browser, in Node, or in TypeScript without guessing. Examples use **short forms** you can copy; the *ideas* (CDN URL shape, import style, AST handling) are what matter.

---

## 1. Load from a CDN (browser, no bundler)

Public CDNs mirror the npm package. You usually import the **root** module as an **ES module**.

### jsDelivr (ESM)

Pin a **version** instead of `@latest` when you care about stable builds.

```html
<script type="module">
  import { TextFormBuilder, ERR } from 'https://cdn.jsdelivr.net/npm/@mmpworks/formbuilder-dsl@1.0.0/+esm';

  const schemaText = `columns: 10
[container({t})]
  - [textfield(10,{name})] Name`;

  const r = new TextFormBuilder({ schemaText }).parse();
  document.body.textContent =
    r.error === ERR.OK ? 'OK: root node is ' + r.payload.root.nodeKind : r.messages.join('\n');
</script>
```

Notes:

- **`+esm`** tells jsDelivr to wrap the package so browsers can `import` it.
- Replace **`1.1.0`** with the version you see on [npm](https://www.npmjs.com/package/@mmpworks/formbuilder-dsl). Pin a specific version when you want stable behaviour across deployments.

### unpkg (example pattern)

```html
<script type="module">
  import { TextFormBuilder, ERR } from 'https://unpkg.com/@mmpworks/formbuilder-dsl@1.0.0/src/index.js?module';
  // ... same as above
</script>
```

CDN details change over time; if one URL fails, try the other host or the exact file path shown on the npm “Files” tab for that version.

---

## 2. ESM in Node or a bundler (Vite, Webpack, etc.)

```js
import { TextFormBuilder, ERR, defaultControlSpec } from '@mmpworks/formbuilder-dsl';
import { evaluateWhen } from '@mmpworks/formbuilder-dsl/expression';
import { interpolate } from '@mmpworks/formbuilder-dsl/interpolate';
```

Your `package.json` should use `"type": "module"` **or** only load this package from `.mjs` / bundler context that treats imports as ESM.

---

## 3. TypeScript

1. Install: `npm install @mmpworks/formbuilder-dsl`
2. Import the same symbols; **types** ship in `types/index.d.ts` and are wired through the `exports` map.

```ts
import {
  TextFormBuilder,
  ERR,
  type TupleResponse,
  type FormModel
} from '@mmpworks/formbuilder-dsl';

const builder = new TextFormBuilder({ schemaText: 'columns: 10\n...' });
const result: TupleResponse<FormModel | null> = builder.parse();
```

**Strict `interpolate`** (fourth argument) for "fail loud" tooltips:

```ts
import { interpolate } from '@mmpworks/formbuilder-dsl/interpolate';

interpolate('Hello {name}', { name: 'Ada' }, {}, { strict: true });
```

**Empty-input return shapes.** The two text helpers return different
empty values on purpose. `parseDecorated` returns a fragment array,
so the empty case is `[]`. `interpolate` returns text, so the empty
case is the empty string `''`. Pick the right helper for what you
need to render.

```ts
import { parseDecorated } from '@mmpworks/formbuilder-dsl/text-fragment';
import { interpolate }    from '@mmpworks/formbuilder-dsl/interpolate';

parseDecorated('');         // returns [] (no fragments to render)
parseDecorated(null);       // returns [] (same)

interpolate('');            // returns '' (empty text in, empty text out)
interpolate(null);          // returns '' (same)
```

---

## 4. Three small forms that teach the “confusing bits”

Each block below is **complete schema text** plus **the mental model** in plain words.

### Example A. **Data paths** `{like.this}` vs **option lists** `#name`

**Idea:** Curly braces mean *“read/write this field on my data object.”* A name with **`#`** in front means *“use the option list declared earlier with that name.”*

```dsl
columns: 12

sizes = ["S", "M", "L"] -> {shirtSize}

[container({title})]
  - [select(6,#sizes,{shirtSize})] Shirt size
  - [textfield(6,{customer.name})] Customer name
```

- `{shirtSize}`: one string on your data object.
- `#sizes`: points at the `sizes = [...]` line, not at the data object directly.
- `{customer.name}`: nested path. Your renderer resolves it against a tree-shaped data object.

### Example B. **Function calls** `{@formatSomething}` (read-only / "display" style)

**Idea:** Bindings that start with **`@`** are **function names**, not folder paths. They are only allowed on controls that **do not write back** into the data object (for example **`display`**).

```dsl
columns: 20

[container({title})]
  - [display(20,{@formatUptime})] Server uptime
```

In your host app you **do not** put `formatUptime` on the data object. You pass a **function registry** when you evaluate tooltips or render fragments. See `interpolate(text, data, functions)` and your own display binding resolver. The AST stores the binding string (e.g. `'@formatUptime'`); **your code** calls the real function.

### Example C. **Named text**, **tooltips**, and **`when=`** (conditional blocks)

**Idea:** You can give a chunk of text a **name** and reuse it. **`tooltips = [...]`** defines help text keys. **`when=`** hides a whole container until an expression is true.

```dsl
columns: 20

intro = `Plain label with *bold* story`

tooltips = [
  "helpPort" = "TCP port must be 1..65535."
]

[container({title})]
  - [number(8,{port},min=1,max=65535,tt="helpPort")] Port number

  - [>container(when="showAdvanced == true")]
    - [textfield(12,{apiKey})] API key
```

- **`intro = \`...\``**: named text for reuse in labels (advanced; see language reference).
- **`tt="helpPort"`**: points into the `tooltips` map. The parser checks that the key exists.
- **`when="showAdvanced == true"`**: raw boolean expression stored on the node. The `when=` grammar reads bare path identifiers (no `{...}` braces here — those are the `{path}` data-binding shape used in labels and option-source lists, not in the expression DSL). At render time you run `evaluateWhen(node.when, data)` (from `@mmpworks/formbuilder-dsl/expression`) with your real data object where `showAdvanced` is a boolean. For a hot path (re-rendering on every keystroke), call `parseWhen(source)` once and feed the resulting AST through `evaluateAst(ast, data)` per render.

---

## 5. Checklist before you ship

1. **`parse()` error check.** Always branch on `result.error === ERR.OK` before using `result.payload`.
2. **Layout.** Row control widths must not add up to more than `columns:` (or you get `INVALID_LAYOUT`).
3. **Refs.** Every `#optionSource` name on a control must match a top-level `name = ...` declaration.
4. **Unicode preview.** If you use `renderFormPreview` / `render-preview`, know that box-drawing characters can look odd in some Windows terminals; use a UTF-8-friendly console or HTML.

---

## Where to go next

- [user-guide.md](user-guide.md): how to *think* like an author.
- [architecture.md](architecture.md): pipeline picture and AST fields.
- [project-baseline.md](project-baseline.md): every control and parameter.

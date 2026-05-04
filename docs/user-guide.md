# FormBuilder DSL - User Guide

This guide is for **authors** who write `.mmpform` documents: the text that describes configuration forms (layout, bindings, option lists, conditionals). All project documentation is Markdown (`.md`).

## Goal: a form as an AST (Abstract Syntax Tree/DOM)

When you write a form in this language, the parser’s job is to turn your text into an **AST** (like a **DOM**).

An AST is a **structured tree of objects** that represents your document’s meaning - not the original characters, but the logical pieces: containers, rows, controls, widths, bindings, parameters, and metadata (option sources, tooltips, colors). Each node has a predictable shape so **renderers, validators, and tools** can walk the tree without re-parsing the raw DSL.

- **Why “abstract”?** It drops punctuation and layout details that only matter to the parser; it keeps what the rest of the system needs.
- **Why a tree?** Forms nest (containers → rows → controls; repeaters → inner rows). A tree matches that structure.
- **Contract:** The AST is the boundary between the parser and everything else (HTML divs, React, Vue UI, headless validation, another framework). Its fields and versioning are described in [architecture.md](architecture.md) (see section 4 - AST shape).

So “programming” a form here means: **writing DSL text that parses cleanly into that AST**, then handing the AST to your app’s renderer and data layer.

## What you author

1. **Top level** - `columns`, option sources (`name = [...] -> {binding}` or dynamic `{path}`), optional `tooltips`, `colors`, and related blocks.
2. **Root container** - `[container(...)]` or `[>container(...)]` (collapsible), then indented **rows** (`-` / `|`).
3. **Controls** - `[type(width, #options, {binding}, key=value, ...)]` label text to end of line.

Parameter order inside `(...)` does not matter; the parser uses **markers** (bare number = width, `#name` = option source, `{path}` = binding, `key=value` = typed params).

## Minimal example

Comments: **line-leading** `#` (after indent), or **trailing** ` # note` - there must be a space before `#`, and `#` must be followed by a space or end-of-line so `#levels` option refs are never eaten. See [architecture.md](architecture.md) (comments).

```dsl
columns: 20  # grid; row widths sum ≤ this

levels = {levelsList}  # options from data.levelsList

[container({title},{description})]  # root; title + description bindings

  - [select(5,#levels,{logLevel})] Log Level  # dropdown → logLevel
  - [number(5,{port},min=1,max=65535)] Port  # TCP/UDP port range
```

After `parse()`, the consumer receives an AST whose `root` holds this structure; see [architecture.md](architecture.md) for the exact node types.

## Where the full language is specified

The **complete** syntax - repeaters, panels, decorators, `when=` expressions, function bindings `{@fn}`, every control family, and parsing rules - is documented in:

- **[project-baseline.md](project-baseline.md)** - language reference for authoring (sections mirror the grammar you use day to day).

For implementers extending the parser or mapping types:

- **[architecture.md](architecture.md)** - canonical AST shape reference: pipeline (tokenizer → parser → AST), control-spec registry, AST fields, errors, and design decisions.
- **[library-uses-in-code.md](library-uses-in-code.md)** - JS / TS examples for the public helpers (`interpolate`, `parseDecorated`, `evaluateWhen`).

## Two text helpers, two empty-input shapes

When you start wiring tooltips and decorated labels, two helpers do similar-sounding work:

- `parseDecorated(text)` parses decorated label text into an array of fragments. The empty case is `[]` (no fragments to render).
- `interpolate(text, data)` substitutes `{path}` and `{@fn}` placeholders in plain text. The empty case is `''` (empty text in, empty text out).

Pick the one that matches what you need to render. They sit on different subpaths and return different shapes on purpose.

## Editor support

Syntax highlighting for `.mmpform` lives under [`../editor/`](../editor/); see [editor/README.md](../editor/README.md).

## Samples

Working examples:

- [`../editor/samples/full-example.mmpform`](../editor/samples/full-example.mmpform)
- [`../editor/samples/sink-text-file.mmpform`](../editor/samples/sink-text-file.mmpform)

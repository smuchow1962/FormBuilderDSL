# MMPForm DSL - Editor Bundle

A TextMate / VS Code-style language bundle for `.mmpform` files. Provides syntax coloring, bracket matching, and comment toggling. No semantic checking - the live parser is a separate concern (LSP server, future).

## What's in the bundle

```
editor/
├── package.json                       # VS Code extension manifest
├── language-configuration.json        # comments, brackets, auto-closing
├── syntaxes/
│   └── mmpform.tmLanguage.json        # the grammar
└── samples/
    └── full-example.mmpform           # preview file
```

## Install in JetBrains (Rider, IntelliJ IDEA, WebStorm, etc.)

1. **Settings → Editor → TextMate Bundles**
2. Click **+** and select the `editor/` directory in this repo.
3. Confirm the import. The IDE registers `.mmpform` as a known file type.
4. Open `editor/samples/full-example.mmpform` to verify.

To re-color after the bundle is installed, restart the IDE once.

## Install in VS Code

```bash
# From the FormBuilderDSL repo root:
code --install-extension editor
```

Or copy the `editor/` directory into `~/.vscode/extensions/mmpform-language-0.0.1/`.

## Token scopes used

| Element                                       | Scope                                          |
|-----------------------------------------------|------------------------------------------------|
| Line comment                                  | `comment.line.number-sign.mmpform`             |
| Row marker `-`                                | `keyword.control.row-start.mmpform`            |
| Row continuation `\|`                         | `keyword.control.row-continue.mmpform`         |
| Panel marker `1. Panel One`                   | `entity.name.section.panel-label.mmpform`      |
| `columns: N`                                  | `keyword.declaration.columns.mmpform`          |
| `tooltips = [...]` keyword                    | `keyword.declaration.tooltips.mmpform`         |
| `colors = [...]` keyword                      | `keyword.declaration.colors.mmpform`           |
| `__properties = [...]` keyword                | `keyword.declaration.properties.mmpform`       |
| Option source name (declaration + reference)  | `entity.name.function.option-source.mmpform`   |
| `container` / `repeater` / `listManager`      | `storage.type.container.mmpform`               |
| Collapsible `>` modifier                      | `keyword.modifier.collapsible.mmpform`         |
| Named-object PK marker (`{ !field: ... }`)    | `keyword.modifier.primary-key.mmpform`         |
| PK field name (the IDENT after `!`)           | `entity.name.tag.primary-key.mmpform`          |
| Control type names                            | `support.type.control.mmpform`                 |
| `{path}` binding                              | `entity.name.tag.binding.mmpform`              |
| `{name:type}` inline-typed binding            | `entity.name.tag.binding.typed.mmpform` + `support.type.binding-data.mmpform` |
| `{@fnName}` / `{@registry.subFn}` function binding | `entity.name.tag.binding.function.mmpform` |
| `{this.field}` repeater-scope reference       | `variable.language.this.mmpform`               |
| Strings                                       | `string.quoted.{double,single}.mmpform`        |
| Dates                                         | `constant.numeric.date.mmpform`                |
| Numbers                                       | `constant.numeric.{integer,float}.mmpform`     |
| `true` / `false` / `null`                     | `constant.language.mmpform`                    |
| Param keys (`when`, `min`, `search`, ...)     | `variable.parameter.mmpform`                   |
| Operators (`->`, `==`, `!=`, ...)             | `keyword.operator.*.mmpform`                   |
| `\[` / `\]` escapes in label text             | `constant.character.escape.bracket.mmpform`    |

The standard scope names mean any TextMate-compatible theme will produce sensible colors out of the box; a custom theme can target the dotted suffixes for finer control.

### Why these particular scopes

- **Option-source declarations and references share the same scope** (`entity.name.function.option-source`). The `extChoices` in the declaration and the `extChoices` in `#extChoices` will match in color in any theme, because they're the same identifier semantically.
- **Bindings use `entity.name.tag`** because most themes render tag names colored *and* bold (the same scope HTML elements use). If your theme doesn't bold this scope, override it in **Settings → Editor → Color Scheme → TextMate Bundles → `entity.name.tag.binding.mmpform`** and check **Bold**.
- **`this` inside a binding gets `variable.language`** because that's the same scope JS / TS themes use for `this`. The `{this.field}` form reads as a "current item" reference at a glance.
- **Named-object PK marker (`!`) is split from the field name** so a theme can colour the marker as a modifier (typically a single-character flag) and the IDENT as a regular field name. That keeps `{ !pk: 1, name: "Ada" }` from looking like a logical-NOT expression.

### What changed in this bundle version

- Added `listManager` to the container-decl pattern.
- Added `__properties = [...]` block declaration.
- Added `null` as a recognised bare keyword (the third value, alongside `true` / `false`).
- Added the named-object primary-key marker (`!field`) so it doesn't get mis-coloured as logical-NOT.
- Added repeater-scope `this.field` highlighting.
- Allowed dotted function bindings (`{@math.add}`) to match the parser, which now joins them into a single function-registry key.
- Added new container parameter keys: `search`, `filter`, `draggable`, `addLabel`, `commit`, `excluded`, `height`, `minHeight`, `maxHeight`. Added `units` / `defaultUnit` for `fileSize`.
- Removed the inline `tooltip="..."` container parameter from the keyword list. The current language has a single tooltip surface (`tt="key"`) shared by containers and controls.
- Recognise `\[` and `\]` as label-text escapes (so `Step \[1\] of 5` reads as a literal in a label without being mis-parsed as a new declaration).

## Limits

- **No semantic checking.** Bad bindings, wrong parameter types, layout overflows - none of these light up. The TextMate engine is regex-based and stateless across lines.
- **No autocomplete.** That needs an LSP server.
- **No go-to-definition** on `#optName` references.

If you want any of those, the next step is wrapping the JS parser in a Language Server Protocol server. The TupleResponse diagnostics already carry line / column positions, which map directly to LSP range data.

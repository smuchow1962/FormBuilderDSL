# Architecture rule: AST walks are not cached

This is a hard, non-negotiable rule of the package. Every helper that walks the AST re-walks it from scratch on every call. Nothing is cached. Nothing is memoized. There is no `processFromAst(ast)` shortcut.

## What this means in practice

Functions and methods that walk the AST always re-do the walk:

- `TextFormBuilder.parse()` re-tokenizes, re-parses, and re-validates on every call.
- `TextFormBuilder.process()` calls `parse()` and then walks the AST to collect properties — every time.
- `collectProperties(ast)` walks the AST every call.
- `validateProperties(ast)` walks the AST every call.
- `inferDataSchema(ast)` walks the AST every call.
- `renderFormPreview(ast)` walks the AST every call.

If a consumer calls `process()` ten times in a row with the same source, the parser runs ten times, the property collector runs ten times, and every walk re-reads every node.

## Why

The trust posture of the package is "the result is honest because the walk is honest." A cache layer makes the consumer reason about cache invalidation, freshness, and whether a mutation between calls will be reflected. Re-walking on every call removes that whole class of bug. The cost is sub-millisecond on realistic forms. The simplicity is the win.

## What this rules out

The following ideas have been suggested in previous reviews and were rejected on this rule:

- A `processFromAst(ast)` helper that takes a pre-built AST and skips the parse stage.
- A cache layer on `TextFormBuilder.process()` keyed on `schemaText`.
- Memoizing `collectProperties(ast)` results across calls with the same AST identity.
- Caching `validateProperties(ast)` to skip the re-collection step that already ran inside `process()`.
- Any "fast path" that observes the input has not changed since the last walk and returns a stored result.

A reviewer flagging "process() re-parses on every call" or "validateProperties re-collects on every parse" as a finding should treat the response as: this is intentional behaviour, not a hot-path concern.

## When to optimize

The consumer caches the AST themselves. A consumer running a UI re-render that does not need a fresh parse holds onto the previous `payload` and re-uses it. The package gives the consumer one straight answer per call; the caller decides how often they want to call.

# Text-Based Form DSL — Authoring quickstart

This is an authoring-side overview of the DSL: the shapes an author writes, the way controls are declared, the most common parameters. It's the right place to start when you're learning the language.

For the canonical specification of the AST shape, the parsing pipeline, the per-control vocabulary, the validation passes, and the design decisions — see [`architecture.md`](architecture.md), which is the language reference.

The goal of the DSL is to describe configuration forms in a compact, readable format that can be parsed into a normalized model and rendered into UI components (Vuetify or otherwise). The system is intentionally simple. It favors clarity over flexibility and avoids unnecessary abstraction.

---

# Core Model

All forms follow the same structure:

```
DSL Text
   ↓
Parsed Tokens
   ↓
Normalized Form Model (AST)
   ↓
Renderer (Vue / DOM)
```

The DSL is not responsible for rendering. It only describes structure and intent.

---

# Global Configuration

Global configuration defines layout and option sources.

```dsl
columns: 20  # grid; row widths ≤ this
```

### Behavior

- `columns` defines the grid system width used for layout

The DSL emits logical control types (`select`, `textfield`, `check`, `combo`). Mapping those to concrete framework components - Vuetify, native HTML, or anything else - happens after the AST is built and is the consumer's responsibility. It is not part of the DSL or the parser.

---

# Option Sources

Option sources define reusable data for dropdown-style controls.

## Static Options

```dsl
extChoices = ["log", "ndjson", "csv"] -> {logExtension}  # static → logExtension
logTypes   = ["text", "ndjson", "csv"] -> {logOutputType}  # static → logOutputType
```

## Dynamic Options

```dsl
levels = {levelsList}  # dynamic options from data
```

### Behavior

- `-> {binding}` means the selected value is stored in that field
- `#name` is used to reference the option source inside controls
- Dynamic sources read directly from the data object

---

# Tooltips

A `tooltips` block declares named text snippets that controls reference. The block sits at the top level alongside `columns:` and option sources.

```dsl
tooltips = [  # tt="key"; {path} / {@fn} at render time
    "tooltip-1" = "Pick how often the rolling log rotates.",
    "billing"   = "Hello {userName}, retention is {retentionDays} days.",
    "status"    = "Computed: {@formatStatus}"
]
```

### Behavior

- Keys are quoted strings (recommended for any name with hyphens or digit-leading) or bare identifiers (`tooltipFoo`).
- Values are quoted strings. Newlines inside the brackets are collapsed to spaces, so wrap the source as you like; use `\n` if you actually want a line break in the rendered tooltip.
- Tooltip values may carry `{path}` placeholders (data interpolation) and `{@functionName}` placeholders (function-call interpolation). Both are resolved at render time by the consumer's renderer or the shipped `interpolate(text, data, functions)` helper.
- Duplicate keys are an error.

### Referencing a tooltip from a control

`tt="key"` is a universal control parameter - every control accepts it.

```dsl
[select(7,#rollingIntervalList,{rollingInterval},tt="tooltip-1")] Rolling Interval  # tt= tooltip key
[number(6,{retentionDays},tt="billing")] Retention Days  # tt= billing copy
```

A `tt=` that references a key not in the `tooltips` block is an error.

---

# Colors

A `colors` block declares named hex values that decorator codes can reference. Same shape as `tooltips` - keys are quoted strings or bare identifiers, values are quoted 3- or 6-digit hex strings.

```dsl
colors = [  # :name / bg:name in decorators
    "warning" = "#F39C12",
    "danger"  = "#E74C3C",
    "muted"   = "#888"
]
```

Reference a color from a decorator with `:name` (foreground) or `bg:name` (background). Names that aren't declared are not parse-time errors; the AST passes the name through with `resolved: null` and the renderer / compiler is responsible for mapping it to something valid.

---

# Text Decorators

Tooltip text and label text accept inline decorator spans, similar in spirit to ANSI escape codes. A backtick opens a span, codes follow, another backtick closes the codes, and a closing backtick (or empty `` `` `` / explicit `` `r` ``) resets.

```
`+b`Directory`` `i:muted`(server path)``
```

renders as bold-larger "Directory", a space, then italic muted-color "(server path)".

## Modifier codes

| Code | Effect |
|------|--------|
| `b`  | bold |
| `i`  | italic |
| `u`  | underline |
| `s`  | strike-through |
| `+`  | one size up; stack `++` for two steps, etc. |
| `-`  | one size down |
| `r`  | reset (also: empty `` `` ``) |

## Color codes

| Form | Meaning |
|------|---------|
| `#RRGGBB`, `#RGB`     | foreground hex (long or short) |
| `bg#RRGGBB`, `bg#RGB` | background hex |
| `:name`               | foreground named color (resolves via `colors` block; passes through unresolved) |
| `bg:name`             | background named color |

Codes concatenate freely; whitespace and commas inside a span are ignored. Order doesn't matter:

```dsl
# Inside labels/tooltips only (not top-level form lines)
`b#F00`               bold + red
`+b#F00bg#FF0`        bold + red + larger + yellow background
`b:warning bg:muted`  bold + warning fg + muted bg
```

## Escaping

Inside a tooltip or label, write `\`` for a literal backtick. The decorator span opens at unescaped `` ` ``.

## Where decorators apply

Anywhere display text appears - tooltip values and trailing label text on controls / containers / panels. The parser produces `TextFragment[]` with style attached to each fragment; consumer renders with the framework of choice.

---

# Function Bindings

Anywhere a `{path}` data binding appears, a `{@functionName}` reference can take its place. The renderer calls the named function at render time and uses the result. Function bindings only make sense on read-only sites - they're rejected on writeable controls because there's nowhere to write back.

```dsl
[display(8,{@formatStatus})] Status  # read-only @fn

"status" = "Computed: {@formatStatus}"  # tooltip entry

levels = {@enumerateLevels}  # options from @fn
```

The function name follows the `@` and uses the same identifier rules as a binding path. The function registry is consumer-owned; the parser only captures the name.

---

# Containers

All forms begin with a container.

```dsl
[container({title},{description})]  # root; title + description
```

## Collapsible Containers

```dsl
[>container({title},{description})]  # collapsible
```

### Behavior

- `container` defines a layout block
- `>container` makes the container collapsible
- The first `{...}` is the title binding, the second is the description binding

## Repeaters

A repeater is a container bound to an array. The renderer produces one sub-form per array element and provides add / remove affordances.

```dsl
[repeater({routes},min=1,max=10)] Routes  # per-element subform; {this.*} = row
  - [textfield(10,{this.match})] Match Pattern
    | [select(5,#sinks,{this.target})] Target Sink
```

### Behavior

- `{routes}` is the array binding. Each element produces one iteration.
- `{this.field}` resolves against the current iteration's element, so `{this.match}` is `routes[i].match`.
- `min=N` / `max=N` bound the number of items (optional).
- The label after the closing `]` is the user-facing heading for the whole repeater.

---

# Rows

Rows define layout grouping.

```dsl
- [control(...)] Label  # new row
```

## Multi-Control Row

```dsl
- [control(...)] Label  # row start
  | [control(...)] Label  # same row
  | [control(...)] Label
```

### Behavior

- `-` starts a new row
- `|` continues the same row
- Controls in the same row share horizontal space

---

# Controls

A control declaration:

```dsl
[type(parameters)] Label  # markers: width, #src, {bind}, key=value
```

All of a control's parameters live inside the parens. The parser distinguishes them by their marker, so order does not matter:

| Marker          | Meaning |
|-----------------|--------|
| bare integer    | column width |
| `#name`         | option source reference |
| `{path}`        | data binding |
| `key=value`     | type-specific config (`min`, `rows`, `format`, ...) or built-in option (`when`) |

The label after the closing `]` runs to end of line.

## Multi-line Controls

A long control may wrap across lines. Newlines inside `[...]` or `(...)` are treated as whitespace; the control terminates at the closing `]`. After that, the label runs to end of line as normal.

```dsl
- [number(
      5,
      {port},
      min=1,
      max=65535,
      step=100
    )] Port  # newlines inside [ ] ( ) → whitespace
```

There is no continuation character. The brackets and parens already say "I'm not done"; adding `\` would be redundant. This rule does not change `|` - the pipe is a row-level marker and lives at a different grammar level than the bracket / paren wrap.

## Conditional Visibility

Any control or container may take a `when=expr` parameter. The control renders only when the expression is true against the data object.

```dsl
[number(5,{compressionLevel},min=1,max=9,when="compression != 'none'")] Compression Level  # when= predicate
[textfield(20,{customEndpoint},when="useCustomEndpoint")] Custom Endpoint
```

### Expression Grammar

The expression is a small boolean DSL:

- `field` - true when `field` is truthy
- `!field` - true when `field` is falsy
- `field == 'value'` / `field != 'value'` - equality / inequality
- `field in ['a','b','c']` - membership in a literal list
- Combine with `&&` and `||`; group with `( ... )`

String literals use single or double quotes. Unknown fields evaluate to `undefined` (falsy).

The renderer skips controls whose `when` is false. Controls inside a hidden container are not rendered regardless of their own `when`.

## Control Types

The DSL emits the logical type. Mapping a logical type to a concrete framework component (Vuetify, native HTML, anything else) is a post-AST consumer concern.

### Text Input

- **`textfield(maxLength=N, placeholder='...', pattern='...')`** - single-line text. The default for short string fields.
- **`textarea(rows=N, maxLength=N, placeholder='...')`** - multiline. Cert chains, JSON snippets, long descriptions, allowlists.
- **`password(reveal=bool, minLength=N)`** - same as `textfield` but masked. API keys, tokens, secrets. The parser tags this type as a secret so the renderer doesn't echo it. `reveal=true` lets the consumer offer a "show" toggle.

```dsl
[textfield(10,{logDirectory},maxLength=260,placeholder='/var/log/app')] Logging Directory  # path
[textarea(20,{certPem},rows=8,maxLength=8192)] Certificate (PEM)  # multiline
[password(10,{apiKey},reveal=true,minLength=12)] API Key  # secret
```

### Numeric

- **`number(min=N, max=N, step=N)`** - integer. Ports, file-size caps in bytes, retry counts, batch sizes. The most common primitive for sink config.
- **`float(min=N, max=N, step=N, decimals=N)`** - decimal. Rates, ratios, percentages, durations in fractional units. Distinct type so the storage shape is obvious from the DSL alone.
- **`slider(min=N, max=N, step=N)`** - number with a visual range. For tunables with a reasonable min/max where a typed number feels excessive.

```dsl
[number(5,{port},min=1,max=65535,step=1)] Port  # int
[float(5,{samplingRate},min=0.0,max=1.0,step=0.01,decimals=2)] Sampling Rate  # float
[slider(12,{verbosity},min=0,max=100,step=5)] Verbosity  # slider
```

### Boolean

- **`check`** - checkbox. Best for "I agree" / static-state semantics.
- **`toggle`** - semantically a checkbox but renders as an on/off switch. Different affordance, different intent ("enable rolling logs" reads as a toggle, "I agree" reads as a checkbox).

```dsl
[check(3,{acceptedTerms})] I accept the terms  # checkbox
[toggle(4,{rollingLogsEnabled})] Rolling Logs  # toggle
```

### Choice - One from a List

- **`select`** - fixed dropdown.
- **`combo`** - free-text input with suggestions.
- **`radio`** - a small mutually-exclusive set where a dropdown feels heavy (3-4 choices).

```dsl
[select(5,#logTypes,{logOutputType})] Log Output Type  # select
[combo(4,#extChoices,{logExtension})] Extension  # combo
[radio(8,#compressionAlgos,{compression})] Compression  # radio
```

### Choice - Multiple from a List

- **`multiselect(min=N, max=N)`** - multiple values from a list. Enabled environments, tag lists, allowlists of levels. `min` / `max` bound how many items can be selected.

```dsl
[multiselect(12,#environments,{enabledEnvs},min=1,max=8)] Enabled Environments  # multi
```

### Date and Time

- **`date(min=YYYY-MM-DD, max=YYYY-MM-DD, format='...')`** - calendar picker, returns a date.
- **`time(format='...', step=N)`** - time-of-day picker. `step` is in minutes.
- **`datetime(min=..., max=..., format='...')`** - combined; common for "retain until," scheduled jobs, license expiry.
- **`daterange(min=..., max=...)`** - two dates as one control. The binding holds a `{start, end}` object. A distinct type rather than two `date`s, because the start ≤ end check lives in the control.

```dsl
[date(5,{startsOn},min=2026-01-01,format='YYYY-MM-DD')] Starts On  # date
[time(4,{dailyCutoff},format='HH:mm',step=15)] Daily Cutoff  # time
[datetime(8,{retainUntil},min=2026-01-01T00:00,format='YYYY-MM-DD HH:mm')] Retain Until  # datetime
[daterange(12,{billingPeriod})] Billing Period  # range
```

### Files and Specialized

- **`file(accept='...', maxBytes=N)`** - upload a cert, a credentials JSON, a private-key PEM. Browser-only; the binding holds the file content or a reference. `accept` is a comma- or semicolon-separated list of extensions or MIME types.
- **`color`** - niche for sinks; common for theme / branding fields.
- **`hidden`** - invisible but bound. For ids and state the form has to round-trip but never displays. `width` and `Label` are required by grammar but the renderer ignores both.

```dsl
[file(10,{tlsCert},accept='.pem;.crt',maxBytes=65536)] TLS Certificate  # upload
[color(3,{accentColor})] Accent Color  # color
[hidden(0,{installId})] Install ID (hidden)  # round-trip, hidden
```

### Display-only

`label` does not read or write data; `display` reads from a binding but never writes.

- **`label(style=heading|note|divider|help)`** - static text. One type covers headings, in-line notes, dividers, and help text via the `style` property. Default style is `note`.
- **`display(format='...')`** - read-only display of a bound value. Same parameter shape as a regular control (width + binding); the renderer treats it as read-only. The optional `format` is a hint for date / number / template formatting.

```dsl
[label(20,style=heading)] Connection Settings  # heading
[label(20)] Provide credentials below.  # note
[label(20,style=divider)]  # divider
[label(20,style=help)] Click "Test Connection" before saving.  # help

[display(18,{namingConvention})] Naming Convention  # read-only
[display(8,{lastSyncedAt},format='YYYY-MM-DD HH:mm')] Last Synced  # formatted
```

---

# Grid System

The grid uses the global `columns` value.

```dsl
columns: 20  # same global grid as elsewhere
```

Example:

```dsl
[textfield(10)] + [textfield(10)] = full row  # pseudo-math: widths sum to columns
[textfield(6)] + [textfield(6)] + [textfield(8)] = full row
```

### Behavior

- Widths should sum to ≤ total columns
- Renderer is responsible for layout enforcement

---

# Collapsible Panel Containers

Containers can define multi-panel layouts.

```dsl
[>container(panels=[1:8,2:12])] [check(3,{rollingLogTrue})] Rolling Log Configuration  # 8+12 panels; header control
```

### Behavior

- `panels=[1:8,2:12]` declares panel widths in column units
- The header may carry one inline control (e.g., a master toggle)

---

# Full Example

```dsl
columns: 20  # globals

extChoices = ["log", "ndjson", "csv"] -> {logExtension}  # static
logTypes   = ["text", "ndjson", "csv"] -> {logOutputType}
levels     = {levelsList}  # dynamic

[container({title},{shorthandDescription})]  # root

  - [select(5,#logTypes,{logOutputType})] Log Output Type

  - [textfield(10,{logDirectory})] Logging Directory  # one row, | continues
    | [textfield(6,{logFileTemplate})] File Name Template
    | [combo(4,#extChoices,{logExtension})] Extension

  - [>container(panels=[1:8,2:12])] [toggle(3,{rollingLogsEnabled})] Rolling Log Configuration  # nested tabs; header toggle

    1. Panel One
      - [number(6,{maxFileSize},min=1,max=1073741824,step=1024)] Max File Size (bytes)
      - [number(6,{maxFileCount},min=1,max=10000,step=1)] Max File Count

    2. Panel Two
      - [select(5,#levels,{logLevel})] Log Level
      - [check(3,{compressOldLogs},when="rollingLogsEnabled")] Compress Old Logs  # when rolling on
```

---

# Parsing Rules

The parser must follow these rules:

## 1. Structure First

- Parse containers
- Parse rows
- Parse controls

Do not mix parsing with rendering.

## 2. Normalize Immediately

Convert DSL into a clean internal model:

```json
{
  "type": "control",
  "controlType": "select",
  "width": 5,
  "optionsSource": "logTypes",
  "binding": "logOutputType",
  "label": "Log Output Type"
}
```

## 3. No Implicit Behavior

- Everything must be explicit in the DSL
- No hidden defaults unless documented

---

# Technical Notes

The system already separates concerns cleanly:

- The DSL describes structure
- The parser builds a model
- The renderer builds UI

That keeps each part small and testable.

The important shift is treating the DSL as a **declarative input**, not a rendering instruction set.  
That prevents UI logic from leaking into parsing.

We do not need a complex schema system here. The DSL is already expressive enough for configuration forms.

This approach keeps code change minimal:
- Parser changes do not affect UI
- UI changes do not affect DSL
- Data model stays stable

That matters because configuration systems tend to grow over time. Keeping these boundaries clean avoids a rewrite later.

---

# Next Step

Implement only the parser.

Success criteria:
1. DSL input produces a correct normalized model
2. Rows and controls are grouped correctly
3. Option sources resolve correctly

Rendering comes after the model is stable.

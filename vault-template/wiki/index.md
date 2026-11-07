# Wiki Index

Master catalog. Every wiki page must be reachable from here — an orphaned page is a lint
error. The linter re-flows this file, so appends from the ingester may leave rows out of
alphabetical order; that's expected drift, not a problem.

**Format:** `| [[Page Name]] | type | One-line summary with the key facts |`

A bare `[[Title Case Name]]` wikilink in the first column. Never a path prefix like
`wiki/concepts/Title` — that breaks navigation. `type` is unquoted and must be one of
`concept`, `coding-interview`, `article`, `question`, `project`, `person`, `synthesis`.

---

## Concepts

| Page | Type | Summary |
|---|---|---|
| [[Attention Mechanism]] | concept | Weighting scheme that lets a model focus on relevant parts of its input; the core of the transformer architecture (source: sources/articles/example-attention.md) |

## Articles

| Page | Type | Summary |
|---|---|---|
| [[Example Article]] | article | Placeholder row showing the expected shape — replace with your first ingested article |

## People

| Page | Type | Summary |
|---|---|---|

## Projects

| Page | Type | Summary |
|---|---|---|

## Questions

| Page | Type | Summary |
|---|---|---|

## Syntheses

| Page | Type | Summary |
|---|---|---|

## Coding Interview

| Page | Type | Summary |
|---|---|---|

---

<!--
Delete the placeholder rows above (Attention Mechanism, Example Article) once you have real
content. They exist so the dashboard build has something valid to render on first run, and so
you can see the exact row format the ingester produces.
-->

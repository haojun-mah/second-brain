# Wiki Log

Append-only record of every change made to `wiki/`. Newest entries go at the bottom. Never
edit or delete an existing entry — if something was wrong, append a correction that
references the original by timestamp.

**Entry format:**

```
## <ISO datetime> — <agent>
- <what changed> (<source: path/to/source.md>)
```

Keep the em-dash before the agent name. The three agent names are `ingester`, `linter`, and
`query` (for on-demand write-ups). Manual human edits, if any, are logged as `manual`.

---

## 2026-01-01T00:00:00Z — ingester

Scaffold entry, kept as a format reference. Delete this block once your own log has real
entries — it exists so the first-run dashboard build and the linter's carry-forward baseline
have a valid, parseable log to read.

- Created `wiki/concepts/Attention Mechanism.md` (source: sources/articles/example-attention.md)
- Updated `wiki/index.md` (added entry: Attention Mechanism)

## 2026-01-01T00:00:00Z — linter

- Checks run: orphan pages 0 found, broken wikilinks 0 found, missing frontmatter 0 found,
  uncited content 0 found, image embed violations 0 found
- Auto-fixes applied: none
- Questions filed: none

# Scan Row Format

One row per page when doing a bulk read-only verification sweep. Append to a single local file
in your home directory (e.g. `~/.lint-rows.md`), never one file per batch and never in `/tmp`.

The point is compaction survival: after a context compaction drops your earlier tool outputs,
one read of this file restores every verified row and the remaining scope.

---

## Row format

```
<path> | fm=<OK|BAD> | sources=[<path>, ...] (<missing: <path>|->) | related=[<title>, ...] | embeds=<N> | links=<N> | notes=<short finding>
```

| Field | Meaning |
|---|---|
| `path` | Vault path exactly as it appears in the listing — never a guessed or normalised variant |
| `fm` | `OK` if frontmatter is present, ordered correctly, and schema-valid; `BAD` otherwise |
| `sources` | The raw `sources:` values, verbatim. `(missing: -)` when all resolve; otherwise the unresolvable paths |
| `related` | Wikilink targets from the `related:` field, bare titles without brackets |
| `embeds` | Count of `![[...]]` image embeds in the body |
| `links` | Count of body wikilinks (excluding code fences and inline code) |
| `notes` | One short phrase — the specific defect, or the word `clean` |

---

## Examples

```
wiki/coding-interview/Path With Minimum Effort.md | fm=OK | sources=[sources/coding/Path With Minimum Effort.md] (missing: -) | related=[Dijkstra, Union Find] | embeds=1 | links=3 | notes=clean
wiki/concepts/Entity Model.md | fm=BAD | sources=[sources/notes/entity-model.md] (missing: sources/notes/entity-model.md) | related=[] | embeds=0 | links=0 | notes=source missing; related: [] present (should be omitted); no See Also section
wiki/questions/lint-2026-05-01-findings.md | fm=OK | sources=[] (missing: -) | related=[] | embeds=0 | links=0 | notes=clean (question stub, sources: [] expected)
wiki/articles/Example Article.md | fm=OK | sources=[sources/articles/example.md] (missing: -) | related=[Attention Mechanism] | embeds=0 | links=1 | notes=clean
```

---

## Progress block

Every few batches, append a progress block so a resumed run knows exactly where it stopped:

```
# PROGRESS verified=47/120
# done: coding-interview (32/32), concepts (15/15)
# remaining: articles (0/18), people (0/4), projects (0/3), questions (0/8), syntheses (0/5), articles-root (0/4)
# last_batch: 2026-05-26T14:32:00Z
```

---

## Rules

1. **One file, append-only.** Per-batch files drift; reconciling five of them costs a whole
   pass and produces contradictory verdicts.
2. **Home directory, not `/tmp`.** `/tmp` is cleared on reboot and is less durable across a
   long sweep.
3. **Verbatim paths.** Take every path from a fresh listing. A guessed path that 404s is a
   wasted iteration that a row never gets.
4. **Freeze the source set first.** Take one complete listing of the source folders before the
   first page read and record it in the same file. Verifying citations against a partial
   listing produces confidently wrong `[MISSING]` verdicts.
5. **Write the progress block as the last action of the last read batch,** so even a dead turn
   leaves durable state.
6. **Generate the final report from this file,** in one turn, without further vault reads.

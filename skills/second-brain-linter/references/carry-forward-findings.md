# Carry-Forward Findings

Long-running open clusters that recur across lint runs. Read this at step 2 of the lint flow
alongside `.meta/last_lint.json` and the newest question file.

**This is a skill reference file, not a vault file.** Read it with
`skill_view(name='second-brain-linter', file_path='references/carry-forward-findings.md')`.
An MCP read of `references/carry-forward-findings.md` will 404.

Update it with `skill_manage(action='write_file', ...)` — never with vault write tools, since
Discipline Rule 2 restricts agent vault writes to `wiki/` and `.meta/`.

---

## Why this file exists

Some lint findings are structural: they describe a whole family of pages that share one
historical defect, and fixing them requires a human decision. Filing them fresh every week
produces ten near-identical question files and no resolution.

A carry-forward cluster records:

- the pattern that defines membership
- how to detect members cheaply
- the exact remediation that would close it
- why it hasn't been closed

When a cluster is resolved, delete its section here and note the closure in the run's log entry.

---

## How to use it

1. At step 2, read this file.
2. For each cluster, run its detection step against the current page listing.
3. If members remain: re-verify them (paths drift — a page may have moved or been fixed), fold
   them into this run's question file under a `## Carry-forward` heading, and do **not** report
   them as fresh findings.
4. If a cluster has no remaining members: remove its section and note the closure.
5. If a new cluster emerges this run and looks structural (5+ pages, one root cause), add it
   here so the next run inherits it.

---

## Template

```markdown
### <Cluster name>

**Pattern:** <what makes a page a member>

**Detection:** <the cheapest check that enumerates members>

**Members (as of <date>):** <count>, e.g. <3 example paths>

**Root cause:** <why these pages have this defect — usually one historical ingester behaviour>

**Remediation:** <the exact fix that closes the cluster>

**Why open:** <what judgment call or missing information is blocking it>

**Status:** open | partially fixed | resolved
```

---

## Seeding the file

A fresh install has no clusters. Leave this file in place as the template and the first
structural finding you hit will fill it.

Three clusters that appear in almost every long-lived vault, worth watching for:

### Stale `_inbox/` citations

**Pattern:** a page's `sources:` array cites `sources/_inbox/<name>.md`.

**Detection:** grep the `sources:` values of every page for `_inbox`. `_inbox/` is emptied by
the ingester on every run, so any such citation is stale by definition.

**Root cause:** pages written by hand or by very early ingester versions, before post-move paths
were used in citations.

**Remediation:** read `.meta/processed.json` and look up each cited filename's `moved_to`. Rewrite
the page's `sources:` array to the real path.

**Why open:** it needs a judgment call when no `processed.json` record exists (a manual ingest
may predate the tracking), and the batch rewrite should be one deliberate pass rather than an
auto-fix scattering changes across pages. File as ONE question listing every affected page with
its proposed replacement path.

### Empty `related:` arrays

**Pattern:** frontmatter contains `related: []`.

**Detection:** grep frontmatter for `related: []`.

**Root cause:** an ingester version that emitted the field unconditionally instead of omitting
it. The schema says omit when empty.

**Remediation:** delete the line.

**Why open:** *this one is a safe auto-fix* — there's no judgment involved. If you see it, fix
it, bump `updated:`, and log it. It's listed here because it recurs and is easy to mistake for
pre-existing drift to leave alone.

### `type: stub` on stub pages

**Pattern:** a page under `wiki/coding-interview/` (or another typed folder) carries
`type: stub`.

**Detection:** grep frontmatter for `type: stub` and `type: "stub"`.

**Root cause:** early linter runs created stubs without setting the real enum value.

**Remediation:** set `type` to the value implied by the containing folder, and add
`sources: ["linter-generated-stub"]` if the field is entirely absent.

**Why open:** also a safe auto-fix when the folder makes the correct type unambiguous. Kept here
as a reminder to check for it every run.

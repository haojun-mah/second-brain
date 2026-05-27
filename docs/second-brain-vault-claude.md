# Second Brain Vault

This file is read first by every agent (ingester, query, linter) at the start of every session. It defines vault layout, naming conventions, frontmatter schema, and the discipline rules every agent must follow without exception.

---

## Vault Directory Layout

```
OneDrive/Obsidian/
├── CLAUDE.md                    ← this file (read first, every session)
├── sources/
│   ├── _inbox/                  ← drop zone; ingester polls here every 10 min
│   ├── articles/                ← web clippings, papers, PDFs
│   ├── voice-notes/             ← Telegram voice note transcripts
│   ├── conversations/           ← meeting notes, chat exports
│   ├── books/                   ← book highlights and notes
│   └── drafts/                  ← raw personal thoughts
├── wiki/
│   ├── index.md                 ← master catalog; one-line summary per page
│   ├── log.md                   ← append-only ingest/lint log
│   ├── concepts/                ← one file per concept
│   ├── people/                  ← one file per person
│   ├── projects/                ← active projects
│   ├── questions/               ← open questions, contradictions, ambiguities
│   └── syntheses/               ← cross-cutting summaries
└── .meta/
    ├── processed.json           ← ingester tracks which files it has processed
    ├── delta_token.json         ← Graph API delta token for change detection
    └── last_lint.json           ← linter writes run summary here
```

---

## Wiki Page Frontmatter

Every file under `wiki/` (except `index.md` and `log.md`) must begin with this YAML block:

```yaml
---
title: "Page Title"
created: "2026-01-15"
updated: "2026-01-15"
sources:
  - "sources/articles/example.md"
tags: []
type: concept  # concept | person | project | question | synthesis
---
```

Rules:
- `title` must match the filename exactly (without `.md`).
- `created` is set once and never changed.
- `updated` is set to the ISO date of the last agent edit.
- `sources` must contain at least one path relative to the vault root. No wiki page may exist without at least one source citation.
- `type` must be one of: `concept`, `person`, `project`, `question`, `synthesis`.
- `tags` is optional but must be a list (never a bare string).

---

## Wikilink Conventions

- Use `[[Page Name]]` with Title Case — never kebab-case, never lowercase.
- Use display text only when the visible link text genuinely differs from the page title: `[[Machine Learning|ML]]`. Do not add display text just to vary the sentence; prefer rephrasing.
- Every wiki page must be reachable via at least one `[[wikilink]]` from `wiki/index.md`. An orphaned page is a lint error.
- Cross-links between wiki pages are encouraged. When a concept page mentions a person, link to the person page. When a synthesis draws on a concept, link to that concept.

---

## File Naming Conventions

**Wiki pages** — Title Case with spaces, `.md` extension:
- `Machine Learning.md`
- `John Doe.md`
- `Project Alpha.md`

**Source files** — lowercase kebab-case. For time-stamped captures (voice notes, inbox drops), prefix with `YYYY-MM-DD`:
- `2026-05-26-voice-note.md`
- `2026-05-26-article-title.md`
- `book-highlights-deep-work.md` (no timestamp needed for imports without a capture date)

Do not rename source files after the ingester has processed them. The `processed.json` record uses the original filename as the key.

---

## Source Categorization

When the ingester moves a file out of `sources/_inbox/`, it places it in the correct subdirectory based on content type:

| Content type | Target directory |
|---|---|
| Web clipping, downloaded paper, PDF converted to markdown | `sources/articles/` |
| Telegram voice note transcript | `sources/voice-notes/` |
| Meeting notes, conversation export, interview transcript | `sources/conversations/` |
| Book highlights, Kindle export, reading notes | `sources/books/` |
| Personal draft, stream-of-consciousness, raw thought | `sources/drafts/` |

If the type is ambiguous, prefer `sources/articles/` for external content and `sources/drafts/` for personal content. Never leave a file in `sources/_inbox/` after processing.

---

## Citation Format

**Within wiki page body text:**

- Link to another wiki page: `[[Concept Name]]`
- Reference a source file inline: `(source: sources/articles/foo.md)`

Multiple citations for a single claim are allowed:

```
The transformer architecture relies on self-attention (source: sources/articles/2026-03-attention-is-all-you-need.md).
This has since been applied to vision tasks [[Vision Transformer]] (source: sources/articles/2026-04-vit-paper.md).
```

Do not invent citations. If a claim cannot be traced to a file in `sources/`, omit the claim or flag it in `wiki/questions/` as unverified.

---

## Discipline Rules

These are hard constraints. Every agent must follow them. There are no exceptions.

1. **The user only ever drops files into `sources/`.** The user never manually edits anything under `wiki/` or `.meta/`. If wiki pages are found with edits that appear human-authored, the linter flags them but does not overwrite.

2. **Agents only write to `wiki/` and `.meta/`.** Agents never modify the content of source files. The only permitted action on source files is moving a file from `sources/_inbox/` to the appropriate `sources/<type>/` subdirectory.

3. **Every wiki claim must cite at least one source file path** in the frontmatter `sources:` array. A wiki page with an empty `sources:` list is a lint error unless it is `index.md` or `log.md`.

4. **Agents never delete wiki pages.** To mark a page obsolete, add `stale: true` to the frontmatter and a `> **Note:** This page has been superseded by [[New Page Name]].` callout at the top of the body. The stale page remains in place.

5. **Every change to `wiki/` must be recorded in `wiki/log.md`.** Log entries are append-only. Format:

   ```
   ## 2026-05-26T14:32:00Z — ingester
   - Created wiki/concepts/Attention Mechanism.md (source: sources/articles/2026-05-26-attention-paper.md)
   - Updated wiki/index.md (added entry: Attention Mechanism)
   ```

6. **Do not hallucinate source content.** If the source file is not mounted or readable, stop and report the error in `wiki/log.md` rather than producing wiki content from memory.

7. **Do not add entries to `processed.json` for files that were not fully processed.** Partial processing (e.g., a file that caused an error mid-way) must be re-attempted on the next run. Only add to `processed.json` after the wiki write and log entry are confirmed.

---

## Agent Roles

Three agents operate on this vault. Each has a single responsibility.

### Ingester

- Polls `sources/_inbox/` every 10 minutes via a scheduled recurrence.
- For each unprocessed file: reads the content, categorizes it, moves it to the correct `sources/<type>/` subdirectory, extracts concepts/entities, creates or updates wiki pages, updates `wiki/index.md`, appends to `wiki/log.md`, and records the file in `.meta/processed.json`.
- Uses OneDrive Graph API delta tokens (`.meta/delta_token.json`) to detect changes efficiently.
- Never touches files outside `sources/_inbox/` (for moving) and `wiki/` + `.meta/` (for writing).

### Query

- Answers natural-language questions from the user via Telegram (Q&A mode).
- Also accepts captures: voice notes, raw thoughts, URLs — writes them to `sources/_inbox/` for the ingester to process (Capture mode).
- Reads `wiki/` to find relevant pages, follows `[[wikilinks]]`, and traces back to `sources/` for full context when needed.
- Always cites sources in its replies: page names as `[[wikilinks]]` and source files as `(source: path)`.
- Read-only with respect to `wiki/`. The only write action is dropping files into `sources/_inbox/` during captures.

### Linter

- Runs on a schedule (daily or on demand).
- Checks: orphaned wiki pages (not linked from `wiki/index.md`), pages missing required frontmatter, empty `sources:` arrays, broken wikilinks, `wiki/log.md` entries that reference pages that do not exist.
- Writes a summary to `.meta/last_lint.json` and appends a lint report to `wiki/log.md`.
- Does not auto-fix issues — reports them only. Exception: if a page is in `wiki/` but missing from `wiki/index.md`, the linter adds the missing entry to `index.md` and logs the addition.

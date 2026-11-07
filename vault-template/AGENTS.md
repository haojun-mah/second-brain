# Second Brain Vault

This file is read first by every agent at the start of every session — regardless of
which agent framework you run (Hermes, Claude Code, Codex, Cursor, OpenCode, or your
own). It defines vault layout, naming conventions, frontmatter schema, and the
discipline rules every agent must follow without exception.

**Why `AGENTS.md`:** it is the cross-tool convention. Hermes, Claude Code, Codex,
Cursor, and OpenCode all read it natively, so the same file drives every agent you
point at this vault. If your tool only looks for `CLAUDE.md`, symlink it:
`ln -s AGENTS.md CLAUDE.md`.

If anything in an agent's own instructions conflicts with this file, **this file wins**.

---

## Vault Directory Layout

```
<YourDrive>/Obsidian/
├── AGENTS.md                    ← this file (read first, every session)
├── sources/
│   ├── _inbox/                  ← drop zone; ingester polls here on a schedule
│   ├── written/                 ← raw pre-ingestion copies of notes you typed (paper trail)
│   ├── articles/                ← processed web content (fetched URLs, clippings, papers)
│   ├── coding/                  ← programming problems (problem + approach + solution)
│   ├── concepts/                ← data structures, algorithms, standalone technique notes
│   ├── interview-experience/    ← write-ups of real interview rounds actually taken
│   ├── school-work/             ← course work, one nested folder per course/module
│   │   └── <COURSE>/            ←   create course folders as needed
│   ├── syntax/                  ← language / query syntax and language-feature references
│   │   ├── Python/              ←   one folder per language
│   │   └── SQL/
│   ├── voice-notes/             ← voice memo transcripts
│   ├── conversations/           ← meeting notes, chat exports
│   ├── books/                   ← book highlights and reading notes
│   ├── drafts/                  ← anything that doesn't fit above, or work in progress
│   └── assets/                  ← image attachments (Obsidian attachment folder)
├── wiki/
│   ├── index.md                 ← master catalog; one-line summary per page
│   ├── log.md                   ← append-only ingest/lint log
│   ├── articles/                ← ingested web articles and external content
│   ├── concepts/                ← one file per concept
│   ├── people/                  ← one file per person
│   ├── projects/                ← active projects
│   ├── questions/               ← open questions, contradictions, ambiguities
│   ├── syntheses/               ← cross-cutting summaries
│   └── coding-interview/        ← problem write-ups and interview notes
└── .meta/
    ├── processed.json           ← ingester tracks which files it has processed
    ├── delta_token.json         ← Graph API delta token for change detection
    └── last_lint.json           ← linter writes its run summary here
```

---

## Wiki Page Frontmatter

Every file under `wiki/` (except `index.md` and `log.md`) must begin with this YAML block.
**Field order is mandatory** — always use this exact sequence:

```yaml
---
title: "Note Title"
created: "YYYY-MM-DD"
updated: "YYYY-MM-DD"
tags: [tag1, tag2]
type: concept
sources: ["sources/path/to/file.md"]
related: ["[[Related Note 1]]", "[[Related Note 2]]"]
---
```

Rules:

- **Field order is fixed:** `title → created → updated → tags → type → sources → related`.
  Never reorder.
- All string values — `title`, `created`, `updated`, and every item inside `sources` and
  `related` — must be **quoted**.
- `title` must match the filename exactly (without `.md`).
- `created` and `updated` are quoted ISO dates (`"YYYY-MM-DD"`). `created` is set once and
  never changed; `updated` is set to the ISO date of the last agent edit — **including edits
  that only add links or fix frontmatter**.
- `tags` is an inline array (never a bare string, never block-style). It may be empty:
  `tags: []`.
- `type` must be one of: `concept`, `person`, `project`, `question`, `synthesis`,
  `article`, `coding-interview`. Bare scalar, no quotes.
- `sources` is an inline array of quoted paths relative to the vault root. **No wiki page may
  exist without at least one source citation.**
- `related` is an inline array of quoted wikilink strings:
  `["[[Note Name]]", "[[Other Note]]"]`. **Omit the field entirely when there are no related
  notes** — do not write `related: []`.

---

## Wikilink Conventions

- Use `[[Page Name]]` with Title Case — never kebab-case, never lowercase.
- Use display text only when the visible link text genuinely differs from the page title:
  `[[Machine Learning|ML]]`. Do not add display text just to vary the sentence.
- Every wiki page must be reachable via at least one `[[wikilink]]` from `wiki/index.md`.
  An orphaned page is a lint error.
- Cross-links between wiki pages are encouraged. When a concept page mentions a person, link
  to the person page. When a synthesis draws on a concept, link to that concept.

---

## File Naming Conventions

**Wiki pages** — Title Case with spaces, `.md` extension:

- `Machine Learning.md`
- `Jane Doe.md`
- `Project Atlas.md`

**Source files** — lowercase kebab-case. For time-stamped captures (voice notes, inbox
drops), prefix with `YYYY-MM-DD`:

- `2026-05-26-voice-note.md`
- `2026-05-26-article-title.md`
- `book-highlights-deep-work.md` (no timestamp for imports without a capture date)

Do not rename source files after the ingester has processed them. The `processed.json`
record uses the original filename as the key.

---

## Source Categorization

When the ingester moves a file out of `sources/_inbox/`, the destination depends on content
type:

| Content type | Target directory |
|---|---|
| Fetched URL, web clipping, downloaded paper, PDF | `sources/articles/` |
| Note you typed that doesn't fit a more specific bucket below | `sources/articles/` + raw copy in `sources/written/` |
| Voice memo transcript | `sources/voice-notes/` |
| Meeting notes, conversation export, interview transcript | `sources/conversations/` |
| Book highlights, e-reader export, reading notes | `sources/books/` |
| Write-up of a **real interview round** actually taken (company / round in the title, questions asked, interview-specific problem) | `sources/interview-experience/` |
| Course-specific assignment, homework, or exam prep (course code in the title) | `sources/school-work/<COURSE>/` (create the folder if missing) |
| Language / query **syntax and language-feature reference** (generators, decorators, indexing, constraints, query syntax) | `sources/syntax/<Language>/` (create language folders as needed) |
| Programming **problem** with a problem statement, usually with a screenshot, plus approach and solution | `sources/coding/` |
| **Data structure / algorithm** implementation or technique explained on its own | `sources/concepts/` |
| Sections split out of a larger draft document | `sources/drafts/` |

**Disambiguation.** The test between `coding/`, `concepts/`, `interview-experience/`, and
`syntax/` is **context, not the presence of code**. A programming problem with a statement
and usually a screenshot → `coding/`. A write-up of a real interview round →
`interview-experience/`. A data structure or algorithm explained on its own → `concepts/`. A
reference of language or query syntax features → `syntax/`. When in doubt, prefer the most
specific matching bucket; fall back to `sources/articles/` only when nothing else fits.

**`sources/written/` is a paper trail, not a destination.** When the ingester processes a
note you typed, it saves the original unmodified content to `sources/written/<filename>`
before any processing, then moves the note to its normal destination. Fetched or external
content does not get a `written/` copy.

Never leave a file in `sources/_inbox/` after processing.

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

Do not invent citations. If a claim cannot be traced to a file in `sources/`, omit the claim
or flag it in `wiki/questions/` as unverified.

---

## Discipline Rules

These are hard constraints. Every agent must follow them. There are no exceptions.

1. **The user only ever drops files into `sources/`.** The user never manually edits anything
   under `wiki/` or `.meta/`. If wiki pages are found with edits that appear human-authored,
   the linter flags them but does not overwrite.

2. **Agents only write to `wiki/` and `.meta/`.** Agents never modify the content of source
   files. The only permitted actions on source files are moving a file from
   `sources/_inbox/` to the appropriate `sources/<type>/` subdirectory, and writing a raw
   copy to `sources/written/` for notes the user typed.

3. **Every wiki claim must cite at least one source file path** in the frontmatter `sources:`
   array. A wiki page with an empty `sources:` list is a lint error unless it is `index.md`,
   `log.md`, or a linter-generated stub (`sources: ["linter-generated-stub"]`).

4. **Agents never delete wiki pages.** To mark a page obsolete, add `stale: true` to the
   frontmatter and a
   `> **Note:** This page has been superseded by [[New Page Name]].` callout at the top of
   the body. The stale page remains in place.

5. **Every change to `wiki/` must be recorded in `wiki/log.md`.** Log entries are
   append-only. Format:

   ```
   ## 2026-05-26T14:32:00Z — ingester
   - Created wiki/concepts/Attention Mechanism.md (source: sources/articles/2026-05-26-attention-paper.md)
   - Updated wiki/index.md (added entry: Attention Mechanism)
   ```

6. **Do not hallucinate source content.** If the source file is not readable, stop and report
   the error in `wiki/log.md` rather than producing wiki content from memory.

7. **Do not add entries to `processed.json` for files that were not fully processed.** Partial
   processing must be re-attempted on the next run. Only add to `processed.json` after the
   wiki write and log entry are confirmed.

8. **Screenshot embeds are never dropped.** When a source note contains an `![[...]]` image
   embed, it must appear in the final wiki page — placed immediately after the `# Title`
   heading. This applies during initial ingestion, re-ingestion, and any subsequent edit or
   refinement by any agent. A wiki page that had an image embed in its source and is missing
   one is a bug.

9. **Code is immutable — language included.** User-supplied code is never reformatted,
   corrected, or converted to another language. If the user submits C++, the note keeps C++.
   If Python, it stays Python. **Never translate or rewrite code into a different language** —
   this is the most critical part of this rule. Any inline code or fenced code block present
   in a source note must be reproduced character-for-character in the wiki page, including the
   language identifier on the code fence (```` ```cpp ````, ```` ```python ````, etc.). Agents
   must not fix, reformat, rename variables, or "improve" user code in any way — this includes
   deliberately wrong or unusual code, which is often an intentional learning point. If an
   agent believes code is incorrect, it may add a note *below* the block (never inside it),
   but the original code itself is untouched.

10. **Preserve the writer's voice and intent.** This rule applies to all agents when creating
    or editing wiki pages.
    - **Never delete points.** If a point exists in the source, it must appear in the wiki
      page. Summarising or shortening a point is acceptable; removing it is not.
    - **Preserve the writer's voice.** Do not rephrase casual, personal, or informal writing
      into neutral academic prose. If the writer uses their own phrasing, keep it. Paraphrase
      only to fix grammar or clarity, never to "improve" style.
    - **Be additive, not subtractive.** When refining a note, add context, cross-links, or
      structure. Default to keeping everything. Only shorten when content is genuinely
      redundant, not merely informal.

---

## Agent Roles

Three scheduled/on-demand agents operate on this vault, fronted by an orchestrator. Each has
a single responsibility.

### Orchestrator

- Receives all inbound messages and answers, or delegates to a specialist.
- Owns flows that span specialists: source re-categorisation, note splitting, lost-page
  recovery, missing-note investigation.
- Reads `AGENTS.md` at the start of every vault-related session.

### Ingester

- Polls `sources/_inbox/` on a schedule.
- Uses OneDrive Graph API delta tokens (`.meta/delta_token.json`) to detect changes
  efficiently, but **always also lists the inbox directly** and unions the two signals.
- Never touches files outside `sources/_inbox/` (for moving), `sources/written/` (for the
  paper trail), and `wiki/` + `.meta/` (for writing).

**For each unprocessed file, follow this order strictly — no step may be skipped or
reordered:**

1. **Read and classify.** Read the file content. Determine whether it is a URL note (see
   Link Ingestion Protocol in the ingester skill) or a note the user typed.

2. **[Copy-first + validation — notes the user typed only. Skip for URL notes.]**

   **Step 2a — Copy raw content.** Write the raw, unmodified content to
   `sources/written/<filename>`.

   **Step 2b — Validate copy (hard gate).** Immediately read back
   `sources/written/<filename>` and confirm it exists with non-zero content:
   - **Pass:** proceed to step 3.
   - **Fail:** wait ≥ 1 second, then retry step 2a + 2b. Repeat up to **3 total attempts**.
   - **All 3 attempts fail:** abort ingestion for this file. Append to `wiki/log.md`:
     ```
     ## <ISO datetime> — ingester
     - ABORT: failed to write paper trail copy for <filename> after 3 attempts — file left in sources/_inbox/ for next run
     ```
     Leave the file in `sources/_inbox/` untouched. Do not proceed to step 3. Move on to the
     next inbox file.

   This block is a **hard gate**. No ingestion work (extraction, wiki writes, index updates)
   may begin until step 2b confirms the paper trail copy is present and non-empty.

3. **Run extraction.** For notes with image embeds (`![[...]]`), run the Image Handling
   Protocol. For URL notes, run the Link Ingestion Protocol.

4. **Create or update wiki pages.** Write the page content to `wiki/`. Rules 9 and 10 apply:
   reproduce all code character-for-character in its original language, preserve every point
   from the source, keep the writer's phrasing, and be additive rather than subtractive.

5. **[Post-write image verification.]** After writing any wiki page, immediately re-read it
   and verify that every `![[...]]` embed present in the source is also present in the wiki
   page body. If any embed is missing, insert it now (immediately after the `# Title` heading,
   per Rule 8) and re-write the page before continuing. This step is mandatory — do not skip
   it even if you are confident the embed was written correctly.

6. **Update index and log.** Update `wiki/index.md` and append to `wiki/log.md`.

7. **Move source file** to the correct `sources/<type>/` subdirectory per the categorization
   table above.

8. **Record in `processed.json`.** Only after all steps above are confirmed complete.

### Query

- Answers natural-language questions from the user.
- Reads `wiki/` to find relevant pages, follows `[[wikilinks]]`, and traces back to `sources/`
  for full context only when the wiki is insufficient.
- Always cites sources in replies: page names as `[[wikilinks]]` and source files as
  `(source: path)`.
- Never writes to the vault except the capture path (`sources/_inbox/`). Otherwise read-only.
- **Source files are reference material only.** Draw conclusions from `wiki/` pages. Trace
  back to a source file only when the wiki page is insufficient and you need the original raw
  text. Never present source file content as the primary answer — always synthesise through
  the wiki layer first.

### Linter

- Runs on a schedule (weekly is a good default), plus on demand.
- Checks: orphaned wiki pages (not linked from `wiki/index.md`), pages missing required
  frontmatter, empty `sources:` arrays, broken wikilinks, and `wiki/log.md` entries that
  reference pages that do not exist.
- Rule 8 check: flag any wiki page whose corresponding source note contained an `![[...]]`
  image embed but whose wiki page body does not. This is a lint error.
- Writes a summary to `.meta/last_lint.json` and appends a lint report to `wiki/log.md`.
- Auto-fixes unambiguous issues; reports the rest. An unambiguous fix is, for example, a page
  in `wiki/` that is missing from `wiki/index.md` — the linter adds the entry and logs it. All
  other issues (schema violations, empty sources, broken wikilinks, content contradictions)
  are reported in a `wiki/questions/` file only, never auto-fixed.

---

## Source File Rules

**Source files (`sources/`) are raw reference material. They are stored permanently but
treated as inert after ingestion.**

- **Never linted.** The linter does not audit, flag, or act on anything under `sources/`.
  Source files are entirely out of scope for the linter.
- **Never surfaced as active context.** Agents do not proactively read or index `sources/`
  files when answering questions or generating content. Source files are only accessed when
  explicitly tracing a claim back to its origin (e.g. following a wiki page's `sources:`
  frontmatter).
- **Never deleted.** After ingestion, source files are moved from `sources/_inbox/` to the
  appropriate `sources/<type>/` subdirectory and remain there permanently. No agent may
  delete a source file under any circumstance.
- **Never modified.** Agents may only move a file from `sources/_inbox/` to a subdirectory, or
  write a raw copy to `sources/written/`. The content of source files is never altered.
- If a source file is found to be missing after a `processed.json` record shows it was moved,
  this is a bug to report in `wiki/log.md` — not a lint issue.

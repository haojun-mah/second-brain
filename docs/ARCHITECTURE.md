# Architecture

How the pieces fit together, what each agent is allowed to do, and why the rules are as
strict as they are.

---

## System layers

```
┌──────────────────────────────────────────────────────────────────────────┐
│  INPUT                                                                   │
│  typed notes · URLs · screenshots · PDFs · voice memos · web clippings   │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │  you drop a file
                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  SOURCE LAYER  —  sources/                                               │
│                                                                          │
│   _inbox/     the only folder you put things in                          │
│   written/    paper trail: pre-ingestion copies of everything you typed   │
│   <type>/     permanent buckets: articles, coding, concepts, books, …     │
│   assets/     images referenced by ![[...]] embeds                       │
│                                                                          │
│  Immutable after ingestion. Never edited, never deleted, never linted.   │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │  ingester reads
                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  KNOWLEDGE LAYER  —  wiki/                                               │
│                                                                          │
│   index.md    master catalog, one row per page                           │
│   log.md      append-only history of every change                        │
│   concepts/ people/ projects/ questions/ syntheses/ articles/            │
│   coding-interview/                                                      │
│                                                                          │
│  Every page: canonical frontmatter + citations + wikilinks.              │
│  This is the layer humans and agents both read.                          │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │  build
                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  PRESENTATION LAYER  —  webpage/                                         │
│  static site: note browser · search · graph · galaxy · flashcards        │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## The storage layer — pluggable backends

The vault is *content*; where that content physically lives is a swappable detail. Every
agent talks to eight `mcp_vault_*` tools. Those tools never touch a network or a filesystem
directly — they call a `VaultBackend`, and one of three implementations answers.

```
┌───────────────────────────────────────────────────────────────────────────┐
│  AGENTS                                                                   │
│  orchestrator · query · ingester · linter · you (via the web dashboard)   │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │  call 8 tools
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  mcp_vault_* tool layer        (mcp-vault/src/tools/)                     │
│                                                                           │
│   read_note      write_note     append_note    list_directory             │
│   move_file      delete_note    search_vault   get_changes                │
│                                                                           │
│   Identical schemas and error semantics regardless of backend.            │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │  VaultBackend interface
                                    │  read · write · append · list
                                    │  move · remove · search · changes
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  BACKEND (one, chosen by VAULT_BACKEND)                                   │
│                                                                           │
│   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐           │
│   │    onedrive     │  │     github      │  │      local      │           │
│   ├─────────────────┤  ├─────────────────┤  ├─────────────────┤           │
│   │ Microsoft Graph │  │ Contents API    │  │ node:fs         │           │
│   │ OAuth refresh   │  │ Trees API       │  │ mtime cursor    │           │
│   │ /children walk  │  │ Compare API     │  │ recursive walk  │           │
│   │ delta nextLink  │  │ commit sha      │  │ path mtimes     │           │
│   └─────────────────┘  └─────────────────┘  └─────────────────┘           │
└───────────────────────────────────────────────────────────────────────────┘
```

### Why an abstraction instead of three forks

- **One set of skills.** The four `SKILL.md` files name `mcp_vault_*` tools only. Swapping
  `VAULT_BACKEND` changes where notes are stored without touching a single agent
  instruction — so a GitHub user runs byte-identical agent behaviour to an OneDrive user.
- **The contract lives above the store.** `vault-template/AGENTS.md` (layout, frontmatter
  schema, ten discipline rules) is a property of the vault, not of Microsoft or GitHub. It
  is unchanged by the backend you pick.
- **Testability.** The `local` backend has no network and no credentials, so the whole tool
  surface can be exercised in CI. It is also the fastest way to try the system before
  committing to an Azure app registration.
- **Adding a fourth store** is one file: implement the interface, register it in
  `backends/index.ts`. See CONTRIBUTING.md.

### Change detection differs per backend — and that is fine

`get_changes` returns an **opaque cursor** whose meaning is backend-specific:

| Backend | Cursor is | Meaning of "changed" |
|---|---|---|
| `onedrive` | Graph `delta` nextLink URL | Everything Graph reports as touched |
| `github` | a commit SHA | Files differing between that commit and branch HEAD |
| `local` | JSON map of `{path: mtimeMs}` | Files whose mtime advanced |

The agents treat the cursor as opaque — they store it in `.meta/delta_token.json` and hand
it straight back on the next run. No agent needs to know which backend it is talking to.

The three layers have a strict one-way dependency. Sources feed the wiki. The wiki feeds the
site. Nothing flows backward: the site never writes, the wiki never modifies a source, and
you never hand-edit the wiki.

---

## Components

### `mcp-vault` — the bridge

A [Model Context Protocol](https://modelcontextprotocol.io) server written in TypeScript.
It exposes eight tools over stdio and holds exactly one long-lived credential: your OAuth
refresh token. Every agent action against the vault passes through it.

| Tool | Signature | What it does |
|---|---|---|
| `read_note` | `(path)` | Returns `{ content, etag, last_modified }` |
| `write_note` | `(path, content, if_match?)` | Full-file write; `if_match` makes it conditional |
| `append_note` | `(path, content)` | Read-modify-write with an ETag guard |
| `list_directory` | `(path, recursive?)` | Entries with name, size, mtime, folder flag |
| `move_file` | `(from, to)` | Rename and/or relocate; destination folder must exist |
| `delete_note` | `(path)` | Permanent delete |
| `search_vault` | `(query, scope?)` | Graph full-text search, filtered to the vault root |
| `get_changes` | `(delta_token?)` | Delta feed; returns `{ changes, next_delta_token }` |

Three implementation details matter operationally:

**Token caching.** Access tokens are cached in memory and refreshed 5 minutes before expiry.
On a 401 the cache is dropped and the request retried once. Tokens are *not* shared between
processes — if you run several MCP servers against the same refresh token, they each refresh
independently, and Microsoft may invalidate one when another rotates. Keep to one running
instance per refresh token.

**Retry policy.** 429 respects `Retry-After`. 5xx gets three attempts with exponential
backoff starting at 1s. 409 is passed through untouched so callers can see the ETag conflict
rather than a masked failure.

**Path addressing.** Everything is relative to the vault root inside your drive. The server
builds `me/drive/root:/<VAULT_ROOT>/<path>:/content`. `MS_VAULT_ROOT` defaults to `Obsidian`.
Note the `:/` before the path segment and `:/content` after — getting this wrong is the most
common cause of confusing 404s when writing your own Graph calls.

### The four skills

Skills are directories of instructions plus helper scripts. Hermes loads the `SKILL.md` and
gives the model its contents as context, along with any scripts the skill references.

```
skills/second-brain-hj/           orchestrator
  SKILL.md                        routing rules + the flows that span specialists
  references/platform-patterns.md how to address Telegram/Discord, delivery quirks

skills/second-brain-query/        read-only Q&A + capture
  SKILL.md
  references/vault-navigation.md  folder map + retrieval playbook

skills/second-brain-ingester/     the workhorse
  SKILL.md                        full ingest procedure, 10 hard steps
  scripts/append_processed.py     idempotent processed.json append
  scripts/raw_copy.py             byte-verified paper-trail copy
  scripts/rotate_delta_token.py   recover from an expired delta token
  scripts/verify_index_row.py     byte-verify appended index rows
  scripts/splice_wiki.py          verbatim body splice from a `# heading`
  scripts/headless_splice.py      verbatim splice for notes with no heading
  scripts/build_imageonly_wiki.py build a page from a screenshot-only note
  scripts/fence_fix.py            label bare code fences without touching code
  scripts/fetch_lc_statement.py   canonical problem statement lookup
  references/…                    OCR cut-off shapes, interview format, etc.

skills/second-brain-linter/       weekly audit
  SKILL.md                        ten checks, auto-fix policy
  scripts/vault_byte_edit.py      byte-exact single-line edits via Graph
  references/…                    carry-forward findings, scan row format
```

---

## Agent roles

### Orchestrator — `second-brain-hj`

The front door. Receives every inbound message and decides: answer it, or hand it to a
specialist.

**Handles directly:** general conversation, coding help, simple vault reads, capture to
inbox, and the multi-step flows that don't belong to a single specialist:

- **Source re-categorisation** — auditing `sources/` and moving files to correct buckets.
  The linter's scope is `wiki/` only, so this is the orchestrator's job.
- **Note splitting** — decomposing one large multi-topic note into individual pages, merging
  into existing pages where they overlap.
- **Lost page recovery** — a broken wikilink whose target has vanished. Rebuild it from the
  source file, or from the cached image via vision, rather than deleting the link.
- **Missing-note investigation** — determining whether a note was ingested, and if not, why.

**Delegates:** full ingest runs → ingester. Full lint runs → linter. Complex Q&A → query.

The orchestrator's defining constraint is *no split responses*. When it performs a vault
operation it does the work and returns the result — no "let me check that for you"
preamble, because on a chat transport that doubles the message count for no information.

### Query — `second-brain-query`

Two modes, and it must decide which one it's in before doing anything.

**Q&A mode** is read-only. The retrieval order is deliberate:

1. Search `wiki/` for the user's terms.
2. *If search returns nothing, do not conclude nothing exists.* The Graph search index is
   unreliable for this workload — it has returned `[]` for single words that appear in
   dozens of pages. Fall back to enumerating `wiki/` with `list_directory` and matching
   against filenames, which are descriptive and Title Case.
3. Read the best candidate pages. Follow `[[wikilinks]]` outward.
4. Only if the wiki is genuinely thin, trace back to the source file.
5. Synthesise, citing every claim as `[[Page Name]]` or `(source: sources/path.md)`.

Step 4's ordering is a rule, not a preference: **source files are reference material, not
answers.** They're raw and unstructured. The wiki is the synthesised layer. Answering from
sources skips the synthesis work and produces worse answers.

**Capture mode** is the one write the query agent may perform: verbatim content into
`sources/_inbox/` with a `captured:` timestamp. No restructuring, no summarising, no
editorialising. It's a drop box.

### Ingester — `second-brain-ingester`

Polls `sources/_inbox/` and processes everything it finds. The procedure is ten steps and
the order is load-bearing; several steps are hard gates that abort rather than proceed.

```
0. Poll        list _inbox/ AND poll the delta feed
               both empty → IDLE, stop. One empty signal is not enough.

1. Read        read the file, note its etag
               classify: URL note or user-typed note

2. Paper trail (user-typed only — skip for URLs)
   2a  write raw content to sources/written/<filename>
   2b  read it back, confirm non-empty          ← HARD GATE
       fail → retry up to 3×, then ABORT and leave the file in _inbox/

3. Extract     image embeds → OCR each, substitute extracted text
               URL notes    → fetch, summarise, produce structured JSON
               neither      → continue

4. Write wiki  check existence first (list the target dir — search is unreliable)
               read a recent sibling page of the SAME class to anchor format
               write the page under Rules 9 and 10

5. Verify      re-read the page; every ![[embed]] from the source must be present
               missing → insert after the # Title heading, rewrite, log  ← MANDATORY

6. Index+log   append a canonical table row to wiki/index.md
               byte-verify the row landed on its own line
               append the log entry

7. Move        sources/_inbox/<file> → sources/<type>/<file>

8. Record      append to .meta/processed.json      ← LAST, only after 1–7 confirmed
```

Why this order:

- **Step 2 before step 3.** If the paper trail can't be written, nothing else happens. The
  raw copy is the only record of what you actually typed; losing it to a mid-run failure
  while the wiki page claims to represent it would be unrecoverable.
- **Step 5 after step 4.** Image embeds are the single most commonly dropped element. The
  page is written, then immediately re-read and checked. Not assumed — checked.
- **Step 8 last.** `processed.json` is the skip list. A file recorded as processed is never
  looked at again. Recording it before the work is confirmed done means a crash silently
  drops the file forever.

**Classification.** The destination bucket depends on content, not filename. Code appearing
in a note does not make it a coding note — the distinguishing question is context:

| Signal | Bucket |
|---|---|
| Problem statement + screenshot + solution | `sources/coding/` |
| Real interview round write-up (company, round, questions asked) | `sources/interview-experience/` |
| Course/module-specific assignment or exam prep | `sources/school-work/<module>/` |
| Language or query syntax reference | `sources/syntax/<language>/` |
| Data structure or algorithm explained on its own | `sources/concepts/` |
| Fetched URL, paper, clipping | `sources/articles/` |
| Voice transcript | `sources/voice-notes/` |
| Meeting notes, chat export | `sources/conversations/` |
| Book highlights | `sources/books/` |
| Anything else you typed | `sources/articles/` + copy in `sources/written/` |

When in doubt, the most specific bucket wins. Fall back to `articles/` only when nothing
fits.

**Concurrency.** Multiple ingester runs can overlap if one is slow. The design accounts for
it: index and log writes are appends (not read-modify-write of the whole file), the
`processed.json` helper is idempotent on the `file` key, and a `move_file` that 404s is
treated as "someone else moved it" rather than an error.

### Linter — `second-brain-linter`

Weekly, conservative, and explicitly forbidden from guessing.

Ten checks:

| # | Check | Auto-fix? |
|---|---|---|
| 1 | Orphan pages (unreachable from `index.md`) | Yes — cross-link + add to index |
| 2 | Broken wikilinks | No — file a question |
| 3 | Missing/malformed frontmatter | Partial — field order, tag shape, `related: []` |
| 4 | Uncited content (`sources: []`) | No |
| 5 | Stale pages (`updated` > 180 days) | Only with a newer page to point at |
| 6 | Overlong pages (> 4000 words) | No |
| 7 | Potential contradictions | No |
| 8 | Potential duplicates | No |
| 9 | Under-connected pages | Yes — append `## See Also` links |
| 10 | Missing image embeds (Rule 8) | No — flag as an error |

The auto-fix boundary is "could a reasonable person disagree about this?" Adding an orphaned
page to the index — no. Rewriting a sentence that looks contradictory — obviously yes, so
that becomes a question file in `wiki/questions/` and stays there until a human resolves it.

Two implementation notes that shaped the skill:

- **Strip code before scanning for wikilinks.** `[[fallthrough]]` in a C++ note and `[-10]`
  inside `[[-10]]` in a problem example both look like wikilinks to a naive regex. Fenced
  blocks and inline code must be excluded first.
- **Verify truncation against the source before filing it as a bug.** A page ending
  mid-sentence is usually a faithful copy of a source that ends mid-sentence. Rules 6 and 9
  forbid "repairing" it. The question should say the truncation is source-side and name the
  file.

---

## Data flow

### A note you typed

```
you type "Skip list: levels are randomised, expected O(log n) search"
  │
  ├─ orchestrator captures → sources/_inbox/2026-05-26-skip-list.md
  │
  └─ ingester (next run)
       ├─ reads and classifies           → concepts/
       ├─ writes paper trail             → sources/written/2026-05-26-skip-list.md  [verified]
       ├─ writes wiki page               → wiki/concepts/Skip List.md
       │    frontmatter sources: ["sources/concepts/2026-05-26-skip-list.md"]
       ├─ re-reads the page              → embed check passes (no embeds)
       ├─ appends index row              → | [[Skip List]] | concept | Randomised levels… |
       ├─ appends log entry              → ## 2026-05-26T14:32:00Z — ingester
       ├─ moves source                   → sources/concepts/2026-05-26-skip-list.md
       └─ records                        → .meta/processed.json
```

### A screenshot of a coding problem

```
you paste a LeetCode screenshot into Obsidian and save the note to _inbox/
  │
  └─ ingester
       ├─ detects ![[Pasted image 20260527203635.png]]
       ├─ downloads the image from sources/assets/ via Graph
       ├─ OCRs it locally (RapidOCR)
       ├─ detects LeetCode patterns → coding-interview path
       ├─ writes wiki/coding-interview/<Title>.md
       │    # Title
       │    ![[Pasted image 20260527203635.png]]   ← embed immediately after heading
       │    ## Problem      (from OCR)
       │    ## Examples     (from OCR)
       │    ## Constraints  (from OCR)
       │    ## Approach     (writer's own text, verbatim, if present)
       │    ## Solution     (code, character-for-character, original language)
       ├─ re-reads the page → confirms the embed survived
       └─ moves source → sources/coding/
```

The OCR step is best-effort. RapidOCR mangles superscripts (`10^5` → `105`), drops minus
signs, and truncates mid-example. The skill's guidance is: keep partial extractions verbatim,
mark the cut with `...`, never invent the remainder, and cross-check the constraints block
against a canonical statement when the OCR is ambiguous. The screenshot stays embedded in the
page precisely so the ground truth remains visible next to the imperfect extraction.

### A URL

```
you save a note containing only "https://example.com/article"
  │
  └─ ingester
       ├─ detects URL-note shape (single line, valid URL)
       ├─ fetches and summarises → { title, summary, keyPoints, tags, slug }
       ├─ writes wiki/articles/<Title>.md  with type: article and a url: field
       ├─ moves the inbox note to sources/articles/YYYY-MM-DD-<slug>.md
       │    with a url:/fetched: header prepended
       └─ records
```

Fetch failure is handled, not ignored: the note moves to
`sources/articles/YYYY-MM-DD-link-fetch-error.md` with `fetch_error: true`, a stub wiki page
is created with `tags: [fetch-error]`, and the failure is logged. Re-dropping the note retries.

---

## Frontmatter schema

Every file under `wiki/` except `index.md` and `log.md` begins with this block. Field order
is mandatory — the linter checks it.

```yaml
---
title: "Skip List"
created: "2026-05-26"
updated: "2026-05-26"
tags: [data-structures, probabilistic]
type: concept
sources: ["sources/concepts/2026-05-26-skip-list.md"]
related: ["[[Balanced Binary Search Tree]]", "[[Expected Value]]"]
---
```

Rules:

- **Order is fixed:** `title → created → updated → tags → type → sources → related`. Never
  reorder. The linter rewrites misordered blocks as a safe auto-fix.
- **Quote all strings.** `title`, `created`, `updated`, and every item in `sources` and
  `related`.
- **`title` must equal the filename** without `.md`. A mismatch is a lint question, not an
  auto-fix, because resolving it means deciding which one is wrong.
- **`created` is set once, never changed.** `updated` is today's date on every agent edit —
  including pure link additions, which is why the linter bumps it when appending `## See Also`.
- **`tags` is an inline array.** Never a bare string, never block style. `tags: []` is legal.
- **`type` is one of:** `concept`, `person`, `project`, `question`, `synthesis`, `article`,
  `coding-interview`. Bare scalar, no quotes needed.
- **`sources` is a non-empty inline array** of vault-relative paths. A page with no citation
  is a lint error. The only exceptions are `index.md`, `log.md`, and linter-generated stubs
  (`sources: ["linter-generated-stub"]`).
- **`related` is omitted entirely when empty.** Never `related: []`. When present, it's an
  inline array of quoted wikilinks.

### Naming

Wiki pages are **Title Case with spaces**: `Skip List.md`, `Attention Mechanism.md`.
Source files are **lowercase kebab-case**, with a `YYYY-MM-DD-` prefix for time-stamped
captures: `2026-05-26-skip-list.md`.

Source files are never renamed after ingestion, because `processed.json` keys on the
original filename.

### Wikilinks

`[[Page Name]]`, Title Case, matching the page title exactly. Display text only when the
visible text genuinely differs: `[[Machine Learning|ML]]`. Every page must be reachable from
`wiki/index.md` — an orphan is a lint error.

---

## The ten discipline rules

These are the contract. They exist because an LLM's default behaviour is to summarise,
reformat, translate, tidy, and delete — all of which destroy the value of a personal
knowledge base. Each rule blocks a specific failure mode.

### 1. You only ever drop files into `sources/`

The human never hand-edits `wiki/` or `.meta/`. If the linter finds wiki pages that look
human-authored, it flags them but does not overwrite.

*Blocks:* the wiki and the agents diverging, so the agent's model of the vault is wrong.

### 2. Agents only write to `wiki/` and `.meta/`

Agents never modify source file contents. The only permitted source operations are moving a
file out of `_inbox/` into its bucket, and writing a copy into `sources/written/`.

*Blocks:* an agent "fixing" a typo in your raw note, destroying the evidence of what you
actually wrote.

### 3. Every wiki claim cites at least one source file

In the frontmatter `sources:` array. A page with an empty list is a lint error. Exceptions:
`index.md`, `log.md`, linter-generated stubs.

*Blocks:* hallucinated content. If a claim can't be traced, it shouldn't be in the wiki.

### 4. Agents never delete wiki pages

To retire a page, add `stale: true` and a callout at the top:
`> **Note:** This page has been superseded by [[New Page Name]].` The page stays.

*Blocks:* an agent deciding your note is redundant and removing it. Organisation is the
human's call; the agent's job is to record.

### 5. Every change to `wiki/` is recorded in `wiki/log.md`

Append-only. One entry per run:

```
## 2026-05-26T14:32:00Z — ingester
- Created wiki/concepts/Skip List.md (source: sources/concepts/2026-05-26-skip-list.md)
- Updated wiki/index.md (added entry: Skip List)
```

*Blocks:* untraceable drift. Six months later you can still see when and why a page changed.

### 6. No hallucinating source content

If the source file isn't readable, stop and report the error in the log rather than
producing wiki content from memory.

*Blocks:* the model filling a gap with plausible-sounding invention.

### 7. `processed.json` only records fully-completed work

A partial run must be retried. Only append the record after the wiki write and the log entry
are confirmed.

*Blocks:* silent data loss — a file marked done that was never actually ingested.

### 8. Screenshot embeds are never dropped

If the source has `![[...]]`, the wiki page has it, placed immediately after the `# Title`
heading. On initial ingestion, on re-ingestion, on any later edit by any agent.

*Blocks:* the most common quiet regression. Text survives summarisation; embeds don't. And
for a coding problem the screenshot often *is* the problem statement.

### 9. Code is immutable — including its language

Never reformatted, corrected, or converted. C++ stays C++, Python stays Python, Java stays
Java. Character-for-character, including the language identifier on the fence. Deliberately
wrong code stays wrong — those are the learning points. An agent that believes code is
incorrect may add a note *below* the block, never inside it.

*Blocks:* the single most destructive thing an LLM does to a technical note. "Let me rewrite
this in idiomatic Python" destroys the original solution the author was studying.

### 10. Preserve the writer's voice and intent

- **Never delete points.** Summarising is fine; removing is not.
- **Preserve voice.** Don't convert casual or personal writing into neutral academic prose.
  Keep the writer's phrasing. Fix grammar, don't "improve" style.
- **Be additive.** When refining, add context, links, structure. Default to keeping
  everything; shorten only genuine redundancy.

*Blocks:* a knowledge base that gradually becomes a bland summary of itself — accurate,
well-organised, and useless, because everything that made it *yours* has been smoothed away.

---

## Why source files are immutable

Sources are the ground truth. The wiki is an interpretation of them, produced by a model that
can be wrong. If sources could be edited, that distinction collapses: a bad wiki page could
"correct" its own source, and there would be no way to tell what you originally wrote from
what an agent decided you meant.

Keeping sources frozen gives you three things:

**Recoverability.** Every wiki page can be rebuilt from its source. If an agent corrupts a
page, delete the page, remove the `processed.json` record, and re-run the ingester. The
original note is untouched.

**Auditability.** The `sources:` array is a real citation, not a decoration. You can read a
claim, follow the path, and see the exact passage it came from — including the parts the
agent chose not to include.

**A paper trail of your own thinking.** `sources/written/` holds the pre-ingestion form of
everything you typed. Six months later, when a wiki page reads more polished than you
remember writing, you can see what you actually said.

This is also why `sources/` is out of scope for the linter. The linter audits the wiki — the
derived layer, where agent mistakes live. Sources aren't agent output; auditing them would
mean treating your own notes as errors to be fixed.

---

## Failure modes and how the design handles them

| Failure | Mitigation |
|---|---|
| Graph search returns nothing for content that exists | Agents fall back to directory listing + filename matching. Empty search is never treated as proof of absence. |
| Delta feed misses a new file | The listing is polled too, and results are unioned. Both empty is required for IDLE. |
| Folder listing is stale for hours | The delta feed runs alongside it. The two signals must *both* be empty. |
| Access token invalidated mid-run by a concurrent refresh | Helper scripts fetch a fresh token per request rather than caching one across a batch. |
| `move_file` 404 — file already moved by a concurrent run | Treated as success-by-another-path: log it, fix the wiki page's citations to the real location, record the actual path. |
| Move target folder doesn't exist | Write a `.keep` placeholder into the target (auto-creates nested folders), move, delete the placeholder. |
| ETag conflict on write | Retry with a fresh etag; if it persists and the write is a pure frontmatter fix holding full current content, write unguarded rather than silently skipping. |
| OCR truncates mid-problem | Keep the partial text verbatim, mark with `...`, keep the screenshot embedded. Never invent the remainder. |
| Wiki page truncated mid-sentence | Check the source first. If the source is truncated too, the page is a faithful copy — file it as source-side, don't repair it. |
| Cron job silently failing | `enabled: true` doesn't mean working. Check `last_status`, not just `state`. |

---

## Extending the system

**A new source bucket.** Add the folder, add the row to the categorisation table in
`sources/AGENTS.md`, add a matching row to the ingester's categorisation table. If the new
bucket is ambiguous against an existing one, add a disambiguation paragraph — the agent
resolves ties by reading that text, so vagueness costs you misclassified notes.

**A new wiki type.** Add it to the `type` enum in `AGENTS.md` *and* to the linter's enum
check, or every page using it will be flagged as a schema violation.

**A new agent.** Copy an existing skill directory, write `SKILL.md` with frontmatter
(`name`, `description`, `version`, `tags`), and register it with a cron job if it's
scheduled. Keep its write permissions as narrow as you can — the query agent is read-only
except for the inbox, and that constraint is what makes it safe to point at any question.

**A different storage backend.** The MCP server is the only component that knows about
OneDrive. Implement the same eight tools against S3, Dropbox, or a local directory and the
skills work unchanged. That's the point of the boundary.

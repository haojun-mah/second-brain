# Vault Navigation

Folder map and retrieval playbook for the query agent. Load this when a search comes back
empty or thin, or when you need to know where a class of note lives.

---

## Folder map

| Path | Contents | Look here for |
|---|---|---|
| `wiki/concepts/` | One file per concept — algorithms, data structures, techniques, principles | "What is X", "how does X work" |
| `wiki/coding-interview/` | Programming problems AND interview round write-ups. Usually the largest folder | Any algorithm question, any "how did I solve X" question |
| `wiki/articles/` | Ingested web articles and external content | "That article about…", external references |
| `wiki/people/` | One file per person | "What do I know about <name>" |
| `wiki/projects/` | Active project pages | "Status of <project>" |
| `wiki/syntheses/` | Cross-cutting summaries that draw on several concepts | "How do X and Y relate", big-picture questions |
| `wiki/questions/` | Open questions, contradictions, unresolved ambiguities | "What's still unclear about…" |
| `wiki/index.md` | Master catalog — one row per page with a one-line summary | Fast topic scan; the authoritative page list |
| `wiki/log.md` | Append-only change history | "When did I learn about X", provenance |

`sources/` mirrors these by content type (`articles/`, `coding/`, `concepts/`, `books/`,
`voice-notes/`, `conversations/`, `interview-experience/`, `school-work/`, `syntax/`,
`drafts/`). Sources are raw material — read them only to verify a claim, never as the primary
answer.

---

## Retrieval playbook

### Search first, but don't trust it

`mcp_vault_search_vault(query, scope="wiki")` is the fast path. It is also unreliable: the
underlying index has returned `[]` for single common words that appear in dozens of pages. An
empty result means "the index didn't match", not "the vault doesn't have it".

### Fall back to enumeration

```
list_directory("wiki")                        → subfolder names
list_directory("wiki/coding-interview")       → every filename in that folder
```

Filenames here are descriptive and Title Case. Reading the file list and pattern-matching
against the owner's keywords is often faster and more reliable than search.

### Map the question to the note's likely title

The owner asks in their own words; notes are titled after the subject. Bridge the two:

| Owner says | Note is probably titled |
|---|---|
| "the path where the worst edge is as small as possible" | minimax / bottleneck path — titled after the specific problem |
| "the thing where you keep a window and shrink it" | Sliding Window |
| "how do I make the cache forget old stuff" | LRU Cache, eviction policy |
| "that trick where you sort by end time" | Interval Scheduling, Greedy |

Search the *idea*; read the *filename*.

### Widen deliberately

If one search and one listing turn up nothing, try:

1. A synonym or the formal term (owner says "cycle detection" → note says "Floyd's Algorithm").
2. The broader category (`list_directory` on the plausible subfolder, scan for adjacent titles).
3. `wiki/index.md`, whose summary column often carries the phrasing the title doesn't.

Only after all three should you tell the owner the vault doesn't cover it.

---

## Answer construction

1. Lead with the direct answer — one or two sentences.
2. Support it with the specifics from the pages you read, cited inline.
3. Link related pages so the owner can keep reading: `[[Related Page]]`.
4. If pages disagree, say so and cite both. Do not silently pick a winner — that's what
   `wiki/questions/` is for.
5. If the answer required reading a source file because the wiki was thin, mention that the
   wiki page could use expanding.

Never pad. A three-line answer with two citations beats a page of hedging.

# Contributing

Thanks for wanting to help. This is a small system with a strong opinion about data safety,
so a few conventions matter more here than in a typical project.

---

## Ground rules

**Never break the discipline rules.** They're documented in
[vault-template/AGENTS.md](vault-template/AGENTS.md) and explained in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#the-ten-discipline-rules). Any change that would
let an agent reformat code, drop an image embed, delete a page, or write outside
`wiki/` and `.meta/` will be rejected regardless of how convenient it is.

**No secrets, no personal data, in any commit.** Before you push:

```bash
git grep -InE "clsk_|gho_|ghp_|sk-[A-Za-z0-9]{20}|M\.C5[A-Za-z0-9]|Bearer [A-Za-z0-9]{20}" || echo clean
git grep -InE "refresh_token=|password=|api_key=" -- ':!*.md' ':!.env.example' || echo clean
```

If you find a credential in the repo — including in old commits — open an issue rather than
a PR, so it can be revoked before the details are public.

**Test against a scratch vault.** Never develop against your real notes. Create a second
OneDrive folder, or point `MS_VAULT_ROOT` at a test directory, and break that instead.

---

## Setting up to develop

```bash
git clone https://github.com/YOUR-USERNAME/second-brain.git
cd second-brain

# MCP server
cd mcp-onedrive && npm install && npm run typecheck && npm run build && cd ..

# Web dashboard
cd webpage && npm install && cd ..

# Helper scripts
python3 -m venv .venv && . .venv/bin/activate
pip install rapidocr-onnxruntime   # only if you're touching OCR
```

You'll need a working `.env` to exercise anything end-to-end. See
[docs/SETUP.md](docs/SETUP.md).

---

## Adding a skill

A skill is a directory under `skills/` with a `SKILL.md` and optional subdirectories.

### Structure

```
skills/second-brain-<name>/
├── SKILL.md              required
├── scripts/              optional — executable helpers
└── references/           optional — long-form docs the model reads on demand
```

### `SKILL.md` format

```markdown
---
name: second-brain-<name>
description: One sentence. This is what the model sees when choosing a skill, so lead
  with the trigger condition, not the implementation.
version: 1.0.0
tags: [second-brain, <domain>]
---

# <Human-Readable Title>

You are the <role> for a personal second-brain system.

**CRITICAL: Read `AGENTS.md` at the vault root at the start of every session.**
It defines the layout, schema, and discipline rules that override anything below.

## Vault Access
<List the mcp_onedrive_* tools you use and nothing else. Narrow permissions are a feature.>

## <Your main flow>
<Numbered steps. Be explicit about ordering when order matters.>

## Hard Rules
<What this agent must never do.>
```

### Guidelines

- **Declare the narrowest tool set you can.** A read-only agent that only calls
  `read_note`, `list_directory`, and `search_vault` cannot corrupt the vault, no matter what
  the model decides to do. That's worth more than any instruction.
- **Say when *not* to act.** Most agent failures are over-eagerness, not under-eagerness.
  "If the search returns nothing, do not conclude the page is absent" is more valuable than
  another paragraph on how to search.
- **Number the steps and mark the gates.** If step 3 must complete before step 4, say so and
  say why. Agents follow rules with reasons far better than rules without.
- **Put long material in `references/`.** The SKILL.md is loaded on every invocation; a
  300-line appendix of edge cases belongs in a reference file the model opens only when it
  needs it.
- **Give each rule a failure it prevents.** "Never use `write_file` on vault paths" is
  forgettable. "Never use `write_file` on vault paths — it resolves against the local
  filesystem and will silently write to the wrong place while reporting success" is not.

### Register it

If it's scheduled, add a cron job (see
[SETUP.md step 7](docs/SETUP.md#7-schedule-the-agents)). If it's invoked on demand, the
orchestrator needs to know it exists — add a row to its routing table.

---

## Modifying the ingester

The ingester is the highest-risk component: it writes to the wiki and moves source files. Be
careful.

### The order is load-bearing

```
read → classify → paper trail (verified) → extract → write wiki
     → verify embeds → index + log → move source → record in processed.json
```

Three properties depend on this sequence, and breaking any of them causes silent data loss:

1. **Paper trail before any wiki work.** If `sources/written/` can't be written, the run must
   abort with the file still in `_inbox/`. Writing the wiki page first means a failed run
   leaves a page claiming to represent a note whose original you no longer have.
2. **Embed verification after the write.** Never assume the embed survived. Re-read the page
   and check for every `![[...]]` from the source.
3. **`processed.json` last.** It's the skip list. A file recorded there is never looked at
   again, so recording before completion means permanent silent loss.

### Adding a classification bucket

Three places, all of them required:

1. The layout tree in `vault-template/AGENTS.md`.
2. The categorisation table in `vault-template/AGENTS.md`.
3. The categorisation table in `skills/second-brain-ingester/SKILL.md`.

If the new bucket overlaps an existing one, add a **disambiguation paragraph** — a short
prose rule that tells the agent how to break the tie. The agent resolves ambiguity by reading
that text, so a vague rule produces inconsistent classification. The existing
`coding/` vs `concepts/` vs `syntax/` distinction is the model to follow: it states plainly
that the test is *context*, not the presence of code.

### Testing a change

Use a scratch vault with a handful of representative files:

```
test-vault/sources/_inbox/
├── 2026-01-01-typed-note.md          # plain prose, should land in articles/ + written/
├── 2026-01-01-screenshot.md          # contains ![[test.png]] → exercises OCR + embed check
├── 2026-01-01-url.md                 # a single URL line → exercises link ingestion
└── 2026-01-01-code.md                # C++ fenced block → must survive byte-for-byte
```

Then, after a run, verify by hand:

```bash
# the raw copy exists and matches
diff <(cat sources/_inbox/*.md) <(cat sources/written/*.md)   # should differ only by moves

# every embed from the source appears in the page
grep -o '!\[\[[^]]*\]\]' sources/<bucket>/*.md    # compare against the wiki page

# code is byte-identical
python3 - <<'EOF'
import re, pathlib, sys
src = pathlib.Path("sources/coding/2026-01-01-code.md").read_text()
page = pathlib.Path("wiki/coding-interview/Test.md").read_text()
blocks = re.findall(r"```(\w*)\n(.*?)```", src, re.S)
for lang, code in blocks:
    if code not in page:
        sys.exit(f"code block drifted (lang={lang})")
print("code OK")
EOF

# bookkeeping is consistent
python3 -c "import json;print(len(json.load(open('.meta/processed.json'))['processed']))"
tail -5 wiki/log.md
```

The most useful failure to test for is the one where everything reports success and the
content is silently wrong. That's why the shipped helpers byte-verify rather than trust a
200 response.

---

## Changing the MCP server

```bash
cd mcp-onedrive
npm run typecheck    # must pass
npm run build
```

Two invariants:

- **Tool names and signatures are a public API.** The skills call `read_note`,
  `write_note`, `append_note`, `list_directory`, `move_file`, `delete_note`, `search_vault`,
  and `get_changes` by name. Renaming one breaks every skill. Add tools freely; change
  existing ones only with a very good reason, and update all four skills in the same PR.
- **Never log credentials.** `console.error` output goes to the Hermes logs. Errors from
  Graph can echo request details — check what you're printing before you print it.

Adding a tool:

```typescript
// src/tools/files.ts — append to the registerTools([...]) array
{
  tool: {
    name: 'get_metadata',
    description: 'Get size and modification time for a note',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Vault-relative path' } },
      required: ['path'],
    },
  },
  handler: async (args) => {
    const res = await graphFetch(vaultMetaPath(args['path'] as string));
    if (!res.ok) return { content: [{ type: 'text', text: `Error ${res.status}` }] };
    const data = await res.json();
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  },
} satisfies McpToolDefinition,
```

Then `npm run typecheck && npm run build`, restart Hermes, and `hermes mcp list` should show
nine tools.

---

## Documentation changes

Docs live in `docs/` plus the per-component READMEs. Two rules:

- **Show the command, not just the concept.** "Configure your env" is useless; `cp .env.example
  .env && chmod 600 .env` is not.
- **Document what actually happens.** If the code retries three times with backoff, say three
  times with backoff. Docs that describe an idealised version of the system are worse than no
  docs, because they're trusted.

---

## Pull requests

- One logical change per PR. A skill fix and an MCP server refactor are two PRs.
- Say what you tested and how. "Ran the ingester against a 4-file scratch vault; verified
  embed survival, code byte-identity, and processed.json count" is the kind of detail that
  makes a PR reviewable.
- If you changed agent behaviour, include the before/after of an actual run.
- If your change touches the discipline rules, open an issue first. Those aren't negotiable
  in a PR.

## Reporting bugs

Include:

- What you expected, what happened.
- The agent's output, with any credentials redacted.
- Which component (`mcp-onedrive`, a specific skill, `webpage`, a script).
- Your Hermes version and Node/Python versions.

If the bug is "the agent did something destructive to my vault", say so in the title. Those
get looked at first.

## License

By contributing you agree your work is licensed under the MIT License (see
[LICENSE](LICENSE)).

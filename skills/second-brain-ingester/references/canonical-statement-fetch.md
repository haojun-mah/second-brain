# Fetching a Canonical Problem Statement

Screenshots get mangled. When a constraint block is ambiguous — a bound whose sign is unclear, a
superscript that might be `105` or `10^5` — the cheapest fix is to fetch the canonical statement
and compare.

`scripts/fetch_lc_statement.py` does this for programming problems, with no API key and no
browser automation.

---

## Why not just scrape the site

The problem site blocks automated requests: a plain fetch returns a ~6KB bot-block page, and
several mirror routes are Cloudflare-challenged. Wayback captures work sometimes but are slow
and inconsistent.

What does work reliably: a static mirror that renders the statement as plain HTML. The script
tries a small set of those, strips the HTML to readable text, and returns it.

---

## Usage

```bash
python3 scripts/fetch_lc_statement.py 493
python3 scripts/fetch_lc_statement.py 493 --json     # structured: title, difficulty, statement, examples, constraints
python3 scripts/fetch_lc_statement.py --url https://example.com/problem
```

Output is plain text by default — statement, examples, constraints — suitable for diffing
against the OCR output.

---

## When to use it

| Situation | Use the fetch? |
|---|---|
| Constraint block is garbled or has a suspicious sign | **Yes** — this is the main case |
| Extraction truncated before the constraints | Yes |
| Example data is entirely missing and prose matches canonical | Yes — confirms version, licenses the fill |
| Extraction is complete and legible, prose self-consistent | Yes, cheaply — one call confirms number and difficulty |
| Screen shows a reworded statement | Yes, but only to identify which sections are version-invariant |

One call per problem. It is faster than reasoning about glyph probabilities and it cannot be
wrong about the canonical text.

---

## What it can't tell you

**It cannot tell you which version the screenshot shows.** That's the version gate in
`ocr-cutoff-and-version-gate.md` §3, and it requires comparing the screen's text against the
fetched canonical text.

**It is a mirror, not the authority.** Mirrors can lag or carry a reformatted rendering. If the
fetched text contradicts the screenshot on a substantive point and the screen's version is
internally self-consistent, the screenshot wins — it's the writer's ground truth (Rule 10).

**It only covers this one problem source.** For a problem from a different platform, or a
company-specific question, there's no canonical to fetch. Keep the OCR verbatim, mark the
cut-off, and rely on the embed.

---

## Logging

Any value taken from canonical rather than from the extraction gets a line in `wiki/log.md`:

```
- Normalised constraint bound from canonical: `231 <= nums[i]` → `-2^31 <= nums[i] <= 2^31 - 1`
  (OCR dropped the minus sign; canonical statement confirms the negative lower bound)
```

This matters because the page now contains a fact that isn't in its embedded screenshot. Six
months later, the log is how you know where it came from.

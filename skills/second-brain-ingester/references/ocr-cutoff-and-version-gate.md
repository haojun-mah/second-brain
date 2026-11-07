# OCR Cut-Off Shapes and the Version Gate

What RapidOCR actually does to a screenshot of a problem statement, and how to decide what to
fill from a canonical source versus what to keep verbatim.

The governing principle: **the screenshot is the writer's ground truth (Rule 10), and the embed
stays in the page (Rule 8) so it remains visible next to the extraction.** OCR output is a
convenience layer, not the authority.

---

## 1. Truncation shapes

Extraction can stop at any point, and **exit code 0 does not mean complete**.

### 1.1 Clean stop before a section

Extraction ends after the last complete line of one section, with no trace of the next.
Example: ends at the last constraint bullet of `## Constraints`.

**Handling:** the sections present are complete. Fill the missing section from canonical only
if the version gate (§3) permits.

### 1.2 Stop mid-sentence

Extraction ends inside a sentence — `Input: n = 6, connections = [[0,1], [1,3],`.

**Handling:** keep the partial line verbatim, add the cut-off marker:

```
... (screenshot extraction cut off here — see the embedded image for the remainder)
```

Never complete the sentence from memory. The embed shows the rest.

### 1.3 Stop mid-section, leaving a damaged fragment

The most dangerous shape, because a naive "is this section present?" check **passes**:
extraction reaches `## Constraints`, emits exactly one partial line (itself doubly damaged —
`length` read as `lenqth`, `10^5` read as `105`), then dies into page chrome.

**Handling:**
- A section is complete only when its **full expected shape** is present — for Constraints, the
  whole list, not a first line. When unsure, fetch canonical and compare bullet counts.
- When filling a truncated section from canonical, **replace the fragment, never append beneath
  it.** Keeping the misspelled line and adding three canonical bullets leaves a duplicate
  wrong bound that no linter will catch.

### 1.4 Stop inside an example, before any example data

Extraction ends right after `Example 1:` or after its `Input:` line. There is no visible
example data to compare against canonical, so the normal version gate (§3.1) is unavailable.

**Handling:** run the gate on the **statement prose** instead (§3.2).

---

## 2. Chrome leakage

At the truncation boundary, and sometimes at the start, RapidOCR picks up the page's own
furniture.

Observed forms:

- like and comment counters: `2.5K`, `D124`, `10K156` (two counts fused)
- icon rows: `☆`, `?`
- the online pill: `·●1 0nline`, `·26 Online`
- the wordmark: `1UH O`, `4UH O`
- labels: `Solved`, `Medium`, `Hard`, `Companies`
- the page-progress counter: `1/6`
- the language-selector badge: `Pyt` (truncated `Python3`)
- promo interstitials: garbled sentences that read like real prose, e.g.
  `Coon thic alloctinn in a real intonviow hofnro?`

**The promo line is the dangerous one** — unlike a counter, it reads like a sentence and can
slip into `## Problem`.

**Test:** does the line carry a variable name, number, or clause that the rest of the statement
references? If not, it's furniture. Drop it.

**Chrome also leads, not just trails.** A common failure is scanning only the last lines. Strip
from both ends, and read the problem number from the `NNN. <Title>` line itself rather than the
first non-empty line — the first line is often the language badge or wordmark.

---

## 3. The version gate

Before filling any section from a canonical source, decide whether the screenshot is the
**current** version of the statement or an older/reworded variant. Splicing canonical
examples into a page whose screen shows different ones creates a page that contradicts its own
embedded ground truth.

### 3.1 Normal gate — visible examples exist

Compare the screen's example inputs/outputs against canonical.

- **Match** → same version. Fill missing sections from canonical.
- **Differ, and the screen's examples are internally self-consistent** (recompute the outputs
  to check) → older version. **Keep the screen's examples verbatim** with their cut-off marker.
  Fill only version-invariant facts, usually just Constraints.
- **Differ, and the screen's examples are internally inconsistent** → likely OCR damage, not a
  version difference. Recover only what's deterministic from the extraction itself; otherwise
  keep verbatim and flag it.

### 3.2 Fallback gate — no visible example data

When truncation removed all example data, gate on the **statement prose**: fetch canonical and
compare the screen's visible statement sentences character by character.

- **Verbatim match** (down to a distinctive clause like "where |val| denotes the absolute value
  of val") → the screenshot is the current version, so its invisible examples and constraints
  are that version's fixed facts. Fill them from canonical and log it.
- **Diverging wording** → reworded variant. Keep the screen's statement text verbatim and fill
  only version-invariant facts.

### 3.3 Legible but reworded

A third case, distinct from cut-off and from garbling: the screen carries a **complete, legible,
non-canonical** statement. Someone paraphrased it, or it's a contest variant with a custom
header.

**Do not swap the legible text for canonical wording.** The screenshot is the writer's ground
truth (Rule 10). Keep it verbatim under `## Problem` and fill only genuinely absent sections.
Log which part came from canonical.

The variant can extend to example **data**, not just wording: an older statement whose examples
are arithmetically self-consistent but numerically different from the current canonical ones.
Verify self-consistency, keep them verbatim, and fill only Constraints.

---

## 4. Glyph-level misreads

Predictable, and worth knowing so you don't over-correct.

| OCR reads | Actual | Confidence |
|---|---|---|
| `105` | `10^5` | High when the same bound appears twice |
| `0utput` | `Output` | High (zero for O) |
| `231` | `2^31` | High in a numeric-bound context |
| `nums [i]` | `nums[i]` | High (spacing artifact) |
| `0 c= nums [i] = 100` | `0 <= nums[i] <= 100` | High when a chained relation loses both operators |
| `nums.lenqth` | `nums.length` | High (`q` for `g`) |
| a lower bound that looks absurdly positive, e.g. `231 <= nums[i]` for an int array | a negative bound whose minus sign was dropped | **Do not guess** — fetch canonical |

**Normalise only when the pattern is unambiguous.** Two occurrences of the same bound reading
`105` in a context where `10^5` is the only sensible value is a consistent superscript misread.
A single suspicious value with no corroboration should be kept verbatim.

**A dropped minus sign is the worst case**, because it silently changes the problem's domain and
is not recoverable from the extraction — no other line carries the sign. Never restore a sign
from intuition. Fetch the canonical statement and settle it there.

---

## 5. Procedure

For every screenshot-based problem note:

1. **OCR.** `python3 scripts/vault_ocr.py "sources/assets/<image>"`
2. **Strip chrome** from both ends using the referenced-later test.
3. **Identify the problem number** from the `NNN. <Title>` line if present; otherwise search a
   distinctive phrase to find it.
4. **Fetch canonical** and diff the constraint block — the one place OCR reliably loses
   information. This one call doubles as confirmation of the problem number and difficulty.
5. **Apply the version gate** (§3) to decide what may be filled.
6. **Build the page** with `scripts/build_imageonly_wiki.py`, passing the OCR text for
   Problem/Examples/Constraints and letting it splice the writer's content verbatim.
7. **Log every normalisation** in `wiki/log.md`, naming the value and its canonical form.

Step 4 is cheap and catches the errors that matter. Skip it only when the extraction is
trivially short and complete.

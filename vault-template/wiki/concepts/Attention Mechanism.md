---
title: "Attention Mechanism"
created: "2026-01-01"
updated: "2026-01-01"
tags: [machine-learning, transformers, example]
type: concept
sources: ["sources/articles/example-attention.md"]
---

# Attention Mechanism

> **This is a scaffold example.** It exists so the first run of the dashboard and the linter
> have a valid, schema-conforming page to read. Delete it — along with its source file and its
> row in `wiki/index.md` — once you have real content.

Attention lets a model weigh different parts of its input when producing each part of its
output, instead of compressing everything into one fixed-size vector. The weights are learned,
not fixed, which is what separates it from a simple average (source: sources/articles/example-attention.md).

## How it works

Each token produces three vectors — a **query**, a **key**, and a **value**. The score between
two tokens is the dot product of one's query with the other's key. Scores are scaled, passed
through a softmax to become weights, and used to take a weighted sum of the values.

Scaling by `1/sqrt(d_k)` matters: without it, dot products grow with dimension, the softmax
saturates, and gradients vanish.

## Why it replaced recurrence

A recurrent layer must process a sequence one step at a time — the hidden state at position
`n` depends on position `n-1`. Attention has no such dependency: every position can be
computed in parallel. That's the entire reason transformers train so much faster on modern
hardware, and why they scaled to sizes recurrence never reached.

## See Also

- [[Example Article]] — the scaffold article page, showing `type: article` frontmatter

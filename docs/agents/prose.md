# Prose Style

How agents write durable prose in this repo: doc comments, module headers, and everything under `docs/`.

## The rule

Write plain prose: state each claim literally, so a first-time reader gets the meaning in one pass, with nothing to decode. The house voice is literate — comments state a module's contract and its reasoning — and plainness is what keeps that voice a spec rather than an essay.

## Vocabulary

- Domain words come from `CONTEXT.md`. They are free: defined once, used everywhere.
- Standard terms of art (invariant, seam, idempotent, contravariant) are welcome; on first use in a file, unpack the term in a clause — "a seam: a swap point where tests plug in a fake."
- A coinage that would need its own definition belongs in `CONTEXT.md` first; until it is there, write the plain phrase.

## Metaphor

A metaphor may introduce an idea only when the same passage also states the idea literally — the literal statement is the load-bearing half, the metaphor is garnish. When a second metaphor arrives to help the first, that is the signal to rewrite the passage plainly; stacked metaphors are this repo's known failure mode.

## Anchored example

Before (real, since rewritten): "…is the densest knot of invariants in the package, and its tests should be able to stand on a seam instead of a database."

After: "…upholds more always-true rules in one place than anything else in the package, and testing those rules means staging precise situations — an expired lease, a takeover mid-run — that should not require a running database."

The after version is longer and better: it hands the reader the meaning instead of a puzzle.

## Review criterion

A comment or doc passes when every sentence survives the one-pass test: read it once, cold; if the meaning needs a second read or a translation, rewrite it literally. A sweep is done when every sentence it touched passes, not only the sentence that was flagged.

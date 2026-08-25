# Mission: The Affordance implementation

## Why
The framework was implemented largely through LLM sessions, so the concepts are familiar but the code itself is not. The goal is to own the implementation: to review, extend, and debug this codebase confidently without an LLM as intermediary, and to judge future LLM-written changes against the codebase's own idioms.

## Success looks like
- Can name which package and module any given behavior lives in, without searching.
- Can walk the execution lifecycle (claim → run → commit) from memory and explain why each phase is shaped the way it is.
- Can trace one request end-to-end: HTTP route → engine facade → guard evaluation → lifecycle → Postgres.
- Can spot when a proposed change violates one of the codebase's recurring idioms (one-walk/filters, lenient-loud pairs, erasure at the authoring boundary, the lifecycle port).

## Constraints
- Content readability is the priority: complete prose, real code excerpts with file paths, no compressed fragment-speak.
- Start with an implementation overview, then drill into each major section with plenty of code.

## Out of scope
- Concept-level material (what an affordance is, why no position) — already understood; the deleted first tutorial covered it and is not to be rebuilt.
- The React console UI internals, unless explicitly requested.
- TypeScript-the-language instruction.

# Teaching notes

## User preferences (stated 2026-08-24, at workspace creation)

- Already understands the concepts and general approach; wants the *implementation*: how the code is actually organized and written.
- Motivation: the code was mostly LLM-written, so it hasn't passed through their hands. Teach for ownership and review ability.
- Requested order: implementation overview first, then drill into each major section.
- Wants "plenty of code" in lessons — real excerpts from the repo, with file paths.
- Explicitly prioritizes readability of content: complete prose, not fragments.
- The previous tutorial (deleted from git) is to be ignored — do not rebuild concept lessons.

## Course plan — all eight lessons written (see index.html)

1. **0001 — The shape of the implementation.** Package map, core's subsystems, one end-to-end trace, the idioms.
2. **0002 — Guards: one walk, one answer.** Condition contract, algebra, `guardEntries`, evaluation, derived views, time.
3. **0003 — The execution lifecycle.** The port, claim takeover, retry loop, commit holder check, journal, replay.
4. **0004 — The model layer.** `stepsOf` type machinery, erasure boundary, `selectTargets`/`addressTarget` and filters.
5. **0005 — The store and the pure core.** Queryable seam, loud/lenient resolve, bootstrap, `computeAffordances`.
6. **0006 — Ingestion and migration.** Correlation-in-commit, dedup gate, dead letters as projected codes, journal-marked sweep.
7. **0007 — The HTTP adapter.** Framework-agnostic router, codes→statuses, one route grammar, the audience rule.
8. **0008 — The reference app.** State with no position, the close guard, mock providers, wiring, dev-console leaks.

Possible follow-ups if asked: the React console, the test harnesses (memory port, pg fixtures), @affordance/contract in detail.

Quizzes not yet attempted by the user — no learning records until there is evidence.

## Conventions in this workspace

- User wants pages self-contained (inline styles). Author lessons with `<link>`/`<script src>` tags to `../assets/`, then run `node docs/tutorial/inline-assets.mjs` to embed the assets in place before delivering. Assets in `assets/` remain the source of truth; to restyle an already-inlined page, restore the tags and re-run.
- Glossary = `CONTEXT.md` at repo root; don't duplicate it in `reference/`.
- No line counts, sizes, or dates-of-writing in lessons or reference docs (they age).

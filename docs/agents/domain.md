# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo uses the **single-context** layout: one `CONTEXT.md` and one `docs/architecture.md` at the root.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/architecture.md`** — the architecture and the reasoning behind it. Read the sections that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (most repos, including this one):

```
/
├── CONTEXT.md
├── docs/
│   └── architecture.md        ← the design and its reasoning
└── src/
```

Multi-context repo (presence of `CONTEXT-MAP.md` at the root):

```
/
├── CONTEXT-MAP.md
├── docs/architecture.md               ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/architecture.md       ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/architecture.md
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag conflicts with the architecture

If your output contradicts `docs/architecture.md`, surface it explicitly rather than silently overriding:

> _Contradicts the rule that time enters guards only via declared combinators — but worth reopening because…_

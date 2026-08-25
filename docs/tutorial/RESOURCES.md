# Affordance Implementation Resources

The topic is this repository itself, so the highest-trust sources are in-repo. External sources matter only for the standards the code builds on.

## Knowledge

- [docs/architecture.md](../architecture.md)
  The design rationale, written by the project. Use for: why any mechanism exists (no position, lenient/loud, the lifecycle shape). The primary source for every lesson.
- [CONTEXT.md](../../CONTEXT.md)
  The project's own glossary — definitions only. Use for: exact meaning of Case, Step, Guard, Affordance, Refusal, etc. This is the course glossary; lessons adhere to it rather than duplicating it.
- `packages/core/src/**` module headers
  Every module opens with a literate doc comment stating its contract. Use for: the authoritative statement of what a module owes its callers.
- `packages/core/test/**`
  Executable documentation. The execution lifecycle's tests run against an in-memory port (`test/execution/memory-port.ts`) — the clearest picture of lifecycle semantics without a database.
- [Standard Schema spec](https://standardschema.dev)
  The validation interface (`@standard-schema/spec`) that `state` and `input` schemas conform to. Use for: what `~standard.validate` promises.
- [JSON Patch — RFC 6902](https://datatracker.ietf.org/doc/html/rfc6902)
  The delta format journaled by every execution. Use for: reading `delta` entries.

## Wisdom (Communities)

- None applicable: this is a self-authored codebase, so "the community" is the repo's own issue files under `.scratch/` and future code review. Revisit if the project goes public.

## Gaps

- No external writing exists about this framework; all claims must be grounded in the repo itself.

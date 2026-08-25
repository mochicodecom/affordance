/**
 * The header names every contract request carries the persona in. The
 * server declares the same pair (`ACTOR_HEADERS` in its wiring) and this
 * project cannot import server code, so the server's shadow-table test pins
 * this copy against its own. The pin imports this module directly, so it
 * must stay a leaf with no imports of its own — the server's typecheck
 * cannot resolve this workspace's dependencies.
 */
export const ACTOR_HEADERS = {
  id: 'x-actor-id',
  roles: 'x-actor-roles',
} as const

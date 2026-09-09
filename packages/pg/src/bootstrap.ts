import type { Queryable } from './queryable.js'

/**
 * Dedicated Postgres schema owning all framework tables.
 * Named `affordance` because `case` itself is a SQL reserved word.
 */
export const FRAMEWORK_SCHEMA = 'affordance'

/**
 * The DDL revision below. Bump it whenever the DDL changes: a database
 * already carrying this version skips the DDL entirely, which is what keeps
 * a start-up from touching a busy database at all.
 */
export const SCHEMA_VERSION = 4

/**
 * Framework DDL, `IF NOT EXISTS` throughout — no migration framework.
 *
 * `cases` columns:
 * - `id`         text — a typed id (`case:<uuid>`), minted by the store on
 *                creation; every framework id carries its kind (see `ids.ts`)
 * - `case_type`  the Case Type name (the code definition floats; only the
 *                name is persisted)
 * - `state`      the materialized Case State document
 * - `seq`        per-case monotonic sequence counter, starts at 0; bumped by
 *                every committed Execution
 * - `ended_at`   dormancy marker written by `end()` — null while active;
 *                dormancy, never a freeze (spec §Core model)
 *
 * `journal` is the immutable per-Execution record. The framework
 * only ever **inserts** into it — no update or delete path exists anywhere in
 * the library. One Execution contributes several entries (`claimed`, then any
 * `attempt-failed`, then a terminal `completed` / `failed` / `expired`), each
 * self-contained so a per-track audit is a filter, never a join:
 * - `ordinal`      bigserial — total insertion order; per-case order is
 *                  `(case_id, ordinal)`
 * - `entry`        which lifecycle moment this row records
 * - `step`/`scope_key`/`actor`/`input` — the Execution's identity, repeated on
 *                  every entry so `where scope_key = …` is the per-track audit
 * - `as_of`/`guard`/`state` — on `claimed`: the transactional guard
 *                  re-evaluation, the instant it was evaluated as of, and the
 *                  Case State it was evaluated against. Together they make
 *                  audit reconstruction exact rather than approximate.
 * - `delta`        on `completed`: the JSON-Patch delta (previous → next)
 * - `dormancy`     on `completed`: `end()` / `reopen()` called by the handler
 * - `error`        on `attempt-failed` / `failed` / `expired`
 *
 * `correlations` and `ingested_events` are the two integration primitives.
 * A correlation maps an external identifier to (case, scope
 * element); it is written by the handler that starts the external
 * interaction, and `unique (system, external_id)` makes re-registering the
 * same envelope idempotent — a repeat changes nothing. `ingested_events` is
 * both the dedup gate and the dead-letter surface: `unique (idempotency_key)`
 * is what makes "three deliveries, one Execution" a database fact rather than
 * a hope, and the `status` / `reason` columns are why an event that changed
 * nothing is still visible.
 *
 * `claims` is the opposite kind of table: mutable, transient lease
 * bookkeeping, one row per **in-flight** Execution, deleted the moment the
 * Execution settles. `case_id` is its primary key — that single constraint is
 * "one in-flight execution per case". `expires_at` is what keeps a crash
 * from stranding a case: a crashed handler stops heartbeating and the next
 * claimant takes the case over (journaling an `expired` entry for the
 * abandoned Execution).
 */
const DDL = `
select pg_advisory_xact_lock(hashtextextended('${FRAMEWORK_SCHEMA}.bootstrap', 0));

-- DDL must never be what blocks live work. "create index if not exists" and
-- friends take table locks whether or not they have anything to do, so a
-- bootstrap running against a busy database can queue behind -- or deadlock
-- with -- Executions committing. Bounding the wait makes this transaction
-- the one that yields, and bootstrap() retries it.
set local lock_timeout = '2s';

create schema if not exists ${FRAMEWORK_SCHEMA};

-- Schema v2 stores typed text ids ('case:<uuid>', 'execution:<uuid>', …); v1
-- stored bare uuids in uuid columns, which cannot hold them. There is no DDL
-- migration framework, so a v1 database fails loudly here rather than
-- corrupting silently on the first insert.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = '${FRAMEWORK_SCHEMA}' and table_name = 'cases'
      and column_name = 'id' and data_type = 'uuid'
  ) then
    raise exception 'affordance schema v1 detected (uuid ids); v2 ids are text of the form kind:uuid. No automatic conversion exists — export anything you need, then: drop schema ${FRAMEWORK_SCHEMA} cascade; and re-bootstrap.';
  end if;
end $$;

create table if not exists ${FRAMEWORK_SCHEMA}.cases (
  id text primary key,
  case_type text not null,
  state jsonb not null,
  seq bigint not null default 0,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ${FRAMEWORK_SCHEMA}.journal (
  ordinal bigserial primary key,
  id text not null unique,
  case_id text not null references ${FRAMEWORK_SCHEMA}.cases (id),
  execution_id text not null,
  entry text not null,
  attempt integer not null default 1,
  step text not null,
  scope_key text,
  actor jsonb,
  input jsonb,
  as_of timestamptz,
  guard jsonb,
  state jsonb,
  delta jsonb,
  dormancy text,
  error jsonb,
  recorded_at timestamptz not null default now()
);

-- Schema v4 removed rule automation, and with it the \`cause\` column (the
-- causality record an automatic Execution carried). The column is left in
-- place on a database that has it: journal rows are immutable history, and
-- old automatic Executions keep the cause they were recorded with. New
-- entries simply never write it.

create index if not exists journal_case_idx
  on ${FRAMEWORK_SCHEMA}.journal (case_id, ordinal);
create index if not exists journal_scope_idx
  on ${FRAMEWORK_SCHEMA}.journal (case_id, scope_key, ordinal);
create index if not exists journal_execution_idx
  on ${FRAMEWORK_SCHEMA}.journal (execution_id, ordinal);

create table if not exists ${FRAMEWORK_SCHEMA}.claims (
  case_id text primary key references ${FRAMEWORK_SCHEMA}.cases (id),
  execution_id text not null,
  step text not null,
  scope_key text,
  attempt integer not null default 1,
  claimed_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Schema v3 removed timer scheduling. Timer rows were derived state (a
-- case's future time-flips, recomputable from nothing but Case State), so
-- dropping the table on a v2 database loses no facts.
drop table if exists ${FRAMEWORK_SCHEMA}.timers;

create table if not exists ${FRAMEWORK_SCHEMA}.correlations (
  id text primary key,
  system text not null,
  external_id text not null,
  case_id text not null references ${FRAMEWORK_SCHEMA}.cases (id),
  scope_key text,
  step text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  unique (system, external_id)
);

create index if not exists correlations_case_idx
  on ${FRAMEWORK_SCHEMA}.correlations (case_id, scope_key);

create table if not exists ${FRAMEWORK_SCHEMA}.ingested_events (
  id text primary key,
  system text not null,
  external_id text not null,
  type text not null,
  idempotency_key text not null unique,
  case_id text,
  scope_key text,
  step text,
  status text not null,
  reason text,
  detail text,
  execution_id text,
  event jsonb not null,
  received_at timestamptz not null default now()
);

create index if not exists ingested_events_dead_letter_idx
  on ${FRAMEWORK_SCHEMA}.ingested_events (status, received_at desc);

create table if not exists ${FRAMEWORK_SCHEMA}.schema_version (
  version integer primary key,
  applied_at timestamptz not null default now()
);

insert into ${FRAMEWORK_SCHEMA}.schema_version (version)
values (${SCHEMA_VERSION}) on conflict do nothing;
`

/**
 * Every framework table that holds rows belonging to one case, with the
 * column that names the case — listed in an order safe to delete from
 * (children first; everything references `cases`). **The one answer to
 * "which tables does the framework own"** outside the DDL above: a consumer
 * that sweeps per-case rows (a dev console's case purge, a test harness's
 * cleanup) iterates this instead of keeping a private copy that goes stale
 * the release a table is added.
 *
 * `ingested_events.case_id` is nullable — an unrouted event belongs to no
 * case and survives a per-case sweep, which is correct: it was never about
 * the deleted case.
 */
export const CASE_TABLES = [
  { table: 'journal', caseColumn: 'case_id' },
  { table: 'claims', caseColumn: 'case_id' },
  { table: 'correlations', caseColumn: 'case_id' },
  { table: 'ingested_events', caseColumn: 'case_id' },
  { table: 'cases', caseColumn: 'id' },
] as const

/**
 * Whether the schema is already at {@link SCHEMA_VERSION} — two catalog reads
 * that take no lock any Execution could ever be waiting on.
 *
 * This is what makes `bootstrap` free on every start after the first. The DDL
 * below is idempotent, but idempotent is not the same as *harmless*: `create
 * index if not exists` takes a table lock whether or not it has work to do,
 * and a bootstrap holding one while Executions commit can deadlock with them
 * — not as a rare race, but predictably, on every start against a busy
 * database. Asking first means the locks are only ever taken when there is
 * genuinely something to create.
 */
const isCurrent = async (db: Queryable): Promise<boolean> => {
  const marker = await db.query<{ present: boolean }>(
    `select to_regclass('${FRAMEWORK_SCHEMA}.schema_version') is not null as present`,
  )
  if (marker.rows[0]?.present !== true) return false
  const applied = await db.query<{ version: number }>(
    `select max(version) as version from ${FRAMEWORK_SCHEMA}.schema_version`,
  )
  return (applied.rows[0]?.version ?? 0) >= SCHEMA_VERSION
}

/** Postgres says the transaction lost a race it can retry: deadlock, or the bounded lock wait. */
const isContention = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code
  return code === '40P01' || code === '55P03' || code === '40001'
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Idempotent DDL bootstrap for the framework schema. Safe to call on every
 * app start and from concurrent processes: the statements are sent as one
 * multi-statement simple query, which Postgres runs on one connection inside
 * a single implicit transaction, and the leading `pg_advisory_xact_lock`
 * serializes racing bootstraps (concurrent `CREATE ... IF NOT EXISTS` can
 * otherwise fail on catalog uniqueness).
 *
 * Also safe to call against a *busy* database, which is the harder promise,
 * and is answered twice over. First, a bootstrap with nothing to do does
 * nothing at all: {@link isCurrent} checks the version marker and returns
 * before any DDL runs, so the common case takes no table locks whatsoever.
 * Second, when there *is* work, the transaction bounds its own lock wait and
 * this retries it — schema management yields to live work, never the reverse.
 */
export const bootstrap = async (db: Queryable, attempts = 5): Promise<void> => {
  if (await isCurrent(db)) return
  for (let attempt = 1; ; attempt += 1) {
    try {
      await db.query(DDL)
      return
    } catch (error) {
      if (attempt >= attempts || !isContention(error)) throw error
      await wait(50 * attempt)
    }
  }
}

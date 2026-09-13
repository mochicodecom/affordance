import type { Queryable } from './queryable.js'
export const FRAMEWORK_SCHEMA = 'affordance'
export const SCHEMA_VERSION = 5
/** Fresh schema only. Existing installations require an explicit operator reset;
 * bootstrap never drops or converts business data. */
const DDL = `
select pg_advisory_xact_lock(hashtextextended('affordance.bootstrap', 0));
create schema if not exists affordance;
do $$ begin
  if to_regclass('affordance.cases') is not null and not exists (
    select 1 from information_schema.columns where table_schema = 'affordance'
    and table_name = 'cases' and column_name = 'reference'
  ) then raise exception 'Incompatible Affordance schema: domain-backed v5 requires a fresh framework schema; no automatic data conversion or reset is performed'; end if;
end $$;
create table if not exists ${FRAMEWORK_SCHEMA}.cases (
  id text primary key,
  case_type text not null,
  reference text not null,
  unique (case_type, reference),
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

create index if not exists journal_case_idx
  on ${FRAMEWORK_SCHEMA}.journal (case_id, ordinal);
create index if not exists journal_scope_idx
  on ${FRAMEWORK_SCHEMA}.journal (case_id, scope_key, ordinal);
create index if not exists journal_execution_idx
  on ${FRAMEWORK_SCHEMA}.journal (execution_id, ordinal);

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


create index if not exists cases_listing_idx on affordance.cases (created_at desc, id desc);
create table if not exists affordance.schema_version (version integer primary key);
insert into affordance.schema_version values (5) on conflict do nothing;
`
export const bootstrap = async (db: Queryable): Promise<void> => {
  await db.query(DDL)
}
export const CASE_TABLES = [
  { table: 'journal', caseColumn: 'case_id' },
  { table: 'correlations', caseColumn: 'case_id' },
  { table: 'ingested_events', caseColumn: 'case_id' },
  { table: 'cases', caseColumn: 'id' },
] as const

import type { CaseRepository } from '@affordance/core/storage'
import { deserializeValue } from '@affordance/core/storage'
import { FRAMEWORK_SCHEMA } from './bootstrap.js'
import type { Queryable } from './queryable.js'
import { type CaseRow, toHandle } from './store.js'

/** The cursor preserves Postgres timestamp precision, including sub-millisecond ties. */
export const listCases = async (
  db: Queryable,
  options: Parameters<CaseRepository['list']>[0],
) => {
  const types = [...options.caseTypeNames].sort()
  const filter = JSON.stringify([types, options.includeEnded === true])
  let after: { createdAt: string; id: string } | null = null
  if (options.cursor !== undefined) {
    try {
      const parsed = JSON.parse(
        Buffer.from(options.cursor, 'base64url').toString('utf8'),
      )
      if (
        parsed.version !== 1 ||
        parsed.filter !== filter ||
        typeof parsed.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(parsed.createdAt)) ||
        typeof parsed.id !== 'string'
      )
        throw new Error('invalid')
      after = parsed
    } catch {
      throw new TypeError('listCases: invalid cursor or changed filters')
    }
  }
  const { rows } = await db.query<CaseRow & { cursor_created_at: string }>(
    `select id, case_type, state, seq, ended_at, created_at, updated_at,
            created_at::text as cursor_created_at
     from ${FRAMEWORK_SCHEMA}.cases
     where case_type = any($1::text[]) and ($2::boolean or ended_at is null)
       and ($3::timestamptz is null or (created_at, id) < ($3::timestamptz, $4::text))
     order by created_at desc, id desc limit $5`,
    [
      types,
      options.includeEnded === true,
      after?.createdAt ?? null,
      after?.id ?? null,
      options.limit + 1,
    ],
  )
  const selected = rows.slice(0, options.limit)
  const last = selected.at(-1)
  return {
    cases: selected.map((row) => toHandle(row, deserializeValue(row.state))),
    nextCursor:
      rows.length > options.limit && last !== undefined
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              filter,
              createdAt: last.cursor_created_at,
              id: last.id,
            }),
          ).toString('base64url')
        : null,
  }
}

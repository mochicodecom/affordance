import { Box, Code, Group, Paper, Text } from '@mantine/core'
import { Eyebrow } from '@/components/console/eyebrow'
import type { AffordancePayload, CaseHandle, JournalEntry } from '@/lib/api'
import { scopeLabel } from '@/lib/house-purchase'

const border = '1px solid var(--mantine-color-default-border)'

/* The shared shell: eyebrow, one line of fine print, the body. A panel
 * grows to its content by default — pass bodyMaxHeight to cap one (the
 * raw-state JSON) so it scrolls inside instead of burying what follows. */
function ObsBlock({
  title,
  fineprint,
  bodyMaxHeight,
  children,
}: {
  title: string
  fineprint: React.ReactNode
  bodyMaxHeight?: string
  children?: React.ReactNode
}) {
  return (
    <Paper
      withBorder
      radius="md"
      px="md"
      py="sm"
      style={{
        display: 'grid',
        gridTemplateRows: 'auto auto minmax(0, 1fr)',
        gap: 8,
        minHeight: 0,
      }}
    >
      <Eyebrow>{title}</Eyebrow>
      <Text size="sm" c="dimmed">
        {fineprint}
      </Text>
      <div style={{ minHeight: 0, overflow: 'auto', maxHeight: bodyMaxHeight }}>
        {children}
      </div>
    </Paper>
  )
}

/* Long values (buyer:<uuid> strings) wrap rather than clip — a hidden
 * horizontal scrollbar reads as the panel cutting off. */
const RawJson = ({ value }: { value: unknown }) => (
  <Code block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
    {JSON.stringify(value, null, 2)}
  </Code>
)

/**
 * History: the journal, newest first — a two-line row per entry (step ·
 * actor, then when), expandable to the raw record. The empty state is
 * explicit: an empty journal is a fact about the case, not a loading gap.
 */
export function HistoryPanel({
  journal,
  state,
}: {
  journal: JournalEntry[] | null
  /** The case state — journal scope keys render as buyer names when known. */
  state: unknown
}) {
  const rows = journal ? journal.slice().reverse() : []
  return (
    <ObsBlock
      title="History"
      fineprint={
        journal
          ? `${journal.length} journal ${journal.length === 1 ? 'entry' : 'entries'}, newest first — expand one for its raw record.`
          : 'No case selected.'
      }
    >
      {journal &&
        (journal.length === 0 ? (
          <Text px={2} py="xs" size="xs" c="dimmed">
            The journal is empty — nothing has executed on this case yet.
          </Text>
        ) : (
          rows.map((entry) => {
            // Buyer actors show by name too — the actor id IS the scope key
            // for a buyer's own acts, so the same resolver applies.
            const actorId =
              entry.actor &&
              typeof entry.actor === 'object' &&
              'id' in entry.actor
                ? scopeLabel(state, String((entry.actor as { id: unknown }).id))
                : JSON.stringify(entry.actor)
            // The journal records each execution twice — claimed, then
            // completed. Unlabeled, the pair reads as a duplicate; labeled,
            // it reads as what it is.
            const kind = typeof entry.entry === 'string' ? entry.entry : ''
            return (
              <details
                key={`${entry.recordedAt}|${entry.step}|${entry.scopeKey ?? ''}|${kind}`}
                style={{ borderBottom: border, padding: '6px 2px' }}
              >
                <summary style={{ cursor: 'pointer', listStyle: 'none' }}>
                  <Group
                    gap="xs"
                    align="baseline"
                    wrap="nowrap"
                    style={{ minWidth: 0 }}
                  >
                    <Text ff="monospace" size="xs" truncate>
                      {entry.step}
                      {entry.scopeKey
                        ? `[${scopeLabel(state, entry.scopeKey)}]`
                        : ''}
                    </Text>
                    {kind && (
                      <Text
                        size="xs"
                        c={kind === 'completed' ? undefined : 'dimmed'}
                        px={6}
                        bg={
                          kind === 'completed'
                            ? 'var(--mantine-color-gray-light)'
                            : undefined
                        }
                        style={{
                          flexShrink: 0,
                          borderRadius: 999,
                          fontSize: 10,
                        }}
                      >
                        {kind}
                      </Text>
                    )}
                    <Text
                      ml="auto"
                      ff="monospace"
                      size="xs"
                      c="dimmed"
                      style={{ flexShrink: 0 }}
                    >
                      {actorId}
                    </Text>
                  </Group>
                  <Text
                    ff="monospace"
                    size="xs"
                    c="dimmed"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {entry.recordedAt}
                  </Text>
                </summary>
                <Box mt="xs">
                  <RawJson value={entry} />
                </Box>
              </details>
            )
          })
        ))}
    </ObsBlock>
  )
}

/** Current state: the raw case handle, stamped with the payload's asOf. */
export function StatePanel({
  aff,
  handle,
}: {
  aff: AffordancePayload | null
  handle: CaseHandle | null
}) {
  return (
    <ObsBlock
      title="Current state"
      bodyMaxHeight="45vh"
      fineprint={
        aff ? (
          <>
            as of{' '}
            <Text span inherit ff="monospace">
              {aff.case.asOf}
            </Text>
          </>
        ) : (
          'No case selected.'
        )
      }
    >
      {handle && <RawJson value={handle} />}
    </ObsBlock>
  )
}

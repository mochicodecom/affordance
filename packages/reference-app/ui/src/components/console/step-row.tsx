/**
 * One affordances[] entry as a full-width row in the action rail. Steps
 * stack vertically, so each gets the rail's whole width: the human label
 * and actor hint lead the header with the wire name demoted to its right,
 * and the schema's fields distribute evenly across the row below, the
 * action at its end. Input rendering stays contract-driven — the fields
 * come from the schema on the wire — and execution goes through the
 * entry's own execute link. Refusals render inline right here.
 */

import { Box, Button, Flex, Group, Paper, Text } from '@mantine/core'
import { ActorHintBadge } from '@/components/console/actor-hint-badge'
import { RefusalNote } from '@/components/console/refusal-note'
import { collectInput, SchemaFields } from '@/components/console/schema-form'
import type { CardError } from '@/hooks/use-console'
import type { AffordanceEntry } from '@/lib/api'
import { cardKey } from '@/lib/card-key'
import { scopeLabel } from '@/lib/house-purchase'

type Props = {
  entry: AffordanceEntry
  /** The case state — resolves the scope key to a buyer name when it can. */
  state: unknown
  error: CardError | null
  onExecute: (entry: AffordanceEntry, input: unknown) => void
  onInputError: (key: string, message: string) => void
}

export function StepRow({
  entry,
  state,
  error,
  onExecute,
  onInputError,
}: Props) {
  const key = cardKey(entry)
  const scope =
    entry.scopeKey === undefined ? undefined : scopeLabel(state, entry.scopeKey)
  const named = scope !== undefined && scope !== entry.scopeKey

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    let input: unknown
    try {
      input = collectInput(event.currentTarget)
    } catch (parseError) {
      onInputError(
        key,
        `input is not valid JSON: ${(parseError as Error).message}`,
      )
      return
    }
    onExecute(entry, input)
  }

  return (
    <Paper withBorder radius="md" px="md" py="sm">
      <Group justify="space-between" align="center" gap="xs">
        <Group align="center" gap="xs">
          <Text fw={500}>
            {entry.title ?? entry.step}
            {named && (
              <Text span fw={400} c="dimmed">
                {' '}
                · {scope}
              </Text>
            )}
          </Text>
          <ActorHintBadge step={entry.step} />
        </Group>
        {/* The raw wire values: the step's name, plus the raw scope key
            only when no buyer name stands in for it above. */}
        <Text
          ff="monospace"
          size="xs"
          c="dimmed"
          style={{ wordBreak: 'break-all' }}
        >
          {entry.step}
          {entry.scopeKey !== undefined && !named && ` · ${entry.scopeKey}`}
        </Text>
      </Group>
      <form onSubmit={submit}>
        <Flex mt="xs" wrap="wrap" align="flex-end" gap="sm">
          {entry.input.required && (
            <Box
              style={{
                flex: 1,
                minWidth: 224,
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                alignItems: 'end',
                gap: 10,
              }}
            >
              <SchemaFields schema={entry.input.schema} />
            </Box>
          )}
          <Button type="submit" ml="auto" style={{ flexShrink: 0 }}>
            Take this step
          </Button>
        </Flex>
      </form>
      {error?.key === key && (
        <Box mt="xs">
          <RefusalNote error={error} />
        </Box>
      )}
    </Paper>
  )
}

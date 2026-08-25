import { Text } from '@mantine/core'
import { scopeLabel } from '@/lib/house-purchase'

/**
 * A step's scope beside its label: the buyer's name when the given case
 * state knows one (plain text — it's a human word), the raw key otherwise
 * (monospace — it's the exact key from the wire). Pass `state: null` to
 * force raw, e.g. for world entries that belong to another case.
 */
export function ScopeTag({
  state,
  scopeKey,
}: {
  state: unknown
  scopeKey: string | undefined
}) {
  if (scopeKey === undefined || scopeKey === '') return null
  const name = scopeLabel(state, scopeKey)
  return (
    <Text
      span
      ml={6}
      size="xs"
      fw={400}
      c="dimmed"
      ff={name === scopeKey ? 'monospace' : undefined}
    >
      {name}
    </Text>
  )
}

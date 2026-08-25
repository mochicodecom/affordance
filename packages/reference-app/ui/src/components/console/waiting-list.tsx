import { Box, Group, Text } from '@mantine/core'
import { ActorHintBadge } from '@/components/console/actor-hint-badge'
import { Eyebrow } from '@/components/console/eyebrow'
import { ScopeTag } from '@/components/console/scope-tag'
import type { BlockedEntry, UnmetCondition } from '@/lib/api'
import { cardKey } from '@/lib/card-key'
import { blockedBecauseDone } from '@/lib/house-purchase'

const border = '1px solid var(--mantine-color-default-border)'

/* A condition's explanation: the reason it reported, or nothing when it
 * reported none — the `section.name` identifier rendered beside it
 * already says which condition this is. */
const unmetText = (condition: UnmetCondition) => condition.reason ?? ''

/**
 * The waiting list: blocked[] entries whose conditions don't hold yet,
 * each with its unmet conditions' reasons and `section.name` identifiers.
 * The footnote says what the list is not — the payload never enumerates
 * every absent step.
 */
export function WaitingList({
  blocked,
  state,
}: {
  blocked: readonly BlockedEntry[]
  state: unknown
}) {
  return (
    <Box mt="xl">
      <Eyebrow>Waiting on the world</Eyebrow>
      <Box mt="sm" style={{ borderTop: border }}>
        {blocked.map((entry) => {
          const done = blockedBecauseDone(entry)
          return (
            <Group
              key={cardKey(entry)}
              gap="sm"
              align="baseline"
              wrap="nowrap"
              px={2}
              py="sm"
              style={{ borderBottom: border }}
            >
              {done ? (
                <Text
                  c="teal"
                  fw={600}
                  size="sm"
                  lh={1}
                  style={{ alignSelf: 'center', flexShrink: 0 }}
                >
                  ✓
                </Text>
              ) : (
                <Box
                  bg="yellow.7"
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    alignSelf: 'center',
                    flexShrink: 0,
                  }}
                />
              )}
              <Box style={{ minWidth: 0 }}>
                <Text size="sm" fw={600}>
                  {entry.title ?? entry.step}
                  <ScopeTag state={state} scopeKey={entry.scopeKey} />
                </Text>
                <Text size="sm" c="dimmed" mt={2}>
                  {entry.unmet.map((condition, index) => (
                    <Text
                      span
                      inherit
                      key={`${condition.section}.${condition.name}`}
                    >
                      {index > 0 && ' · '}
                      {unmetText(condition)}{' '}
                      <Text span ff="monospace" fz="xs" opacity={0.8}>
                        {condition.section}.{condition.name}
                      </Text>
                    </Text>
                  ))}
                </Text>
              </Box>
              <Box ml="auto" style={{ alignSelf: 'center', flexShrink: 0 }}>
                <ActorHintBadge step={entry.step} />
              </Box>
            </Group>
          )
        })}
      </Box>
      <Text mt="xs" size="sm" c="dimmed">
        A check marks a step that is behind the case, not ahead of it. The rest
        exist but their conditions don't hold yet. Steps whose scope is empty,
        or that this persona may not take, don't appear at all.
      </Text>
    </Box>
  )
}

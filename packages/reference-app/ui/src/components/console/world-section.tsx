import { Box, Button, Group, Paper, Text, TextInput } from '@mantine/core'
import { useRef } from 'react'
import { Eyebrow } from '@/components/console/eyebrow'
import { ScopeTag } from '@/components/console/scope-tag'
import type { WireLever, WorldState } from '@/lib/api'
import { worldLabel } from '@/lib/house-purchase'

type Props = {
  world: WorldState
  caseId: string | null
  /** The selected case's state — names resolve only for that case's rows. */
  state: unknown
  /** Unprompted acts the world could take now (the leak module decides). */
  levers: WireLever[]
  onDeliver: (eventId: string) => void
  onAnnounce: (buyerId: string, amount: number) => void
}

/* The dashed dot that distinguishes the world's rows from the console's own. */
const WorldDot = () => (
  <Box
    style={{
      width: 10,
      height: 10,
      borderRadius: 999,
      border: '2px dashed var(--mantine-color-dimmed)',
      flexShrink: 0,
    }}
  />
)

/** One unprompted act: the escrow company wires a buyer's funds. */
function LeverRow({
  lever,
  onAnnounce,
}: {
  lever: WireLever
  onAnnounce: Props['onAnnounce']
}) {
  const amountRef = useRef<HTMLInputElement>(null)
  return (
    <Paper withBorder radius="md" px="md" py="xs">
      <Group gap="md" align="center">
        <WorldDot />
        <Box style={{ minWidth: 0 }}>
          <Text size="sm" fw={600}>
            The escrow company wires {lever.name}'s funds
          </Text>
          <Text mt={2} ff="monospace" size="xs" c="dimmed">
            unprompted · still to wire {lever.amount.toLocaleString()}
          </Text>
        </Box>
        <Group ml="auto" gap="xs" style={{ flexShrink: 0 }}>
          <TextInput
            ref={amountRef}
            type="number"
            step="1000"
            defaultValue={lever.amount}
            aria-label={`Wire amount for ${lever.name}`}
            w={128}
            styles={{ input: { textAlign: 'right' } }}
          />
          <Button
            variant="default"
            onClick={() =>
              onAnnounce(
                lever.buyerId,
                Number(amountRef.current?.value ?? lever.amount),
              )
            }
          >
            Announce wire
          </Button>
        </Group>
      </Group>
    </Paper>
  )
}

/**
 * One button per pending answer: every undelivered provider webhook is its
 * own labeled "Deliver" button. Cause and effect stay visible when
 * each event lands by itself.
 */
export function WorldSection({
  world,
  caseId,
  state,
  levers,
  onDeliver,
  onAnnounce,
}: Props) {
  if (world.events.length === 0 && levers.length === 0) {
    return (
      <Box mt="xl">
        <Eyebrow>The outside world</Eyebrow>
        <Text mt="xs" size="sm" c="dimmed">
          Nothing pending — every provider has answered.
        </Text>
      </Box>
    )
  }

  return (
    <Box mt="xl">
      <Eyebrow>The outside world</Eyebrow>
      <Box mt="sm" style={{ display: 'grid', gap: 10 }}>
        {levers.map((lever) => (
          <LeverRow key={lever.buyerId} lever={lever} onAnnounce={onAnnounce} />
        ))}
        {world.events.map((event) => (
          <Paper
            key={event.eventId}
            withBorder
            radius="md"
            px="md"
            py="xs"
            style={{ borderStyle: 'dashed' }}
          >
            <Group gap="md" align="center" wrap="nowrap">
              <WorldDot />
              <Box style={{ minWidth: 0 }}>
                <Text size="sm" fw={600}>
                  {worldLabel(event)}
                  <ScopeTag
                    state={event.caseId === caseId ? state : null}
                    scopeKey={event.scopeKey}
                  />
                </Text>
                <Text mt={2} ff="monospace" size="xs" c="dimmed">
                  {event.system} · {event.externalId}
                  {event.caseId && event.caseId !== caseId && ' · another case'}
                </Text>
              </Box>
              <Button
                variant="default"
                ml="auto"
                style={{ flexShrink: 0 }}
                onClick={() => onDeliver(event.eventId)}
              >
                Deliver
              </Button>
            </Group>
          </Paper>
        ))}
      </Box>
      <Text mt="xs" size="sm" c="dimmed">
        Each button plays one provider webhook, exactly as it would arrive in
        production — just on your click instead of the world's clock.
      </Text>
    </Box>
  )
}

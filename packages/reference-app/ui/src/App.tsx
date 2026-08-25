import {
  Alert,
  Anchor,
  Box,
  Container,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core'
import { ACTOR_BAND } from '@/components/console/actor-hint-badge'
import { CaseBlock } from '@/components/console/case-block'
import { Eyebrow } from '@/components/console/eyebrow'
import { Headline } from '@/components/console/headline'
import {
  HistoryPanel,
  StatePanel,
} from '@/components/console/observation-panels'
import { StepRow } from '@/components/console/step-row'
import { WaitingList } from '@/components/console/waiting-list'
import { WorldSection } from '@/components/console/world-section'
import { useConsole } from '@/hooks/use-console'
import { blockedUnion, useCrossActor } from '@/hooks/use-cross-actor'
import { cardKey } from '@/lib/card-key'
import { ORGANIZER } from '@/lib/house-purchase'

/**
 * The demo console: act on the left, observe on the right. The left column
 * is the action rail — case, then EVERY actor's available steps at once,
 * grouped by actor. There is no acting persona to switch: taking a step
 * acts as the actor whose group it sits in, which is the whole pitch —
 * affordances are computed per actor, and here they all are. Below the
 * rail: the outside world's pending answers and the waiting list of
 * blocked steps.
 * The right column observes: current state, then history.
 */
export default function App() {
  const demo = useConsole(ORGANIZER)
  const lanes = useCrossActor(
    demo.caseId,
    demo.handle?.state,
    demo.aff?.case.asOf,
  )

  // The union of every persona's blocked entries, one row per step·scope —
  // the actor pill on each row already says whose it is.
  const waiting = blockedUnion(lanes)

  return (
    // Fluid: the console owns the whole window width; the gutters widen
    // with it. (The intro page keeps a reading-width cap — it's prose.)
    <Container fluid mih="100dvh" px={{ base: 'lg', xl: 40 }} pb={64}>
      <Group
        justify="space-between"
        align="baseline"
        py="md"
        style={{
          borderBottom: '1px solid var(--mantine-color-default-border)',
        }}
      >
        <Text size="xl" fw={500}>
          Affordance{' '}
          <Text span size="xs" fw={600} tt="uppercase" c="dimmed" lts="0.12em">
            demo
          </Text>
        </Text>
        <Anchor
          href="/intro"
          target="_blank"
          rel="noreferrer"
          size="sm"
          c="dimmed"
          underline="hover"
        >
          How this demo works ↗
        </Anchor>
      </Group>

      {demo.notice && (
        <Alert color="red" variant="light" mt="sm" p="sm">
          {demo.notice}
        </Alert>
      )}

      <SimpleGrid
        cols={{ base: 1, lg: 2 }}
        spacing="xl"
        mt={4}
        style={{ alignItems: 'start' }}
      >
        <div>
          <CaseBlock
            cases={demo.cases}
            caseId={demo.caseId}
            error={demo.cardError}
            onSelectCase={demo.selectCase}
            onCreate={demo.create}
            onDelete={demo.removeCase}
            onInputError={demo.reportCardError}
          />

          <Box component="section" pt="md">
            <Eyebrow>Everyone on this case</Eyebrow>
            <Headline cases={demo.cases} aff={demo.aff} lanes={lanes} />
            <Text size="sm" c="dimmed">
              Every group below is the same case state asked for a different
              actor. Taking a step acts as that actor — steps a persona may not
              take are absent, not greyed.
            </Text>

            <Stack mt="lg" gap="md">
              {/* One box per actor: the tinted band is that actor's hue —
                  the same palette as the step pills — so each actor's box
                  is visually distinct from the next at a glance. */}
              {lanes.map((lane) => {
                const offered = lane.aff?.affordances ?? []
                return (
                  <Paper
                    key={lane.key}
                    withBorder
                    radius="md"
                    style={{ overflow: 'hidden' }}
                  >
                    <Group
                      gap="xs"
                      align="baseline"
                      px="md"
                      py={8}
                      bg={ACTOR_BAND[lane.actorKind]}
                    >
                      <Text size="sm" fw={600}>
                        {lane.name}
                      </Text>
                      {lane.aff === null && (
                        <Text size="xs" c="dimmed">
                          could not read
                        </Text>
                      )}
                      {lane.aff !== null && offered.length === 0 && (
                        <Text size="xs" c="dimmed">
                          nothing right now
                        </Text>
                      )}
                    </Group>
                    {offered.length > 0 && (
                      <Stack
                        gap="sm"
                        p="sm"
                        style={{
                          borderTop:
                            '1px solid var(--mantine-color-default-border)',
                        }}
                      >
                        {/* asOf in the key remounts the forms after every
                            mutation, so stale field values never linger. */}
                        {offered.map((entry) => (
                          <StepRow
                            key={`${lane.aff?.case.asOf}|${lane.key}|${cardKey(entry)}`}
                            entry={entry}
                            state={demo.handle?.state}
                            error={demo.cardError}
                            onExecute={(target, input) =>
                              demo.execute(target, input, lane.persona)
                            }
                            onInputError={demo.reportCardError}
                          />
                        ))}
                      </Stack>
                    )}
                  </Paper>
                )
              })}
            </Stack>
          </Box>

          {demo.world && (
            <WorldSection
              world={demo.world}
              caseId={demo.caseId}
              state={demo.handle?.state}
              levers={demo.world.levers ?? []}
              onDeliver={demo.deliver}
              onAnnounce={demo.announce}
            />
          )}

          {waiting.length > 0 && (
            <WaitingList blocked={waiting} state={demo.handle?.state} />
          )}
        </div>

        <Stack component="aside" gap="sm">
          <StatePanel aff={demo.aff} handle={demo.handle} />
          <HistoryPanel journal={demo.journal} state={demo.handle?.state} />
        </Stack>
      </SimpleGrid>
    </Container>
  )
}

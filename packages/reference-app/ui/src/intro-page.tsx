import {
  Anchor,
  Badge,
  Box,
  Container,
  Group,
  Stack,
  Text,
  Title,
} from '@mantine/core'
import { ACTOR_COLOR } from '@/components/console/actor-hint-badge'
import { Eyebrow } from '@/components/console/eyebrow'
import { actorHint, INTRO } from '@/lib/house-purchase'

/**
 * The newcomer intro at `/intro` — a separate page, opened from the
 * console header in a new tab. Everything case-type-specific it shows
 * comes from `INTRO` (leak #3) in the leak module — the one file allowed
 * to know this case type: the pitch, then the example actor×step
 * swimlane. The swimlane is a static example at a glance; the cross-actor
 * behavior itself shows in the console's live cast strip.
 */
export default function IntroPage() {
  return (
    <Container size={1100} px="md" pb={64}>
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
            intro
          </Text>
        </Text>
        <Anchor href="/" size="sm" c="dimmed" underline="hover">
          Open the console →
        </Anchor>
      </Group>

      <Title
        order={1}
        mt="xl"
        fz="2rem"
        fw={500}
        maw="24em"
        style={{ textWrap: 'balance' }}
      >
        {INTRO.title}
      </Title>
      <Stack mt="md" gap="sm" maw="46em">
        {INTRO.paragraphs.map((paragraph) => (
          <Text key={paragraph.slice(0, 24)}>{paragraph}</Text>
        ))}
      </Stack>

      <Box mt={40}>
        <Eyebrow>Who does what — the example at a glance</Eyebrow>
      </Box>
      <Box mt="sm" style={{ overflowX: 'auto' }}>
        <div
          style={{
            display: 'grid',
            minWidth: 860,
            columnGap: 12,
            rowGap: 8,
            gridTemplateColumns: `10rem repeat(${INTRO.phases.length}, minmax(0, 1fr))`,
          }}
        >
          <div />
          {INTRO.phases.map((phase) => (
            <Box
              key={phase.name}
              pb={6}
              style={{
                borderBottom: '1px solid var(--mantine-color-default-border)',
              }}
            >
              <Eyebrow>{phase.name}</Eyebrow>
            </Box>
          ))}
          {INTRO.lanes.map((lane) => (
            <div key={lane.kind} style={{ display: 'contents' }}>
              <Text py={6} size="sm" c="dimmed">
                {lane.label}
              </Text>
              {INTRO.phases.map((phase) => (
                <Stack
                  key={`${lane.kind}|${phase.name}`}
                  gap={6}
                  py={6}
                  align="flex-start"
                >
                  {phase.steps
                    .filter(({ step }) => actorHint(step)?.kind === lane.kind)
                    .map(({ step, label }) => (
                      <Badge
                        key={step}
                        variant="light"
                        color={ACTOR_COLOR[lane.kind]}
                        title={step}
                        h="auto"
                        py={3}
                        // The swimlane reads at a glance, so labels wrap
                        // instead of truncating to Badge's one-line default.
                        styles={{ label: { whiteSpace: 'normal' } }}
                        style={
                          INTRO.exceptions.includes(step)
                            ? { border: '1px dashed currentColor' }
                            : undefined
                        }
                      >
                        {label}
                      </Badge>
                    ))}
                </Stack>
              ))}
            </div>
          ))}
        </div>
      </Box>
      <Text mt="sm" size="sm" c="dimmed">
        Dashed steps are the exception paths — ordinary guarded steps that
        become available when their facts turn true, not branches anyone drew.
        Nothing on this picture is wired into the app: the live console computes
        all of it, per actor, from case state.
      </Text>
    </Container>
  )
}

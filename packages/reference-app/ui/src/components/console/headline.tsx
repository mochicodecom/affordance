import { Text, Title } from '@mantine/core'
import type { ActorLane } from '@/hooks/use-cross-actor'
import type { AffordancePayload, CaseSummary } from '@/lib/api'
import { cardKey } from '@/lib/card-key'

type Props = {
  cases: CaseSummary[]
  aff: AffordancePayload | null
  lanes: ActorLane[]
}

const Em = ({ children }: { children: React.ReactNode }) => (
  <Text span inherit c="teal">
    {children}
  </Text>
)

/**
 * The signature element: the payload's answer, said as a sentence —
 * case-wide, because every actor's steps are on screen at once. "3 steps
 * can be taken right now" is the framework's thesis said out loud,
 * computed live from every persona's affordance payload.
 */
export function Headline({ cases, aff, lanes }: Props) {
  const sentence = () => {
    if (cases.length === 0)
      return (
        <>
          No cases yet — <Em>start the first purchase</Em> above.
        </>
      )
    if (!aff) return <>Pick a case to see what can happen next.</>

    const distinct = new Set(
      lanes.flatMap((lane) => (lane.aff?.affordances ?? []).map(cardKey)),
    )
    const count = distinct.size
    if (count > 0)
      return (
        <>
          <Em>
            {count} {count === 1 ? 'step' : 'steps'}
          </Em>{' '}
          can be taken right now.
        </>
      )
    if (aff.case.endedAt !== null)
      return (
        <>
          This case is <Em>closed</Em> — its story is complete.
        </>
      )
    return (
      <>
        Everyone is <Em>waiting on the world</Em> — nothing to take right now.
      </>
    )
  }

  return (
    <Title
      order={1}
      mt="lg"
      mb={4}
      fz="1.75rem"
      fw={500}
      maw="24em"
      style={{ textWrap: 'balance' }}
    >
      {sentence()}
    </Title>
  )
}

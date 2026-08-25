import { Badge } from '@mantine/core'
import { type ActorKind, actorHint } from '@/lib/house-purchase'

/* One Mantine color per actor kind: pills and section bands draw from the
 * same palette so everything belonging to one actor is visually distinct
 * from the next actor's. */
export const ACTOR_COLOR: Record<ActorKind, string> = {
  organizer: 'teal',
  buyer: 'blue',
  'escrow-officer': 'yellow',
  external: 'gray',
}

/* The same palette at section scale: a soft band for an actor group's
 * header. Mantine's `-light` variables adapt to the color scheme. */
export const ACTOR_BAND: Record<ActorKind, string> = {
  organizer: 'var(--mantine-color-teal-light)',
  buyer: 'var(--mantine-color-blue-light)',
  'escrow-officer': 'var(--mantine-color-yellow-light)',
  external: 'var(--mantine-color-gray-light)',
}

/**
 * Who normally takes this step — a colored pill with a few words from the
 * actor hints in the leak module (the one file allowed to know this case
 * type), one hue per actor kind so who acts is visible right in the row's
 * header. Permits are deliberately invisible on the wire, so this badge is
 * the only place the viewer can tell a step a human takes from one a
 * simulated external system answers. Steps without a hint render nothing.
 */
export function ActorHintBadge({ step }: { step: string }) {
  const hint = actorHint(step)
  if (!hint) return null
  return (
    <Badge
      variant={hint.kind === 'external' ? 'outline' : 'light'}
      color={ACTOR_COLOR[hint.kind]}
      style={hint.kind === 'external' ? { borderStyle: 'dashed' } : undefined}
    >
      {hint.words}
    </Badge>
  )
}

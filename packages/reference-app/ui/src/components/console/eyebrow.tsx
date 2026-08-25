import { Text } from '@mantine/core'

/** The tiny uppercase label that opens every section of the console. */
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <Text size="xs" fw={600} tt="uppercase" c="dimmed" lts="0.12em">
      {children}
    </Text>
  )
}

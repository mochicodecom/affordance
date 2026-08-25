import { Alert, List } from '@mantine/core'
import type { CardError } from '@/hooks/use-console'

type Issue = { path?: unknown; message?: string }

/**
 * A refusal (409/422) or client-side input problem, rendered inline on the
 * card it came from: the payload's message, plus `issues` for
 * invalid-input.
 */
export function RefusalNote({ error }: { error: CardError }) {
  const issues = Array.isArray(error.issues) ? (error.issues as Issue[]) : []
  return (
    <Alert color="red" variant="light" p="sm">
      {error.message}
      {issues.length > 0 && (
        <List size="sm" mt={6}>
          {issues.map((issue, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: issues carry no stable identity and the list never reorders
            <List.Item key={index}>
              {Array.isArray(issue.path) ? `${issue.path.join('.')} ` : ''}
              {issue.message ?? JSON.stringify(issue)}
            </List.Item>
          ))}
        </List>
      )}
    </Alert>
  )
}

import {
  Box,
  Button,
  Group,
  NativeSelect,
  Paper,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core'
import { useState } from 'react'
import { Eyebrow } from '@/components/console/eyebrow'
import { RefusalNote } from '@/components/console/refusal-note'
import { type CardError, CREATE_KEY } from '@/hooks/use-console'
import type { CaseSummary } from '@/lib/api'
import { caseLabel } from '@/lib/house-purchase'

type Props = {
  cases: CaseSummary[]
  caseId: string | null
  error: CardError | null
  onSelectCase: (id: string | null) => void
  onCreate: (caseType: string, state: unknown) => Promise<boolean>
  onDelete: () => void
  onInputError: (key: string, message: string) => void
}

/**
 * Pick a case, or start a new one. Creating is not an affordance of the
 * selected case — it starts a whole new one — so here it opens from its
 * own toggle button instead of appearing as a step row. It
 * runs as the console's observer persona (the organizer), and the server
 * enforces the role either way: 403 not-permitted for any actor without
 * it. The form starts empty — the caller authors every value.
 */
/* The shared dev database holds every case the tests ever left behind, so
 * the dropdown shows only the newest few — the staged demo cases are
 * always among them — and says how many older ones exist. The selected
 * case stays listed even when it is no longer among the newest few. */
const MAX_LISTED = 25

export function CaseBlock({
  cases,
  caseId,
  error,
  onSelectCase,
  onCreate,
  onDelete,
  onInputError,
}: Props) {
  const [createOpen, setCreateOpen] = useState(false)

  const shortCase = (row: CaseSummary) =>
    `${caseLabel(row) ?? row.caseTypeName} · ${row.id.replace(/^case:/, '').slice(0, 8)}`

  const listed = cases.slice(0, MAX_LISTED)
  const selected =
    caseId === null ? undefined : cases.find((row) => row.id === caseId)
  if (selected && !listed.some((row) => row.id === selected.id))
    listed.push(selected)
  const older = cases.length - listed.length

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const caseType = (
      form.elements.namedItem('caseType') as HTMLInputElement
    ).value.trim()
    const rawState = (form.elements.namedItem('state') as HTMLTextAreaElement)
      .value
    let state: unknown
    try {
      state = JSON.parse(rawState)
    } catch (parseError) {
      onInputError(
        CREATE_KEY,
        `state is not valid JSON: ${(parseError as Error).message}`,
      )
      return
    }
    if (await onCreate(caseType, state)) setCreateOpen(false)
  }

  return (
    <Box pt="lg">
      <Eyebrow>Case</Eyebrow>
      <Group mt="xs" gap="xs">
        <NativeSelect
          aria-label="Selected case"
          title={caseId ?? ''}
          style={{ minWidth: 200, flex: 1 }}
          value={caseId ?? ''}
          onChange={(event) => onSelectCase(event.target.value || null)}
        >
          {cases.length === 0 ? (
            <option value="">no cases yet</option>
          ) : (
            listed.map((row) => (
              <option key={row.id} value={row.id}>
                {shortCase(row)}
              </option>
            ))
          )}
          {older > 0 && (
            <option value="" disabled>
              …and {older} older cases
            </option>
          )}
        </NativeSelect>
        {/* Deleting acts on the selected case, so it sits with the dropdown;
            creating starts a new one, so it stands apart to the right. */}
        {caseId !== null && (
          <Button
            color="red"
            onClick={() => {
              const chosen = cases.find((row) => row.id === caseId)
              if (
                window.confirm(
                  `Delete ${chosen ? shortCase(chosen) : 'this case'}? Its journal goes with it.`,
                )
              )
                onDelete()
            }}
          >
            Delete case
          </Button>
        )}
        <Button
          variant="default"
          ml="lg"
          onClick={() => setCreateOpen((open) => !open)}
        >
          {createOpen ? 'Cancel' : '＋ New purchase'}
        </Button>
      </Group>
      {createOpen && (
        <Box mt="xs">
          <Paper
            withBorder
            radius="md"
            p="md"
            style={{ borderStyle: 'dashed' }}
          >
            <form onSubmit={submit}>
              <Stack gap="xs">
                <TextInput label="caseType *" type="text" name="caseType" />
                <Textarea
                  label="state (JSON) *"
                  rows={5}
                  name="state"
                  defaultValue="{}"
                  styles={{
                    input: {
                      fontFamily: 'var(--mantine-font-family-monospace)',
                    },
                  }}
                />
                <Group justify="flex-end">
                  <Button type="submit">Create purchase</Button>
                </Group>
              </Stack>
            </form>
            {error?.key === CREATE_KEY && (
              <Box mt="xs">
                <RefusalNote error={error} />
              </Box>
            )}
          </Paper>
          <Text mt={6} size="sm" c="dimmed">
            Not a step on the selected case — this starts a whole new one.
            Offered to organizers only.
          </Text>
        </Box>
      )}
    </Box>
  )
}

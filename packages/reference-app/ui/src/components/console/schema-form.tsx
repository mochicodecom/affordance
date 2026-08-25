import { NativeSelect, Textarea, TextInput } from '@mantine/core'
import type { JsonSchema } from '@/lib/api'

const mono = { input: { fontFamily: 'var(--mantine-font-family-monospace)' } }

/**
 * Form fields from the JSON Schema on the wire: flat string / number /
 * boolean / enum properties become typed fields; anything else — nested
 * objects, arrays, a missing or non-object schema — falls back to one
 * raw-JSON textarea. This is what keeps input rendering contract-driven.
 *
 * Prefills come only from any `default` the schema itself put on the
 * wire — which works for case types this console has never seen.
 *
 * Fields are uncontrolled (defaultValue + data-field/data-kind markers);
 * collectInput reads them back off the submitted form. Mantine spreads
 * unknown props onto the inner input/textarea/select element, so the
 * markers land on the real controls. The refetch after a successful
 * execute replaces the card wholesale, so nothing needs to sync.
 */
export function SchemaFields({ schema: wireSchema }: { schema: unknown }) {
  // The wire says `unknown`: the host serialized whatever its describeInput
  // hook produced. The guards below already handle anything that is not the
  // JSON-Schema shape this form knows how to lay out.
  const schema = wireSchema as JsonSchema | undefined

  if (schema?.type !== 'object' || !schema.properties) {
    return (
      <Textarea
        label="input (raw JSON)"
        rows={4}
        data-field="__raw"
        data-kind="raw"
        defaultValue="{}"
        styles={mono}
      />
    )
  }

  const required = schema.required ?? []
  return (
    <>
      {Object.entries(schema.properties).map(([name, property]) => {
        const mark = required.includes(name) ? ' *' : ''
        const preset = property.default

        if (property.enum) {
          return (
            <NativeSelect
              key={name}
              label={name + mark}
              data-field={name}
              data-kind="string"
              defaultValue={String(preset ?? property.enum[0])}
            >
              {property.enum.map((value) => (
                <option key={String(value)}>{String(value)}</option>
              ))}
            </NativeSelect>
          )
        }
        if (property.type === 'string') {
          return (
            <TextInput
              key={name}
              label={name + mark}
              type="text"
              data-field={name}
              data-kind="string"
              defaultValue={String(preset ?? '')}
            />
          )
        }
        if (property.type === 'number' || property.type === 'integer') {
          return (
            <TextInput
              key={name}
              label={name + mark}
              type="number"
              step="any"
              data-field={name}
              data-kind="number"
              defaultValue={String(preset ?? '')}
            />
          )
        }
        if (property.type === 'boolean') {
          return (
            <NativeSelect
              key={name}
              label={name + mark}
              data-field={name}
              data-kind="boolean"
              defaultValue={String(preset ?? true)}
            >
              <option>true</option>
              <option>false</option>
            </NativeSelect>
          )
        }
        return (
          <Textarea
            key={name}
            label={`${name}${mark} (${property.type || 'nested'} — raw JSON)`}
            rows={3}
            data-field={name}
            data-kind="json"
            defaultValue={
              preset !== undefined
                ? JSON.stringify(preset)
                : property.type === 'array'
                  ? '[]'
                  : '{}'
            }
            styles={mono}
          />
        )
      })}
    </>
  )
}

/**
 * Read a form's data-field inputs back into a step input value. Throws on
 * unparsable JSON — the caller reports that on the originating card.
 */
export function collectInput(form: HTMLFormElement): unknown {
  let input: Record<string, unknown> | undefined
  const fields = form.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >('[data-field]')
  for (const el of fields) {
    const value = el.value
    const { field, kind } = el.dataset as { field: string; kind: string }
    if (kind === 'raw')
      return value.trim() === '' ? undefined : JSON.parse(value)
    if (value === '') continue // omit untouched optional fields
    input = input ?? {}
    input[field] =
      kind === 'json'
        ? JSON.parse(value)
        : kind === 'number'
          ? Number(value)
          : kind === 'boolean'
            ? value === 'true'
            : value
  }
  return input
}

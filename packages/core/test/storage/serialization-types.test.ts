import { expect, expectTypeOf, it } from 'vitest'
import type { PatchOp } from '../../src/index.js'
import type { JsonValue, SerializedValue } from '../../src/storage.js'

it('exposes JSON documents and patch values without runtime-only types', () => {
  expectTypeOf<SerializedValue['json']>().toEqualTypeOf<JsonValue>()
  expectTypeOf<
    Extract<PatchOp, { op: 'add' }>['value']
  >().toEqualTypeOf<JsonValue>()
  // @ts-expect-error Encoded undefined must be represented by null and metadata.
  const undefinedDocument: SerializedValue = { version: 1, json: undefined }
  // @ts-expect-error A bigint must be encoded before becoming patch evidence.
  const bigintPatch: PatchOp = { op: 'add', path: '/json/x', value: 5n }
  void undefinedDocument
  void bigintPatch
  const document: SerializedValue = {
    version: 1,
    json: null,
    meta: { values: ['undefined'], v: 1 },
  }
  expect(JSON.parse(JSON.stringify(document))).toEqual(document)
})

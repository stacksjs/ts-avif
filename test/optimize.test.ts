import { expect, test } from 'bun:test'
import { getItemPayload, parseISOBMFF } from '../src'
import { writeAvif } from '../src/container/writer'
import { optimizeWithStats, remux } from '../src/optimize'

test('remux retains alpha items referenced toward their primary image', () => {
  const color = new Uint8Array([1, 2, 3])
  const alpha = new Uint8Array([7, 8, 9])
  const output = remux(writeAvif(color, 2, 2, alpha))
  const boxes = parseISOBMFF(output)
  expect(getItemPayload(output, boxes, 1)).toEqual(color)
  expect(getItemPayload(output, boxes, 2)).toEqual(alpha)
})

test('retains derived image dependencies and their payloads', () => {
  const input = writeAvif(new Uint8Array([1]), 2, 2, new Uint8Array([7]))
  const bytes = Buffer.from(input)
  const type = bytes.indexOf('auxl')
  input.set(new TextEncoder().encode('dimg'), type)
  const view = new DataView(input.buffer, input.byteOffset)
  view.setUint16(type + 4, 1)
  view.setUint16(type + 8, 2)
  const output = remux(input)
  expect(getItemPayload(output, parseISOBMFF(output), 2)).toEqual(new Uint8Array([7]))
})

test('can retain metadata instead of stripping an EXIF item', () => {
  const input = writeAvif(new Uint8Array([1]), 2, 2, new Uint8Array([7, 8, 9]))
  const bytes = Buffer.from(input)
  const first = bytes.indexOf('av01')
  const second = bytes.indexOf('av01', first + 4)
  input.set(new TextEncoder().encode('Exif'), second)
  input.set(new TextEncoder().encode('cdsc'), bytes.indexOf('auxl'))
  const output = remux(input, { preserveMetadata: true })
  expect(getItemPayload(output, parseISOBMFF(output), 2)).toEqual(new Uint8Array([7, 8, 9]))
  expect(optimizeWithStats(input).stats.droppedItemTypes).toContain('Exif')
})

test('preserves a movie timeline intact instead of stripping animation', () => {
  const input = new Uint8Array(Buffer.concat([writeAvif(new Uint8Array([1]), 2, 2), Buffer.from([0,0,0,8,109,111,111,118])]))
  expect(remux(input)).toEqual(input)
})

test('rejects malformed box sizes instead of accepting truncated container data', () => {
  expect(() => parseISOBMFF(new Uint8Array([0,0,0,4,109,100,97,116]))).toThrow()
  expect(() => parseISOBMFF(new Uint8Array([0,0,0,16,109,100,97,116,1]))).toThrow()
  expect(() => parseISOBMFF(new Uint8Array([0,0,0,1,109,100,97,116]))).toThrow()
  expect(parseISOBMFF(new Uint8Array([0,0,0,8,109,111,111,118]))[0].type).toBe('moov')
})

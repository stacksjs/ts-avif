import { describe, expect, it } from 'bun:test'
import { getAvifItemInfo, getItemPayload } from '../src/container/avif'
import { parseISOBMFF } from '../src/container/heif'
import { writeAvif } from '../src/container/writer'

describe('AVIF container writer', () => {
  it('associates dimensions, pixel format, codec config, and payload with the primary item', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const avif = writeAvif(payload, 321, 123)
    const boxes = parseISOBMFF(avif)
    const info = getAvifItemInfo(avif, boxes)

    expect(boxes.map(box => box.type)).toEqual(['ftyp', 'meta', 'mdat'])
    expect(info.primaryItemId).toBe(1)
    expect(info.primaryItemType).toBe('av01')
    expect(info.width).toBe(321)
    expect(info.height).toBe(123)
    expect(info.bitDepth).toBe(8)
    expect(info.av1C?.chromaSubsamplingX).toBe(1)
    expect(info.av1C?.chromaSubsamplingY).toBe(1)
    expect(getItemPayload(avif, boxes, 1)).toEqual(payload)
  })
})

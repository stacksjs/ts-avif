import { describe, expect, it } from 'bun:test'
import { findAlphaItemId, getAvifItemInfo, getItemPayload } from '../src/container/avif'
import { findBox, parseISOBMFF } from '../src/container/heif'
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

  it('writes alpha as an auxl-linked av01 item typed by auxC', () => {
    const color = new Uint8Array([1, 2, 3])
    const alpha = new Uint8Array([9, 8, 7, 6])
    const avif = writeAvif(color, 64, 32, alpha)
    const boxes = parseISOBMFF(avif)
    const info = getAvifItemInfo(avif, boxes)

    expect(info.primaryItemId).toBe(1)
    expect(info.width).toBe(64)
    expect(getItemPayload(avif, boxes, 1)).toEqual(color)
    expect(getItemPayload(avif, boxes, 2)).toEqual(alpha)
    expect(findAlphaItemId(boxes)).toBe(2)

    const meta = findBox(boxes, 'meta')!
    const iref = findBox(meta.children!, 'iref')!
    expect(iref.children?.map(child => child.type)).toEqual(['auxl'])
  })

  it('does not treat a non-alpha auxiliary image as alpha', () => {
    // Same layout, but the auxC names a depth map.
    const avif = writeAvif(new Uint8Array([1]), 8, 8, new Uint8Array([2]))
    const text = Buffer.from(avif).toString('latin1')
    const at = text.indexOf('urn:mpeg:mpegB:cicp:systems:auxiliary:alpha')
    const depth = new TextEncoder().encode('urn:mpeg:mpegB:cicp:systems:auxiliary:depth')
    const patched = avif.slice()
    patched.set(depth, at)
    expect(findAlphaItemId(parseISOBMFF(patched))).toBeNull()
  })
})

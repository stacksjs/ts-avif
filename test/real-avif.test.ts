import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { decode, getAvifMetadata, getItemPayload, parseISOBMFF } from '../src'
import { parseOBUs } from '../src/av1/obu'
import { OBUType } from '../src/types'

// A real AVIF (photo, 512x384, single av01 item) with a q95 JPEG ground
// truth for the future entropy decoder's PSNR gate.
const fixture = new Uint8Array(
  readFileSync(join(import.meta.dir, 'fixtures', 'photo-small.avif')),
)

describe('getAvifMetadata (real file)', () => {
  it('reads dimensions and codec config per item', () => {
    const meta = getAvifMetadata(fixture)
    expect(meta.width).toBe(512)
    expect(meta.height).toBe(384)
    expect(meta.primaryItemType).toBe('av01')
    expect(meta.av1C).not.toBeNull()
    expect(meta.grid).toBeNull()
  })
})

describe('item payload (real file)', () => {
  it('extracts a parseable AV1 OBU stream', () => {
    const boxes = parseISOBMFF(fixture)
    const meta = getAvifMetadata(fixture)
    const payload = getItemPayload(fixture, boxes, meta.primaryItemId)
    expect(payload).not.toBeNull()
    const obus = parseOBUs(payload!)
    expect(obus.some(o => o.type === OBUType.SEQUENCE_HEADER)).toBe(true)
    expect(obus.some(o => o.type === OBUType.FRAME || o.type === OBUType.TILE_GROUP)).toBe(true)
  })
})

describe('decode (real file)', () => {
  it('fails loudly (not a silent gray placeholder) until the AV1 core lands', () => {
    expect(() => decode(fixture)).toThrow(/AV1 frame decoding is not implemented/)
  })

  // Ground truth for the future entropy decoder:
  // test/fixtures/photo-small.groundtruth.jpg is a q95 JPEG of the correct
  // decode. Once decode() produces pixels, compare with PSNR >= 30dB.
  it.todo('decodes photo-small.avif within 30dB PSNR of the ground truth')
})

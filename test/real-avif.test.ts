import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { decode as decodeJpeg } from 'ts-jpeg'
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
  it('decodes photo-small.avif within 30dB PSNR of the ground truth', () => {
    const img = decode(fixture)
    expect(img.width).toBe(512)
    expect(img.height).toBe(384)
    expect(img.data.length).toBe(512 * 384 * 4)

    const truth = decodeJpeg(
      readFileSync(join(import.meta.dir, 'fixtures', 'photo-small.groundtruth.jpg')),
      { useTArray: true },
    )
    expect(truth.width).toBe(512)
    expect(truth.height).toBe(384)

    // PSNR over RGB (alpha is constant)
    let sse = 0
    let n = 0
    for (let i = 0; i < img.data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const d = img.data[i + c] - truth.data[i + c]
        sse += d * d
        n++
      }
    }
    const mse = sse / n
    const psnr = 10 * Math.log10((255 * 255) / mse)
    expect(psnr).toBeGreaterThanOrEqual(30)
  })
})

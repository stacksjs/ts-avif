import { describe, expect, it } from 'bun:test'
import { decodeAV1 } from '../src/av1/decoder'
import { rgbaToYuv420, encodeIntraTile } from '../src/av1/encode-tile'
import { encodeFrameHeader, encodeSequenceHeader } from '../src/av1/encode-headers'
import { createOBU } from '../src/av1/obu'
import { OBUType } from '../src/types'

function solid(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  const out = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = r
    out[i * 4 + 1] = g
    out[i * 4 + 2] = b
    out[i * 4 + 3] = 255
  }
  return out
}

function encodeRaw(rgba: Uint8Array, width: number, height: number, q = 80): Uint8Array {
  const seq = createOBU(OBUType.SEQUENCE_HEADER, encodeSequenceHeader(width, height))
  const header = encodeFrameHeader(width, height, q)
  const tile = encodeIntraTile(rgbaToYuv420(rgba, width, height), q)
  const payload = new Uint8Array(header.length + tile.length)
  payload.set(header)
  payload.set(tile, header.length)
  const frame = createOBU(OBUType.FRAME, payload)
  const out = new Uint8Array(seq.length + frame.length)
  out.set(seq)
  out.set(frame, seq.length)
  return out
}

describe('pure TypeScript intra tile encoder', () => {
  it('produces a decodable AV1 stream for edge dimensions', () => {
    for (const [width, height] of [[1, 1], [7, 5], [17, 9], [64, 64], [65, 33]]) {
      const decoded = decodeAV1(encodeRaw(solid(width, height, 30, 120, 220), width, height))
      expect(decoded.width).toBe(width)
      expect(decoded.height).toBe(height)
      expect(decoded.data.length).toBe(width * height * 4)
    }
  })

  it('preserves solid colors within the DC quantizer precision', () => {
    for (const rgb of [[0, 0, 0], [255, 255, 255], [220, 40, 30], [30, 120, 220]]) {
      const decoded = decodeAV1(encodeRaw(solid(16, 16, rgb[0], rgb[1], rgb[2]), 16, 16, 60))
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0
        for (let i = channel; i < decoded.data.length; i += 4)
          sum += decoded.data[i]
        expect(Math.abs(sum / 256 - rgb[channel])).toBeLessThanOrEqual(6)
      }
    }
  })

  it('rejects non-opaque pixels instead of discarding alpha', () => {
    const rgba = solid(1, 1, 1, 2, 3)
    rgba[3] = 128
    expect(() => rgbaToYuv420(rgba, 1, 1)).toThrow(/alpha encoding is not implemented/)
  })
})

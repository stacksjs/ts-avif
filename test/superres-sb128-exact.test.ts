import type { PixelPlane } from '../src/av1/pixels'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'bun:test'
import { decodeFrame } from '../src/av1/frame-decoder'
import { parseOBUs } from '../src/av1/obu'
import { parseSequenceHeader } from '../src/av1/sequence'
import { parseFrameOBU } from '../src/av1/tile-group'
import { OBUType } from '../src/types'

/**
 * libaom all-intra output from a deterministic 192x144 YUV gradient. The
 * sequence forces 128x128 superblocks and a 12/8 horizontal super-resolution
 * ratio; the frame also exercises CDEF and Wiener restoration after upscale.
 */
const OBU = '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'

function fnv(plane: PixelPlane): string {
  const prime = 0x100000001B3n
  const mask = 0xFFFFFFFFFFFFFFFFn
  let hash = 1469598103934665603n
  for (const sample of plane) {
    hash ^= BigInt(sample)
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

describe('super-resolution and 128x128 superblocks vs libaom', () => {
  it('matches the reconstructed YUV planes bit-exactly', () => {
    const obus = parseOBUs(new Uint8Array(Buffer.from(OBU, 'base64')))
    const seq = parseSequenceHeader(obus.find(o => o.type === OBUType.SEQUENCE_HEADER)!.data)
    const { header, tiles } = parseFrameOBU(obus.find(o => o.type === OBUType.FRAME)!.data, seq)
    const frame = decodeFrame(seq, header, tiles)

    expect(seq.use128x128Superblock).toBe(true)
    expect(header.frameWidth).toBe(128)
    expect(header.upscaledWidth).toBe(192)
    expect(header.superresDenom).toBe(12)
    expect(header.lr.usesLr).toBe(true)
    expect(frame.width).toBe(192)
    expect(frame.height).toBe(144)
    expect(fnv(frame.buf.y)).toBe('dd4d072318a9b932')
    expect(fnv(frame.buf.u)).toBe('0f34ca218043f7e2')
    expect(fnv(frame.buf.v)).toBe('b8e115300f2e7200')
  })
})

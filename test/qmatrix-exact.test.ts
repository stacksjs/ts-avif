import type { PixelPlane } from '../src/av1/pixels'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'bun:test'
import { decodeFrame } from '../src/av1/frame-decoder'
import { parseOBUs } from '../src/av1/obu'
import { parseSequenceHeader } from '../src/av1/sequence'
import { parseFrameOBU } from '../src/av1/tile-group'
import { OBUType } from '../src/types'

/** libaom all-intra output with luma and chroma quantization level 0. */
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

describe('quantization matrices vs libaom', () => {
  it('matches level-zero luma/chroma matrix reconstruction bit-exactly', () => {
    const obus = parseOBUs(new Uint8Array(Buffer.from(OBU, 'base64')))
    const seq = parseSequenceHeader(obus.find(o => o.type === OBUType.SEQUENCE_HEADER)!.data)
    const { header, tiles } = parseFrameOBU(obus.find(o => o.type === OBUType.FRAME)!.data, seq)
    const frame = decodeFrame(seq, header, tiles)

    expect(header.quantization.usingQMatrix).toBe(true)
    expect(header.quantization.qmY).toBe(0)
    expect(header.quantization.qmU).toBe(0)
    expect(header.quantization.qmV).toBe(0)
    expect(fnv(frame.buf.y)).toBe('447b9eb8f1476256')
    expect(fnv(frame.buf.u)).toBe('30faad87f84e2dda')
    expect(fnv(frame.buf.v)).toBe('7c539d80e6a55e2b')
  })
})


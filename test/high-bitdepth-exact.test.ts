import type { PixelPlane } from '../src/av1/pixels'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'bun:test'
import { decodeFrame } from '../src/av1/frame-decoder'
import { parseOBUs } from '../src/av1/obu'
import { parseSequenceHeader } from '../src/av1/sequence'
import { parseFrameOBU } from '../src/av1/tile-group'
import { OBUType } from '../src/types'

interface Vector {
  name: string
  bitDepth: 10 | 12
  obu: string
  hashes: [string, string, string]
}

/**
 * Still-picture streams encoded by rav1e from deterministic 64x64 gradients.
 * The hashes pin the reconstructed 16-bit little-endian Y/U/V samples emitted
 * by rav1e's independent reconstruction path. Both streams exercise high-bit-
 * depth inverse transforms, deblocking, and CDEF.
 */
const vectors: Vector[] = [
  {
    name: '10-bit deblock + CDEF',
    bitDepth: 10,
    obu: 'EgAKBh/Vf/yoqDI5ZRYzFf/n2MAAIAAQAAAAAAAAAMMMMCCCILScuPfsm3wjYAdlOjbWCwxj4sQ/oNkyuHMMAECIryxq',
    hashes: ['f35a0fbdc300b374', '9d6056f318e24383', '9d6056f318e24383'],
  },
  {
    name: '12-bit deblock + CDEF',
    bitDepth: 12,
    obu: 'EgAKBl/Vf/ysdTI6ZRovE/3n2sAAIAAQAAAAAAAAAMMMMCCCILScuPfsm3wjZemVOjbWCwxj4sQ/oNkzbpUu5vzf89iHgA==',
    hashes: ['a8929bccaa239228', '529d1b3f67668383', '529d1b3f67668383'],
  },
  {
    name: '10-bit CDEF + loop restoration',
    bitDepth: 10,
    obu: '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',
    hashes: ['93f87bbcbaee68da', 'dfa1488dc5c2ba5d', 'f134e44dcf99bf04'],
  },
]

function fnvSamples(plane: PixelPlane): string {
  const prime = 0x100000001B3n
  const mask = 0xFFFFFFFFFFFFFFFFn
  let hash = 1469598103934665603n
  for (const sample of plane) {
    hash ^= BigInt(sample & 0xFF)
    hash = (hash * prime) & mask
    hash ^= BigInt(sample >> 8)
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

describe('high-bit-depth decode vs rav1e reconstruction', () => {
  for (const vector of vectors) {
    it(`matches ${vector.name} YUV planes exactly`, () => {
      const obus = parseOBUs(new Uint8Array(Buffer.from(vector.obu, 'base64')))
      const seq = parseSequenceHeader(obus.find(o => o.type === OBUType.SEQUENCE_HEADER)!.data)
      const { header, tiles } = parseFrameOBU(obus.find(o => o.type === OBUType.FRAME)!.data, seq)
      const frame = decodeFrame(seq, header, tiles)

      expect(seq.bitDepth).toBe(vector.bitDepth)
      expect(frame.buf.y).toBeInstanceOf(Uint16Array)
      expect(fnvSamples(frame.buf.y)).toBe(vector.hashes[0])
      expect(fnvSamples(frame.buf.u)).toBe(vector.hashes[1])
      expect(fnvSamples(frame.buf.v)).toBe(vector.hashes[2])
    })
  }
})

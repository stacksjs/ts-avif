import type { PixelPlane } from '../src/av1/pixels'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'bun:test'
import { decodeFrame } from '../src/av1/frame-decoder'
import { parseOBUs } from '../src/av1/obu'
import { parseSequenceHeader } from '../src/av1/sequence'
import { parseFrameOBU } from '../src/av1/tile-group'
import { OBUType } from '../src/types'

/** Lossless libaom screen-content output with palette disabled and intrabc used. */
const OBU = 'EgAKBxgd///ZAIAy6wFMAACJPF9XxtyzR6xiVhe6KpF8dlE5uLaCSVkvzxi1WVHepsGGZblUYxZzZAwazcqgXqnysz2tGGH3NWGkOkzCumCfzfHE8vD9l6zdmTp7Zel/o32b3iNakrBQFUKoM3TzPMf+Mr+2kTYDmJ8ejv/DF2b27ADARteLUbM2omLqWI/0AlCaniqiM5PxmiMQkGu1IdTb5/44ubhHtzGC/P1Ckt2QC4OknAjUDM4/aWDNnRWP033mAOlZ5FzlLxtgAiDjG/renQPHACRhpZ2TqJDetC7hxHmPM9N2KekRQMuTq8Qg3TXi+4lYqEbR'

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

describe('intra block copy vs libaom', () => {
  it('matches lossless luma/chroma reconstruction bit-exactly', () => {
    const obus = parseOBUs(new Uint8Array(Buffer.from(OBU, 'base64')))
    const seq = parseSequenceHeader(obus.find(o => o.type === OBUType.SEQUENCE_HEADER)!.data)
    const { header, tiles } = parseFrameOBU(obus.find(o => o.type === OBUType.FRAME)!.data, seq)
    const frame = decodeFrame(seq, header, tiles)

    // libaom clears this flag when no block selected intrabc, so this also
    // proves that the fixture reaches the intrabc syntax and predictor path.
    expect(header.allowIntrabc).toBe(true)
    expect(header.codedLossless).toBe(true)
    expect(fnv(frame.buf.y)).toBe('09e2f0d033460383')
    expect(fnv(frame.buf.u)).toBe('e07a450ffbf50383')
    expect(fnv(frame.buf.v)).toBe('acd26aa0d6cea383')
  })
})

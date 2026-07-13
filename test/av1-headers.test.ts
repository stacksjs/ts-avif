import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { getAvifMetadata, getItemPayload, parseISOBMFF } from '../src'
import { BitReader, BitWriter, ceilLog2, floorLog2 } from '../src/av1/bits'
import { encodeSequenceHeader } from '../src/av1/encode-headers'
import { parseOBUs } from '../src/av1/obu'
import { parseSequenceHeader } from '../src/av1/sequence'
import { parseFrameOBU } from '../src/av1/tile-group'
import { OBUType } from '../src/types'

function bitsToBytes(bits: string): Uint8Array {
  const clean = bits.replace(/\s+/g, '')
  const padded = clean.padEnd(Math.ceil(clean.length / 8) * 8, '0')
  const out = new Uint8Array(padded.length / 8)
  for (let i = 0; i < out.length; i++)
    out[i] = Number.parseInt(padded.slice(i * 8, i * 8 + 8), 2)
  return out
}

describe('BitReader', () => {
  it('reads MSB-first bits and fixed-width values', () => {
    const r = new BitReader(bitsToBytes('10110011 01000000'))
    expect(r.readBit()).toBe(1)
    expect(r.readBits(3)).toBe(0b011)
    expect(r.readBits(4)).toBe(0b0011)
    expect(r.readBits(2)).toBe(0b01)
  })

  it('reads uvlc values (spec 4.10.3)', () => {
    // 0 leading zeros -> value 0
    expect(new BitReader(bitsToBytes('1')).uvlc()).toBe(0)
    // "010" -> 1 leading zero, 1 extra bit 0 -> 0 + 2^1 - 1 = 1
    expect(new BitReader(bitsToBytes('010')).uvlc()).toBe(1)
    // "011" -> 1 + 1 = 2
    expect(new BitReader(bitsToBytes('011')).uvlc()).toBe(2)
    // "00111" -> 2 leading zeros, extra bits 11 = 3 -> 3 + 3 = 6
    expect(new BitReader(bitsToBytes('00111')).uvlc()).toBe(6)
  })

  it('reads le, leb128, su, and ns values', () => {
    expect(new BitReader(new Uint8Array([0x34, 0x12])).le(2)).toBe(0x1234)
    expect(new BitReader(new Uint8Array([0xE5, 0x8E, 0x26])).leb128()).toBe(624485)
    expect(new BitReader(bitsToBytes('0110')).su(4)).toBe(6)
    expect(new BitReader(bitsToBytes('1010')).su(4)).toBe(-6)
    // ns(5): w=3, m=3. v = first 2 bits; v<3 -> v
    expect(new BitReader(bitsToBytes('10')).ns(5)).toBe(2)
    // v=3 (11), extra bit 0 -> (3<<1) - 3 + 0 = 3
    expect(new BitReader(bitsToBytes('110')).ns(5)).toBe(3)
    expect(new BitReader(bitsToBytes('111')).ns(5)).toBe(4)
  })

  it('throws on reads past the end', () => {
    const r = new BitReader(new Uint8Array([0xFF]))
    r.readBits(8)
    expect(() => r.readBit()).toThrow(/past end/)
  })

  it('floorLog2 / ceilLog2 match the spec definitions', () => {
    expect(floorLog2(1)).toBe(0)
    expect(floorLog2(2)).toBe(1)
    expect(floorLog2(255)).toBe(7)
    expect(floorLog2(256)).toBe(8)
    expect(ceilLog2(1)).toBe(0)
    expect(ceilLog2(2)).toBe(1)
    expect(ceilLog2(3)).toBe(2)
    expect(ceilLog2(64)).toBe(6)
    expect(ceilLog2(65)).toBe(7)
  })
})

describe('BitWriter', () => {
  it('round-trips fixed, signed, and non-symmetric values', () => {
    const w = new BitWriter()
    w.writeBit(1)
    w.writeBits(0b011, 3)
    w.su(-6, 4)
    for (let i = 0; i < 5; i++)
      w.ns(i, 5)
    w.byteAlign()

    const r = new BitReader(w.finish())
    expect(r.readBit()).toBe(1)
    expect(r.readBits(3)).toBe(0b011)
    expect(r.su(4)).toBe(-6)
    for (let i = 0; i < 5; i++)
      expect(r.ns(5)).toBe(i)
  })
})

describe('encodeSequenceHeader', () => {
  it('round-trips the pure encoder profile and dimensions', () => {
    for (const [width, height] of [[1, 1], [17, 9], [512, 384], [65536, 65536]]) {
      const seq = parseSequenceHeader(encodeSequenceHeader(width, height))
      expect(seq.maxFrameWidth).toBe(width)
      expect(seq.maxFrameHeight).toBe(height)
      expect(seq.seqProfile).toBe(0)
      expect(seq.stillPicture).toBe(true)
      expect(seq.reducedStillPictureHeader).toBe(true)
      expect(seq.bitDepth).toBe(8)
      expect(seq.subsamplingX).toBe(1)
      expect(seq.subsamplingY).toBe(1)
      expect(seq.colorRange).toBe(true)
    }
  })
})

describe('parseSequenceHeader (real file)', () => {
  const fixture = new Uint8Array(
    readFileSync(join(import.meta.dir, 'fixtures', 'photo-small.avif')),
  )

  it('parses the fixture sequence header completely', () => {
    const boxes = parseISOBMFF(fixture)
    const meta = getAvifMetadata(fixture)
    const payload = getItemPayload(fixture, boxes, meta.primaryItemId)!
    const seqOBU = parseOBUs(payload).find(o => o.type === OBUType.SEQUENCE_HEADER)!
    const seq = parseSequenceHeader(seqOBU.data)

    expect(seq.seqProfile).toBe(0)
    expect(seq.maxFrameWidth).toBe(512)
    expect(seq.maxFrameHeight).toBe(384)
    expect(seq.bitDepth).toBe(8)
    expect(seq.monochrome).toBe(false)
    expect(seq.numPlanes).toBe(3)
    expect(seq.subsamplingX).toBe(1)
    expect(seq.subsamplingY).toBe(1)

    // Must agree with the container's av1C record
    expect(seq.seqProfile).toBe(meta.av1C!.seqProfile)
    expect(seq.operatingPoints[0].seqLevelIdx).toBe(meta.av1C!.seqLevelIdx0)
    expect(seq.monochrome).toBe(meta.av1C!.monochrome === 1)
    expect(seq.subsamplingX).toBe(meta.av1C!.chromaSubsamplingX)
    expect(seq.subsamplingY).toBe(meta.av1C!.chromaSubsamplingY)
  })
})

describe('parseFrameOBU (real file)', () => {
  const fixture = new Uint8Array(
    readFileSync(join(import.meta.dir, 'fixtures', 'photo-small.avif')),
  )

  it('parses the intra frame header and slices the tile group', () => {
    const boxes = parseISOBMFF(fixture)
    const meta = getAvifMetadata(fixture)
    const payload = getItemPayload(fixture, boxes, meta.primaryItemId)!
    const obus = parseOBUs(payload)
    const seq = parseSequenceHeader(obus.find(o => o.type === OBUType.SEQUENCE_HEADER)!.data)
    const frameOBU = obus.find(o => o.type === OBUType.FRAME)!
    const { header, tiles } = parseFrameOBU(frameOBU.data, seq)

    expect(header.frameType).toBe(0) // KEY_FRAME
    expect(header.showFrame).toBe(true)
    expect(header.frameWidth).toBe(512)
    expect(header.frameHeight).toBe(384)
    expect(header.miCols).toBe(128)
    expect(header.miRows).toBe(96)
    expect(header.allowIntrabc).toBe(false)
    expect(header.quantization.baseQIdx).toBeGreaterThan(0)
    expect(header.quantization.baseQIdx).toBeLessThan(256)
    expect(header.codedLossless).toBe(false)
    expect(header.segmentation.enabled).toBe(false)

    expect(header.tileInfo.tileCols).toBe(1)
    expect(header.tileInfo.tileRows).toBe(1)
    expect(header.tileInfo.miColStarts).toEqual([0, 128])
    expect(header.tileInfo.miRowStarts).toEqual([0, 96])

    expect(tiles).toHaveLength(1)
    // The single tile owns the whole remaining payload
    expect(tiles[0].data.length).toBeGreaterThan(20000)
    expect(tiles[0].data.length).toBeLessThan(frameOBU.data.length)
  })
})

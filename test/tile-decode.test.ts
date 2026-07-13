import type { Av1Block, Reconstructor, TileDecoder } from '../src/av1/decode-tile'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { getAvifMetadata, getItemPayload, parseISOBMFF } from '../src'
import { CdfContext } from '../src/av1/cdf'
import { TileDecoder as Decoder } from '../src/av1/decode-tile'
import { INTRA_EDGE_TREE } from '../src/av1/intra-edge'
import { parseOBUs } from '../src/av1/obu'
import { parseSequenceHeader } from '../src/av1/sequence'
import { parseFrameOBU } from '../src/av1/tile-group'
import { OBUType } from '../src/types'

/**
 * Entropy-consumption gate: adaptive arithmetic coding desyncs catastrophically
 * on any context or symbol error, so decoding a real 25KB tile to within the
 * decoder's 15-bit lookahead window of the exact stream length validates the
 * partition tree, mode info, and coefficient layers end to end.
 */
describe('TileDecoder (real file)', () => {
  const fixture = new Uint8Array(
    readFileSync(join(import.meta.dir, 'fixtures', 'photo-small.avif')),
  )

  function setup() {
    const boxes = parseISOBMFF(fixture)
    const meta = getAvifMetadata(fixture)
    const payload = getItemPayload(fixture, boxes, meta.primaryItemId)!
    const obus = parseOBUs(payload)
    const seq = parseSequenceHeader(obus.find(o => o.type === OBUType.SEQUENCE_HEADER)!.data)
    const { header, tiles } = parseFrameOBU(obus.find(o => o.type === OBUType.FRAME)!.data, seq)
    return { seq, header, tiles }
  }

  it('consumes the entire tile bitstream exactly', () => {
    const { seq, header, tiles } = setup()
    const cdf = new CdfContext(header.quantization.baseQIdx)
    const dec = new Decoder(seq, header, tiles[0].data, cdf, null)
    dec.decodeTile(INTRA_EDGE_TREE[seq.use128x128Superblock ? 0 : 1])

    const totalBits = tiles[0].data.length * 8
    const overhang = dec.msac.bitsConsumed - totalBits
    // Correct termination: the msac window may hold up to 15 lookahead bits
    // past the final symbol; desync would leave hundreds/thousands of bits.
    expect(overhang).toBeGreaterThanOrEqual(-16)
    expect(overhang).toBeLessThanOrEqual(15)
  })

  it('produces plausible block statistics', () => {
    const { seq, header, tiles } = setup()
    const cdf = new CdfContext(header.quantization.baseQIdx)

    let blocks = 0
    let txBlocks = 0
    let coded = 0
    let luma4x4 = 0
    const modes = new Map<number, number>()
    const counter: Reconstructor = {
      startBlock(_bs: number, b: Av1Block) {
        blocks++
        modes.set(b.yMode, (modes.get(b.yMode) ?? 0) + 1)
      },
      predictCfl() {},
      reconTxBlock(plane: number, _bx4, _by4, _tx, _txtp, eob: number, _cf, _b, _dec: TileDecoder) {
        txBlocks++
        if (eob >= 0)
          coded++
        if (plane === 0)
          luma4x4++
      },
    }
    const dec = new Decoder(seq, header, tiles[0].data, cdf, counter)
    dec.decodeTile(INTRA_EDGE_TREE[seq.use128x128Superblock ? 0 : 1])

    // 512x384 = 128x96 in 4px units; blocks partition that area completely.
    expect(blocks).toBeGreaterThan(100)
    expect(txBlocks).toBeGreaterThan(blocks)
    expect(coded).toBeGreaterThan(0)
    expect(coded).toBeLessThanOrEqual(txBlocks)
    expect(luma4x4).toBeGreaterThan(0)
    // a photo uses a healthy variety of intra modes
    expect(modes.size).toBeGreaterThan(3)
  })
})

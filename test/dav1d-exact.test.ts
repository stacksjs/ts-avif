import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { getAvifMetadata, getItemPayload, parseISOBMFF } from '../src'
import { decodeFrame } from '../src/av1/frame-decoder'
import { parseOBUs } from '../src/av1/obu'
import { parseSequenceHeader } from '../src/av1/sequence'
import { parseFrameOBU } from '../src/av1/tile-group'
import { OBUType } from '../src/types'

/**
 * The strongest fidelity gate: our decoded YUV planes must match dav1d (the
 * reference AV1 decoder) byte-for-byte. The reference was produced by decoding
 * the exact same OBU stream extracted from photo-small.avif:
 *   dav1d -i photo.obu --demuxer section5 -o photo-small.dav1d.y4m
 * This transitively validates the entropy decoder, intra prediction, inverse
 * transforms, reconstruction, AND the deblocking loop filter together.
 */
describe('bit-exact vs dav1d reference decode', () => {
  it('produces identical YUV planes to dav1d', () => {
    const fixture = new Uint8Array(
      readFileSync(join(import.meta.dir, 'fixtures', 'photo-small.avif')),
    )
    const meta = getAvifMetadata(fixture)
    const payload = getItemPayload(fixture, parseISOBMFF(fixture), meta.primaryItemId)!
    const obus = parseOBUs(payload)
    const seq = parseSequenceHeader(obus.find(o => o.type === OBUType.SEQUENCE_HEADER)!.data)
    const { header, tiles } = parseFrameOBU(obus.find(o => o.type === OBUType.FRAME)!.data, seq)
    const frame = decodeFrame(seq, header, tiles)

    const y4m = readFileSync(join(import.meta.dir, 'fixtures', 'photo-small.dav1d.y4m'))
    // skip the "YUV4MPEG2 ..." header line and the "FRAME" line
    let p = 0
    while (y4m[p] !== 0x0A) p++
    p++
    while (y4m[p] !== 0x0A) p++
    p++

    const W = 512
    const H = 384
    const cW = W >> seq.subsamplingX
    const cH = H >> seq.subsamplingY
    const refY = y4m.subarray(p, p + W * H)
    const refU = y4m.subarray(p + W * H, p + W * H + cW * cH)
    const refV = y4m.subarray(p + W * H + cW * cH, p + W * H + 2 * cW * cH)

    let yDiff = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (frame.buf.y[y * frame.buf.yStride + x] !== refY[y * W + x])
          yDiff++
      }
    }
    let uDiff = 0
    let vDiff = 0
    for (let y = 0; y < cH; y++) {
      for (let x = 0; x < cW; x++) {
        if (frame.buf.u[y * frame.buf.uvStride + x] !== refU[y * cW + x])
          uDiff++
        if (frame.buf.v[y * frame.buf.uvStride + x] !== refV[y * cW + x])
          vDiff++
      }
    }

    expect(yDiff).toBe(0)
    expect(uDiff).toBe(0)
    expect(vDiff).toBe(0)
  })
})

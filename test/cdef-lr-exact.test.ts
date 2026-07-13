import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { decodeFrame } from '../src/av1/frame-decoder'
import { parseOBUs } from '../src/av1/obu'
import { parseSequenceHeader } from '../src/av1/sequence'
import { parseFrameOBU } from '../src/av1/tile-group'
import { OBUType } from '../src/types'

/**
 * Bit-exact gate for a stream that exercises CDEF and switchable loop
 * restoration (Wiener + self-guided), plus segmentation and a non-trivial
 * partition layout. The OBU stream was rav1e-encoded and the reference decoded
 * with dav1d:  dav1d -i rav1e.ivf -o rav1e-cdef-lr.dav1d.y4m
 * Complements dav1d-exact.test.ts (which covers the no-post-filter path).
 */
describe('bit-exact vs dav1d: CDEF + loop restoration', () => {
  it('produces identical YUV planes to dav1d', () => {
    const obu = new Uint8Array(
      readFileSync(join(import.meta.dir, 'fixtures', 'rav1e-cdef-lr.obu')),
    )
    const obus = parseOBUs(obu)
    const seq = parseSequenceHeader(obus.find(o => o.type === OBUType.SEQUENCE_HEADER)!.data)
    const { header, tiles } = parseFrameOBU(obus.find(o => o.type === OBUType.FRAME)!.data, seq)
    const frame = decodeFrame(seq, header, tiles)

    const y4m = readFileSync(join(import.meta.dir, 'fixtures', 'rav1e-cdef-lr.dav1d.y4m'))
    let p = 0
    while (y4m[p] !== 0x0A) p++
    p++
    while (y4m[p] !== 0x0A) p++
    p++

    const W = header.frameWidth
    const H = header.frameHeight
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

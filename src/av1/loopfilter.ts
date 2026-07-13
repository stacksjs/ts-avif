/**
 * AV1 deblocking loop filter (spec 7.14), ported from dav1d's loopfilter_tmpl.c
 * kernel plus a spec-style per-edge driver. Filter levels and transform-edge
 * positions are recorded per 4x4 during reconstruction (see LoopFilterData),
 * then applied as a two-pass post-process: all vertical edges, then all
 * horizontal edges, over the whole frame.
 */
import type { FrameHeader } from './frame-header'
import type { SequenceHeader } from './sequence'
import type { FrameBuffers } from './recon'
import { clamp } from './bits'

export interface FilterLut {
  e: Int32Array
  i: Int32Array
}

/** dav1d_calc_eih: E/I thresholds per filter level. */
export function calcFilterLut(sharpness: number): FilterLut {
  const e = new Int32Array(64)
  const i = new Int32Array(64)
  for (let level = 0; level < 64; level++) {
    let limit = level
    if (sharpness > 0) {
      limit >>= (sharpness + 3) >> 2
      limit = Math.min(limit, 9 - sharpness)
    }
    limit = Math.max(limit, 1)
    i[level] = limit
    e[level] = 2 * (level + 2) + limit
  }
  return { e, i }
}

function clipPixel(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

/**
 * Filter one 4-sample run across an edge. `dst`/`off` index the first sample
 * of the run; `sa` steps along the edge (between the 4 runs), `sb` steps
 * across it (p/q direction). `wd` is the filter width (4/6/8/16).
 */
function loopFilterRun(
  dst: Uint8Array,
  off: number,
  E: number,
  I: number,
  H: number,
  sa: number,
  sb: number,
  wd: number,
): void {
  for (let n = 0; n < 4; n++, off += sa) {
    const p1 = dst[off + sb * -2]
    const p0 = dst[off + sb * -1]
    const q0 = dst[off]
    const q1 = dst[off + sb]

    let fm = Math.abs(p1 - p0) <= I && Math.abs(q1 - q0) <= I
      && Math.abs(p0 - q0) * 2 + (Math.abs(p1 - q1) >> 1) <= E
    let p2 = 0
    let p3 = 0
    let q2 = 0
    let q3 = 0
    if (wd > 4) {
      p2 = dst[off + sb * -3]
      q2 = dst[off + sb * 2]
      fm = fm && Math.abs(p2 - p1) <= I && Math.abs(q2 - q1) <= I
      if (wd > 6) {
        p3 = dst[off + sb * -4]
        q3 = dst[off + sb * 3]
        fm = fm && Math.abs(p3 - p2) <= I && Math.abs(q3 - q2) <= I
      }
    }
    if (!fm)
      continue

    let flat8in = false
    let flat8out = false
    let p4 = 0
    let p5 = 0
    let p6 = 0
    let q4 = 0
    let q5 = 0
    let q6 = 0
    if (wd >= 16) {
      p6 = dst[off + sb * -7]
      p5 = dst[off + sb * -6]
      p4 = dst[off + sb * -5]
      q4 = dst[off + sb * 4]
      q5 = dst[off + sb * 5]
      q6 = dst[off + sb * 6]
      flat8out = Math.abs(p6 - p0) <= 1 && Math.abs(p5 - p0) <= 1
        && Math.abs(p4 - p0) <= 1 && Math.abs(q4 - q0) <= 1
        && Math.abs(q5 - q0) <= 1 && Math.abs(q6 - q0) <= 1
    }
    if (wd >= 6) {
      flat8in = Math.abs(p2 - p0) <= 1 && Math.abs(p1 - p0) <= 1
        && Math.abs(q1 - q0) <= 1 && Math.abs(q2 - q0) <= 1
    }
    if (wd >= 8)
      flat8in = flat8in && Math.abs(p3 - p0) <= 1 && Math.abs(q3 - q0) <= 1

    if (wd >= 16 && flat8out && flat8in) {
      dst[off + sb * -6] = (p6 * 7 + p5 * 2 + p4 * 2 + p3 + p2 + p1 + p0 + q0 + 8) >> 4
      dst[off + sb * -5] = (p6 * 5 + p5 * 2 + p4 * 2 + p3 * 2 + p2 + p1 + p0 + q0 + q1 + 8) >> 4
      dst[off + sb * -4] = (p6 * 4 + p5 + p4 * 2 + p3 * 2 + p2 * 2 + p1 + p0 + q0 + q1 + q2 + 8) >> 4
      dst[off + sb * -3] = (p6 * 3 + p5 + p4 + p3 * 2 + p2 * 2 + p1 * 2 + p0 + q0 + q1 + q2 + q3 + 8) >> 4
      dst[off + sb * -2] = (p6 * 2 + p5 + p4 + p3 + p2 * 2 + p1 * 2 + p0 * 2 + q0 + q1 + q2 + q3 + q4 + 8) >> 4
      dst[off + sb * -1] = (p6 + p5 + p4 + p3 + p2 + p1 * 2 + p0 * 2 + q0 * 2 + q1 + q2 + q3 + q4 + q5 + 8) >> 4
      dst[off] = (p5 + p4 + p3 + p2 + p1 + p0 * 2 + q0 * 2 + q1 * 2 + q2 + q3 + q4 + q5 + q6 + 8) >> 4
      dst[off + sb] = (p4 + p3 + p2 + p1 + p0 + q0 * 2 + q1 * 2 + q2 * 2 + q3 + q4 + q5 + q6 * 2 + 8) >> 4
      dst[off + sb * 2] = (p3 + p2 + p1 + p0 + q0 + q1 * 2 + q2 * 2 + q3 * 2 + q4 + q5 + q6 * 3 + 8) >> 4
      dst[off + sb * 3] = (p2 + p1 + p0 + q0 + q1 + q2 * 2 + q3 * 2 + q4 * 2 + q5 + q6 * 4 + 8) >> 4
      dst[off + sb * 4] = (p1 + p0 + q0 + q1 + q2 + q3 * 2 + q4 * 2 + q5 * 2 + q6 * 5 + 8) >> 4
      dst[off + sb * 5] = (p0 + q0 + q1 + q2 + q3 + q4 * 2 + q5 * 2 + q6 * 7 + 8) >> 4
    }
    else if (wd >= 8 && flat8in) {
      dst[off + sb * -3] = (p3 * 3 + 2 * p2 + p1 + p0 + q0 + 4) >> 3
      dst[off + sb * -2] = (p3 * 2 + p2 + 2 * p1 + p0 + q0 + q1 + 4) >> 3
      dst[off + sb * -1] = (p3 + p2 + p1 + 2 * p0 + q0 + q1 + q2 + 4) >> 3
      dst[off] = (p2 + p1 + p0 + 2 * q0 + q1 + q2 + q3 + 4) >> 3
      dst[off + sb] = (p1 + p0 + q0 + 2 * q1 + q2 + q3 * 2 + 4) >> 3
      dst[off + sb * 2] = (p0 + q0 + q1 + 2 * q2 + q3 * 3 + 4) >> 3
    }
    else if (wd === 6 && flat8in) {
      dst[off + sb * -2] = (p2 * 3 + 2 * p1 + 2 * p0 + q0 + 4) >> 3
      dst[off + sb * -1] = (p2 + 2 * p1 + 2 * p0 + 2 * q0 + q1 + 4) >> 3
      dst[off] = (p1 + 2 * p0 + 2 * q0 + 2 * q1 + q2 + 4) >> 3
      dst[off + sb] = (p0 + 2 * q0 + 2 * q1 + 3 * q2 + 4) >> 3
    }
    else {
      const hev = Math.abs(p1 - p0) > H || Math.abs(q1 - q0) > H
      if (hev) {
        let f = clamp(p1 - q1, -128, 127)
        f = clamp(3 * (q0 - p0) + f, -128, 127)
        const f1 = Math.min(f + 4, 127) >> 3
        const f2 = Math.min(f + 3, 127) >> 3
        dst[off + sb * -1] = clipPixel(p0 + f2)
        dst[off] = clipPixel(q0 - f1)
      }
      else {
        const f = clamp(3 * (q0 - p0), -128, 127)
        const f1 = Math.min(f + 4, 127) >> 3
        const f2 = Math.min(f + 3, 127) >> 3
        dst[off + sb * -1] = clipPixel(p0 + f2)
        dst[off] = clipPixel(q0 - f1)
        const f3 = (f1 + 1) >> 1
        dst[off + sb * -2] = clipPixel(p1 + f3)
        dst[off + sb] = clipPixel(q1 - f3)
      }
    }
  }
}

/**
 * Per-4x4 loop-filter metadata for one frame, filled during reconstruction.
 * Level arrays hold the filter level per cell for each plane/direction; tx log
 * dimensions give the filter-width category; stepV/stepH mark transform edges.
 */
export class LoopFilterData {
  lvlYV: Uint8Array
  lvlYH: Uint8Array
  txlwY: Uint8Array
  txlhY: Uint8Array
  stepVY: Uint8Array
  stepHY: Uint8Array
  lvlU: Uint8Array
  lvlV: Uint8Array
  txlwUv: Uint8Array
  txlhUv: Uint8Array
  stepVUv: Uint8Array
  stepHUv: Uint8Array
  readonly cCols: number
  readonly cRows: number

  constructor(readonly miCols: number, readonly miRows: number, readonly ssHor: number, readonly ssVer: number) {
    const n = miCols * miRows
    this.lvlYV = new Uint8Array(n)
    this.lvlYH = new Uint8Array(n)
    this.txlwY = new Uint8Array(n)
    this.txlhY = new Uint8Array(n)
    this.stepVY = new Uint8Array(n)
    this.stepHY = new Uint8Array(n)
    this.cCols = (miCols + ssHor) >> ssHor
    this.cRows = (miRows + ssVer) >> ssVer
    const cn = this.cCols * this.cRows
    this.lvlU = new Uint8Array(cn)
    this.lvlV = new Uint8Array(cn)
    this.txlwUv = new Uint8Array(cn)
    this.txlhUv = new Uint8Array(cn)
    this.stepVUv = new Uint8Array(cn)
    this.stepHUv = new Uint8Array(cn)
  }
}

/**
 * Per-segment loop filter levels [seg][dir] where dir 0..3 = yV,yH,U,V.
 * Intra frames use ref delta 0 and no mode delta.
 */
export function computeLoopFilterLevels(hdr: FrameHeader): Uint8Array {
  const lf = hdr.loopFilter
  const out = new Uint8Array(8 * 4)
  if (lf.levels[0] === 0 && lf.levels[1] === 0)
    return out
  const seg = hdr.segmentation
  const nSeg = seg.enabled ? 8 : 1
  for (let s = 0; s < nSeg; s++) {
    for (let dir = 0; dir < 4; dir++) {
      const baseLvl = lf.levels[dir]
      if (dir >= 2 && baseLvl === 0)
        continue
      // segmentation delta_lf features (SEG_LVL_ALT_LF_*) are 1..4
      const segDelta = seg.enabled && seg.featureEnabled[s][1 + dir]
        ? seg.featureData[s][1 + dir]
        : 0
      const base = clamp(clamp(baseLvl, 0, 63) + segDelta, 0, 63)
      let lvl = base
      if (lf.deltaEnabled) {
        const sh = base >= 32 ? 1 : 0
        lvl = clamp(base + lf.refDeltas[0] * (1 << sh), 0, 63)
      }
      out[s * 4 + dir] = lvl
    }
  }
  return out
}

/** Run the deblocking filter over the whole frame in place. */
export function applyLoopFilter(
  buf: FrameBuffers,
  data: LoopFilterData,
  seq: SequenceHeader,
  hdr: FrameHeader,
): void {
  const lf = hdr.loopFilter
  if (lf.levels[0] === 0 && lf.levels[1] === 0)
    return
  const lut = calcFilterLut(lf.sharpness)

  // Luma: vertical edges (all), then horizontal.
  filterPlane(buf.y, buf.yStride, data.miCols, data.miRows, data.lvlYV, data.lvlYH, data.txlwY, data.txlhY, data.stepVY, data.stepHY, lut, 2, false)

  if (seq.monochrome)
    return

  filterPlane(buf.u, buf.uvStride, data.cCols, data.cRows, data.lvlU, data.lvlU, data.txlwUv, data.txlhUv, data.stepVUv, data.stepHUv, lut, 1, true)
  filterPlane(buf.v, buf.uvStride, data.cCols, data.cRows, data.lvlV, data.lvlV, data.txlwUv, data.txlhUv, data.stepVUv, data.stepHUv, lut, 1, true)
}

function filterPlane(
  plane: Uint8Array,
  stride: number,
  cols: number,
  rows: number,
  lvlV: Uint8Array,
  lvlH: Uint8Array,
  txlw: Uint8Array,
  txlh: Uint8Array,
  stepV: Uint8Array,
  stepH: Uint8Array,
  lut: FilterLut,
  cap: number,
  chroma: boolean,
): void {
  // vertical edges (between columns): iterate columns, then the rows of cells
  for (let x = 1; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      const cell = y * cols + x
      if (!stepV[cell])
        continue
      let L = lvlV[cell]
      if (!L)
        L = lvlV[cell - 1]
      if (!L)
        continue
      const idx = Math.min(cap, Math.min(txlw[cell], txlw[cell - 1]))
      const wd = chroma ? 4 + 2 * idx : 4 << idx
      loopFilterRun(plane, y * 4 * stride + x * 4, lut.e[L], lut.i[L], L >> 4, stride, 1, wd)
    }
  }
  // horizontal edges (between rows)
  for (let y = 1; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cell = y * cols + x
      if (!stepH[cell])
        continue
      let L = lvlH[cell]
      if (!L)
        L = lvlH[(y - 1) * cols + x]
      if (!L)
        continue
      const idx = Math.min(cap, Math.min(txlh[cell], txlh[(y - 1) * cols + x]))
      const wd = chroma ? 4 + 2 * idx : 4 << idx
      loopFilterRun(plane, y * 4 * stride + x * 4, lut.e[L], lut.i[L], L >> 4, 1, stride, wd)
    }
  }
}

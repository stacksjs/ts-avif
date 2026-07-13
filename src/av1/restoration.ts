/**
 * AV1 loop restoration (spec 7.17): reads per-unit Wiener / self-guided filter
 * parameters from the entropy stream (must run to keep the arithmetic decoder
 * in sync), and applies them as a post-process. Ported from dav1d's
 * looprestoration_tmpl.c and the restoration reading in decode.c.
 */
import type { CdfContext } from './cdf'
import type { FrameHeader } from './frame-header'
import type { SequenceHeader } from './sequence'
import type { SymbolDecoder } from './msac'
import { decodeSubexp } from './msac'
import { SGR_PARAMS, SGR_X_BY_X } from './tables'

export const LR_NONE = 0
export const LR_WIENER = 1
export const LR_SGRPROJ = 2

export interface LrUnit {
  type: number
  filterH: Int32Array // 3 coefficients
  filterV: Int32Array
  sgrIdx: number
  sgrWeights: Int32Array // 2
}

interface LrRef {
  filterV: Int32Array
  filterH: Int32Array
  sgrWeights: Int32Array
}

function newRef(): LrRef {
  return {
    filterV: Int32Array.from([3, -7, 15]),
    filterH: Int32Array.from([3, -7, 15]),
    sgrWeights: Int32Array.from([-32, 31]),
  }
}

/** Reads and stores loop-restoration unit parameters during tile decode. */
export class RestorationInfo {
  /** Per-plane flat arrays of units, row-major over the unit grid. */
  units: LrUnit[][] = [[], [], []]
  unitCols = [0, 0, 0]
  unitRows = [0, 0, 0]
  private ref: LrRef[] = [newRef(), newRef(), newRef()]
  /** restore_planes bit i set if plane i has a non-NONE frame restoration. */
  restorePlanes = 0

  constructor(readonly seq: SequenceHeader, readonly hdr: FrameHeader) {
    const lr = hdr.lr
    const w = hdr.frameWidth
    const h = hdr.frameHeight
    for (let p = 0; p < seq.numPlanes; p++) {
      if (lr.frameRestorationType[p] !== 0) // RestorationType.NONE
        this.restorePlanes |= 1 << p
      const ssHor = p ? seq.subsamplingX : 0
      const ssVer = p ? seq.subsamplingY : 0
      const unitSize = lr.loopRestorationSize[p]
      const pw = (w + ssHor) >> ssHor
      const ph = (h + ssVer) >> ssVer
      const cols = countUnits(pw, unitSize)
      const rows = countUnits(ph, unitSize)
      this.unitCols[p] = cols
      this.unitRows[p] = rows
      const arr: LrUnit[] = []
      for (let i = 0; i < cols * rows; i++) {
        arr.push({
          type: LR_NONE,
          filterH: new Int32Array(3),
          filterV: new Int32Array(3),
          sgrIdx: 0,
          sgrWeights: new Int32Array(2),
        })
      }
      this.units[p] = arr
    }
  }

  /**
   * Read restoration info for the superblock at mi (bx, by). Mirrors dav1d's
   * per-SB loop (non-superres path): at each plane's unit boundary, decode one
   * unit's parameters. Must be called for every SB in raster order.
   */
  readForSuperblock(msac: SymbolDecoder, cdf: CdfContext, bx: number, by: number): void {
    const lr = this.hdr.lr
    for (let p = 0; p < this.seq.numPlanes; p++) {
      if (!((this.restorePlanes >> p) & 1))
        continue
      const ssHor = p ? this.seq.subsamplingX : 0
      const ssVer = p ? this.seq.subsamplingY : 0
      const unitSize = lr.loopRestorationSize[p]
      const unitLog2 = 31 - Math.clz32(unitSize)
      const mask = unitSize - 1
      const y = (by * 4) >> ssVer
      const h = (this.hdr.frameHeight + ssVer) >> ssVer
      if (y & mask)
        continue
      const halfUnit = unitSize >> 1
      if (y && y + halfUnit > h)
        continue
      const x = (bx * 4) >> ssHor
      if (x & mask)
        continue
      const w = (this.hdr.frameWidth + ssHor) >> ssHor
      if (x && x + halfUnit > w)
        continue

      const unitCol = x >> unitLog2
      const unitRow = y >> unitLog2
      const unit = this.units[p][unitRow * this.unitCols[p] + unitCol]
      this.readUnit(msac, cdf, p, lr.frameRestorationType[p], unit)
    }
  }

  private readUnit(msac: SymbolDecoder, cdf: CdfContext, p: number, frameType: number, unit: LrUnit): void {
    const ref = this.ref[p]
    // frame restoration type in our enum: 1=WIENER, 2=SGRPROJ, 3=SWITCHABLE
    let type: number
    if (frameType === 3) {
      const filter = msac.decodeSymbol(cdf.data, cdf.offset('restore_switchable'), 2)
      type = filter === 0 ? LR_NONE : filter === 1 ? LR_WIENER : LR_SGRPROJ
    }
    else {
      const cdfName = frameType === 1 ? 'restore_wiener' : 'restore_sgrproj'
      const on = msac.decodeBoolAdapt(cdf.data, cdf.offset(cdfName))
      type = on ? (frameType === 1 ? LR_WIENER : LR_SGRPROJ) : LR_NONE
    }
    unit.type = type

    if (type === LR_WIENER) {
      unit.filterV[0] = p ? 0 : decodeSubexp(msac, ref.filterV[0] + 5, 16, 1) - 5
      unit.filterV[1] = decodeSubexp(msac, ref.filterV[1] + 23, 32, 2) - 23
      unit.filterV[2] = decodeSubexp(msac, ref.filterV[2] + 17, 64, 3) - 17
      unit.filterH[0] = p ? 0 : decodeSubexp(msac, ref.filterH[0] + 5, 16, 1) - 5
      unit.filterH[1] = decodeSubexp(msac, ref.filterH[1] + 23, 32, 2) - 23
      unit.filterH[2] = decodeSubexp(msac, ref.filterH[2] + 17, 64, 3) - 17
      unit.sgrWeights.set(ref.sgrWeights)
      ref.filterV.set(unit.filterV)
      ref.filterH.set(unit.filterH)
    }
    else if (type === LR_SGRPROJ) {
      const idx = msac.readLiteral(4)
      unit.sgrIdx = idx
      const params = [SGR_PARAMS[idx * 2], SGR_PARAMS[idx * 2 + 1]]
      unit.sgrWeights[0] = params[0]
        ? decodeSubexp(msac, ref.sgrWeights[0] + 96, 128, 4) - 96
        : 0
      unit.sgrWeights[1] = params[1]
        ? decodeSubexp(msac, ref.sgrWeights[1] + 32, 128, 4) - 32
        : 95
      unit.filterV.set(ref.filterV)
      unit.filterH.set(ref.filterH)
      ref.sgrWeights.set(unit.sgrWeights)
    }
  }
}

function countUnits(planeSize: number, unitSize: number): number {
  const half = unitSize >> 1
  // Round half up: the last partial unit merges into the previous one.
  return Math.max(1, (planeSize + half) >> (31 - Math.clz32(unitSize)))
}

// Loop-restoration edge flags (dav1d LrEdgeFlags).
const LR_HAVE_LEFT = 1
const LR_HAVE_RIGHT = 2
const LR_HAVE_TOP = 4
const LR_HAVE_BOTTOM = 8

const FOUT = 384 // filter output stride (dav1d FILTER_OUT_STRIDE)

function iclip(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

type SrcFn = (x: number) => number
type LeftFn = ((_k: number) => number) | null
type Row = Int32Array

// --- SGR box-sum kernels (faithful port of dav1d looprestoration_tmpl.c) ---
// Row buffers store index x+1 for x in [-1, w], i.e. valid indices [0, w+1].

function box3RowH(sq: Row, sm: Row, left: LeftFn, src: SrcFn, w: number, edges: number): void {
  const hl = edges & LR_HAVE_LEFT
  const hr = edges & LR_HAVE_RIGHT
  let a = hl ? (left ? left(2) : src(-2)) : src(0)
  let b = hl ? (left ? left(3) : src(-1)) : src(0)
  for (let x = -1; x <= w; x++) {
    const c = (x + 1 < w || hr) ? src(x + 1) : src(w - 1)
    sm[x + 1] = a + b + c
    sq[x + 1] = a * a + b * b + c * c
    a = b
    b = c
  }
}

function box5RowH(sq: Row, sm: Row, left: LeftFn, src: SrcFn, w: number, edges: number): void {
  const hl = edges & LR_HAVE_LEFT
  const hr = edges & LR_HAVE_RIGHT
  let a = hl ? (left ? left(1) : src(-3)) : src(0)
  let b = hl ? (left ? left(2) : src(-2)) : src(0)
  let c = hl ? (left ? left(3) : src(-1)) : src(0)
  let d = src(0)
  for (let x = -1; x <= w; x++) {
    const e = (x + 2 < w || hr) ? src(x + 2) : src(w - 1)
    sm[x + 1] = a + b + c + d + e
    sq[x + 1] = a * a + b * b + c * c + d * d + e * e
    a = b
    b = c
    c = d
    d = e
  }
}

function box3RowV(sqP: Row[], smP: Row[], sqO: Row, smO: Row, w: number): void {
  for (let x = 0; x < w + 2; x++) {
    sqO[x] = sqP[0][x] + sqP[1][x] + sqP[2][x]
    smO[x] = smP[0][x] + smP[1][x] + smP[2][x]
  }
}

function box5RowV(sqP: Row[], smP: Row[], sqO: Row, smO: Row, w: number): void {
  for (let x = 0; x < w + 2; x++) {
    sqO[x] = sqP[0][x] + sqP[1][x] + sqP[2][x] + sqP[3][x] + sqP[4][x]
    smO[x] = smP[0][x] + smP[1][x] + smP[2][x] + smP[3][x] + smP[4][x]
  }
}

function calcRowAB(AA: Row, BB: Row, w: number, s: number, n: number, oneByX: number): void {
  // 8-bit: bitdepth_min_8 == 0, so the a/b down-shifts are no-ops.
  for (let i = 0; i < w + 2; i++) {
    const a = AA[i]
    const b = BB[i]
    const p = Math.max(a * n - b * b, 0)
    const z = (p * s + (1 << 19)) >>> 20 // unsigned; p*s < 2^32
    const x = SGR_X_BY_X[z < 255 ? z : 255]
    AA[i] = (x * BB[i] * oneByX + (1 << 11)) >> 12
    BB[i] = x
  }
}

function rotate(a: Row[], b: Row[], n: number): void {
  const ta = a[0]
  const tb = b[0]
  for (let i = 0; i < n - 1; i++) {
    a[i] = a[i + 1]
    b[i] = b[i + 1]
  }
  a[n - 1] = ta
  b[n - 1] = tb
}

function rotate5x2(a: Row[], b: Row[]): void {
  const a0 = a[0]
  const a1 = a[1]
  const b0 = b[0]
  const b1 = b[1]
  for (let i = 0; i < 3; i++) {
    a[i] = a[i + 2]
    b[i] = b[i + 2]
  }
  a[3] = a0
  a[4] = a1
  b[3] = b0
  b[4] = b1
}

function box3Vert(sqP: Row[], smP: Row[], AA: Row, BB: Row, w: number, s: number): void {
  box3RowV(sqP, smP, AA, BB, w)
  calcRowAB(AA, BB, w, s, 9, 455)
  rotate(sqP, smP, 3)
}

function box5Vert(sqP: Row[], smP: Row[], AA: Row, BB: Row, w: number, s: number): void {
  box5RowV(sqP, smP, AA, BB, w)
  calcRowAB(AA, BB, w, s, 25, 164)
  rotate5x2(sqP, smP)
}

function box3HV(sqP: Row[], smP: Row[], AA: Row, BB: Row, left: LeftFn, src: SrcFn, w: number, s: number, edges: number): void {
  box3RowH(sqP[2], smP[2], left, src, w, edges)
  box3Vert(sqP, smP, AA, BB, w, s)
}

// --- SGR finishing filters ---

function filterRow1(AP: Row[], BP: Row[], w: number, dst: Int32Array, off: number, src: SrcFn): void {
  const A0 = AP[0]
  const A1 = AP[1]
  const A2 = AP[2]
  const B0 = BP[0]
  const B1 = BP[1]
  const B2 = BP[2]
  for (let i = 0; i < w; i++) {
    const j = i + 1
    const a = (B1[j] + B1[j - 1] + B1[j + 1] + B0[j] + B2[j]) * 4
      + (B0[j - 1] + B2[j - 1] + B0[j + 1] + B2[j + 1]) * 3
    const b = (A1[j] + A1[j - 1] + A1[j + 1] + A0[j] + A2[j]) * 4
      + (A0[j - 1] + A2[j - 1] + A0[j + 1] + A2[j + 1]) * 3
    dst[off + i] = (b - a * src(i) + (1 << 8)) >> 9
  }
}

function filterRow2(AP: Row[], BP: Row[], w: number, h: number, dst: Int32Array, src0: SrcFn, src1: SrcFn): void {
  const A0 = AP[0]
  const A1 = AP[1]
  const B0 = BP[0]
  const B1 = BP[1]
  for (let i = 0; i < w; i++) {
    const j = i + 1
    const a = (B0[j] + B1[j]) * 6 + (B0[j - 1] + B1[j - 1] + B0[j + 1] + B1[j + 1]) * 5
    const b = (A0[j] + A1[j]) * 6 + (A0[j - 1] + A1[j - 1] + A0[j + 1] + A1[j + 1]) * 5
    dst[i] = (b - a * src0(i) + (1 << 8)) >> 9
  }
  if (h <= 1)
    return
  for (let i = 0; i < w; i++) {
    const j = i + 1
    const a = B1[j] * 6 + (B1[j - 1] + B1[j + 1]) * 5
    const b = A1[j] * 6 + (A1[j - 1] + A1[j + 1]) * 5
    dst[FOUT + i] = (b - a * src1(i) + (1 << 7)) >> 8
  }
}

// --- Per-unit SGR drivers ---

interface SgrCtx {
  cur: Uint8Array
  buf: Uint8Array
  deb: Uint8Array
  stride: number
  dstride: number
  ux: number
  Y: number
  ph: number
  w: number
  h: number
  edges: number
}

function makeAccessors(ctx: SgrCtx) {
  const { cur, deb, stride, dstride, ux, Y, ph } = ctx
  const clampRow = (r: number): number => (r < 0 ? 0 : r >= ph ? ph - 1 : r)
  const intSrc = (j: number): SrcFn => {
    const base = (Y + j) * stride + ux
    return (x: number) => cur[base + x]
  }
  const intLeft = (j: number): LeftFn => {
    const base = (Y + j) * stride + ux - 4
    return (k: number) => cur[base + k]
  }
  const topSrc = (absRow: number): SrcFn => {
    const base = clampRow(absRow) * dstride + ux
    return (x: number) => deb[base + x]
  }
  return { intSrc, intLeft, topSrc }
}

function weightedRow1(ctx: SgrCtx, row: number, t: Int32Array, off: number, weight: number): void {
  const { cur, buf, stride, ux, w } = ctx
  const base = row * stride + ux
  for (let i = 0; i < w; i++) {
    const v = weight * t[off + i]
    buf[base + i] = iclip(cur[base + i] + ((v + (1 << 10)) >> 11), 0, 255)
  }
}

function weighted2(ctx: SgrCtx, row: number, h: number, t5: Int32Array, t3: Int32Array, w0: number, w1: number): void {
  const { cur, buf, stride, ux, w } = ctx
  for (let jr = 0; jr < h; jr++) {
    const base = (row + jr) * stride + ux
    for (let i = 0; i < w; i++) {
      const v = w0 * t5[jr * FOUT + i] + w1 * t3[jr * FOUT + i]
      buf[base + i] = iclip(cur[base + i] + ((v + (1 << 10)) >> 11), 0, 255)
    }
  }
}

function newRows(n: number, len: number): Row[] {
  const r: Row[] = []
  for (let i = 0; i < n; i++)
    r.push(new Int32Array(len))
  return r
}

function sgr3x3(ctx: SgrCtx, s: number, w1: number): void {
  const { w, Y } = ctx
  const acc = makeAccessors(ctx)
  const len = w + 3
  const sqRows = newRows(3, len)
  const smRows = newRows(3, len)
  const sqP: Row[] = [sqRows[0], sqRows[1], sqRows[2]]
  const smP: Row[] = [smRows[0], smRows[1], smRows[2]]
  const A = newRows(3, len)
  const B = newRows(3, len)
  const AP: Row[] = [A[0], A[1], A[2]]
  const BP: Row[] = [B[0], B[1], B[2]]
  const tmp = new Int32Array(FOUT)
  const d = { row: Y }
  let h = ctx.h
  let jj = 0
  const finish1Src = (): void => {
    filterRow1(AP, BP, w, tmp, 0, acc.intSrc(d.row - Y))
    weightedRow1(ctx, d.row, tmp, 0, w1)
    d.row++
    rotate(AP, BP, 3)
  }
  const vert = (): void => {
    sqP[2] = sqP[1]
    smP[2] = smP[1]
    box3Vert(sqP, smP, AP[2], BP[2], w, s)
  }
  const bh = ctx.edges & LR_HAVE_BOTTOM
  const lb = Y + ctx.h

  if (ctx.edges & LR_HAVE_TOP) {
    box3RowH(sqRows[0], smRows[0], null, acc.topSrc(Y - 2), w, ctx.edges)
    box3RowH(sqRows[1], smRows[1], null, acc.topSrc(Y - 1), w, ctx.edges)
    box3HV(sqP, smP, AP[2], BP[2], acc.intLeft(jj), acc.intSrc(jj), w, s, ctx.edges)
    jj++
    rotate(AP, BP, 3)
    if (--h <= 0) { vert(); rotate(AP, BP, 3); vert(); finish1Src(); return }
    box3HV(sqP, smP, AP[2], BP[2], acc.intLeft(jj), acc.intSrc(jj), w, s, ctx.edges)
    jj++
    rotate(AP, BP, 3)
    if (--h <= 0) { vert(); finish1Src(); vert(); finish1Src(); return }
  }
  else {
    sqP[0] = sqRows[0]
    sqP[1] = sqRows[0]
    sqP[2] = sqRows[0]
    smP[0] = smRows[0]
    smP[1] = smRows[0]
    smP[2] = smRows[0]
    box3RowH(sqRows[0], smRows[0], acc.intLeft(jj), acc.intSrc(jj), w, ctx.edges)
    jj++
    box3Vert(sqP, smP, AP[2], BP[2], w, s)
    rotate(AP, BP, 3)
    if (--h <= 0) { vert(); rotate(AP, BP, 3); vert(); finish1Src(); return }
    sqP[2] = sqRows[1]
    smP[2] = smRows[1]
    box3HV(sqP, smP, AP[2], BP[2], acc.intLeft(jj), acc.intSrc(jj), w, s, ctx.edges)
    jj++
    rotate(AP, BP, 3)
    if (--h <= 0) { vert(); finish1Src(); vert(); finish1Src(); return }
    sqP[2] = sqRows[2]
    smP[2] = smRows[2]
  }

  do {
    box3HV(sqP, smP, AP[2], BP[2], acc.intLeft(jj), acc.intSrc(jj), w, s, ctx.edges)
    jj++
    finish1Src()
  } while (--h > 0)

  if (!bh) { vert(); finish1Src(); vert(); finish1Src(); return }

  box3HV(sqP, smP, AP[2], BP[2], null, acc.topSrc(lb), w, s, ctx.edges)
  finish1Src()
  box3HV(sqP, smP, AP[2], BP[2], null, acc.topSrc(lb + 1), w, s, ctx.edges)
  finish1Src()
}

function sgr5x5(ctx: SgrCtx, s: number, w0: number): void {
  const { w, Y } = ctx
  const acc = makeAccessors(ctx)
  const len = w + 3
  const sqRows = newRows(5, len)
  const smRows = newRows(5, len)
  const sqP: Row[] = [sqRows[0], sqRows[1], sqRows[2], sqRows[3], sqRows[4]]
  const smP: Row[] = [smRows[0], smRows[1], smRows[2], smRows[3], smRows[4]]
  const A = newRows(2, len)
  const B = newRows(2, len)
  const AP: Row[] = [A[0], A[1]]
  const BP: Row[] = [B[0], B[1]]
  const tmp = new Int32Array(2 * FOUT)
  const d = { row: Y }
  let h = ctx.h
  let jj = 0
  const bh = ctx.edges & LR_HAVE_BOTTOM
  const lb = Y + ctx.h

  const finish2 = (rows: number): void => {
    const outJ = d.row - Y
    filterRow2(AP, BP, w, rows, tmp, acc.intSrc(outJ), acc.intSrc(outJ + 1))
    weightedRow1(ctx, d.row, tmp, 0, w0)
    d.row++
    if (rows > 1) {
      weightedRow1(ctx, d.row, tmp, FOUT, w0)
      d.row++
    }
    rotate(AP, BP, 2)
  }
  const boxh = (r: number, left: LeftFn, src: SrcFn): void => box5RowH(sqP[r], smP[r], left, src, w, ctx.edges)

  const vert2 = (): void => {
    sqP[3] = sqP[2]
    sqP[4] = sqP[2]
    smP[3] = smP[2]
    smP[4] = smP[2]
    box5Vert(sqP, smP, AP[1], BP[1], w, s)
    finish2(2)
  }
  const output1 = (): void => {
    sqP[3] = sqP[2]
    sqP[4] = sqP[2]
    smP[3] = smP[2]
    smP[4] = smP[2]
    box5Vert(sqP, smP, AP[1], BP[1], w, s)
    finish2(1)
  }
  const odd = (): void => {
    sqP[4] = sqP[3]
    smP[4] = smP[3]
    box5Vert(sqP, smP, AP[1], BP[1], w, s)
    finish2(2)
    output1()
  }
  const vert1 = (): void => {
    sqP[4] = sqP[3]
    smP[4] = smP[3]
    box5Vert(sqP, smP, AP[1], BP[1], w, s)
    rotate(AP, BP, 2)
    output1()
  }

  if (ctx.edges & LR_HAVE_TOP) {
    sqP[0] = sqRows[0]; sqP[1] = sqRows[0]; sqP[2] = sqRows[1]; sqP[3] = sqRows[2]; sqP[4] = sqRows[3]
    smP[0] = smRows[0]; smP[1] = smRows[0]; smP[2] = smRows[1]; smP[3] = smRows[2]; smP[4] = smRows[3]
    box5RowH(sqRows[0], smRows[0], null, acc.topSrc(Y - 2), w, ctx.edges)
    box5RowH(sqRows[1], smRows[1], null, acc.topSrc(Y - 1), w, ctx.edges)
    box5RowH(sqRows[2], smRows[2], acc.intLeft(jj), acc.intSrc(jj), w, ctx.edges)
    jj++
    if (--h <= 0) { vert1(); return }
    box5RowH(sqRows[3], smRows[3], acc.intLeft(jj), acc.intSrc(jj), w, ctx.edges)
    jj++
    box5Vert(sqP, smP, AP[1], BP[1], w, s)
    rotate(AP, BP, 2)
    if (--h <= 0) { vert2(); return }
    sqP[3] = sqRows[4]
    smP[3] = smRows[4]
  }
  else {
    for (let i = 0; i < 5; i++) { sqP[i] = sqRows[0]; smP[i] = smRows[0] }
    box5RowH(sqRows[0], smRows[0], acc.intLeft(jj), acc.intSrc(jj), w, ctx.edges)
    jj++
    if (--h <= 0) { vert1(); return }
    sqP[4] = sqRows[1]
    smP[4] = smRows[1]
    box5RowH(sqRows[1], smRows[1], acc.intLeft(jj), acc.intSrc(jj), w, ctx.edges)
    jj++
    box5Vert(sqP, smP, AP[1], BP[1], w, s)
    rotate(AP, BP, 2)
    if (--h <= 0) { vert2(); return }
    sqP[3] = sqRows[2]; sqP[4] = sqRows[3]
    smP[3] = smRows[2]; smP[4] = smRows[3]
    box5RowH(sqRows[2], smRows[2], acc.intLeft(jj), acc.intSrc(jj), w, ctx.edges)
    jj++
    if (--h <= 0) { odd(); return }
    box5RowH(sqRows[3], smRows[3], acc.intLeft(jj), acc.intSrc(jj), w, ctx.edges)
    jj++
    box5Vert(sqP, smP, AP[1], BP[1], w, s)
    finish2(2)
    if (--h <= 0) { vert2(); return }
    sqP[3] = sqRows[4]
    smP[3] = smRows[4]
  }

  for (;;) {
    boxh(3, acc.intLeft(jj), acc.intSrc(jj))
    jj++
    if (--h <= 0) { odd(); return }
    boxh(4, acc.intLeft(jj), acc.intSrc(jj))
    jj++
    box5Vert(sqP, smP, AP[1], BP[1], w, s)
    finish2(2)
    if (--h <= 0)
      break
  }

  if (!bh) { vert2(); return }
  boxh(3, null, acc.topSrc(lb))
  boxh(4, null, acc.topSrc(lb + 1))
  box5Vert(sqP, smP, AP[1], BP[1], w, s)
  finish2(2)
}

function sgrMix(ctx: SgrCtx, s0: number, s1: number, w0: number, w1: number): void {
  const { w, Y } = ctx
  const acc = makeAccessors(ctx)
  const len = w + 3
  const sq5Rows = newRows(5, len)
  const sm5Rows = newRows(5, len)
  const sq5P: Row[] = [sq5Rows[0], sq5Rows[1], sq5Rows[2], sq5Rows[3], sq5Rows[4]]
  const sm5P: Row[] = [sm5Rows[0], sm5Rows[1], sm5Rows[2], sm5Rows[3], sm5Rows[4]]
  const sq3Rows = newRows(3, len)
  const sm3Rows = newRows(3, len)
  const sq3P: Row[] = [sq3Rows[0], sq3Rows[1], sq3Rows[2]]
  const sm3P: Row[] = [sm3Rows[0], sm3Rows[1], sm3Rows[2]]
  const A5 = newRows(2, len)
  const B5 = newRows(2, len)
  const A5P: Row[] = [A5[0], A5[1]]
  const B5P: Row[] = [B5[0], B5[1]]
  const A3 = newRows(4, len)
  const B3 = newRows(4, len)
  const A3P: Row[] = [A3[0], A3[1], A3[2], A3[3]]
  const B3P: Row[] = [B3[0], B3[1], B3[2], B3[3]]
  const tmp5 = new Int32Array(2 * FOUT)
  const tmp3 = new Int32Array(2 * FOUT)
  const d = { row: Y }
  let h = ctx.h
  let jj = 0
  const bh = ctx.edges & LR_HAVE_BOTTOM
  const lb = Y + ctx.h

  const box35 = (r3: Row, s3: Row, r5: Row, s5: Row, left: LeftFn, src: SrcFn): void => {
    box3RowH(r3, s3, left, src, w, ctx.edges)
    box5RowH(r5, s5, left, src, w, ctx.edges)
  }
  const finishMix = (rows: number): void => {
    const outJ = d.row - Y
    filterRow2(A5P, B5P, w, rows, tmp5, acc.intSrc(outJ), acc.intSrc(outJ + 1))
    filterRow1(A3P, B3P, w, tmp3, 0, acc.intSrc(outJ))
    if (rows > 1) {
      const A3s: Row[] = [A3P[1], A3P[2], A3P[3]]
      const B3s: Row[] = [B3P[1], B3P[2], B3P[3]]
      filterRow1(A3s, B3s, w, tmp3, FOUT, acc.intSrc(outJ + 1))
    }
    weighted2(ctx, d.row, rows, tmp5, tmp3, w0, w1)
    d.row += rows
    rotate(A5P, B5P, 2)
    rotate(A3P, B3P, 4)
  }

  const vert2 = (): void => {
    sq5P[3] = sq5P[2]; sq5P[4] = sq5P[2]; sm5P[3] = sm5P[2]; sm5P[4] = sm5P[2]
    sq3P[2] = sq3P[1]; sm3P[2] = sm3P[1]
    box3Vert(sq3P, sm3P, A3P[3], B3P[3], w, s1)
    rotate(A3P, B3P, 4)
    sq3P[2] = sq3P[1]; sm3P[2] = sm3P[1]
    // output_2:
    box5Vert(sq5P, sm5P, A5P[1], B5P[1], w, s0)
    box3Vert(sq3P, sm3P, A3P[3], B3P[3], w, s1)
    finishMix(2)
  }
  const output2 = (): void => {
    box5Vert(sq5P, sm5P, A5P[1], B5P[1], w, s0)
    box3Vert(sq3P, sm3P, A3P[3], B3P[3], w, s1)
    finishMix(2)
  }
  const output1 = (): void => {
    sq5P[3] = sq5P[2]; sq5P[4] = sq5P[2]; sm5P[3] = sm5P[2]; sm5P[4] = sm5P[2]
    sq3P[2] = sq3P[1]; sm3P[2] = sm3P[1]
    box5Vert(sq5P, sm5P, A5P[1], B5P[1], w, s0)
    box3Vert(sq3P, sm3P, A3P[3], B3P[3], w, s1)
    rotate(A3P, B3P, 4)
    finishMix(1)
  }
  const odd = (): void => {
    sq5P[4] = sq5P[3]; sm5P[4] = sm5P[3]
    sq3P[2] = sq3P[1]; sm3P[2] = sm3P[1]
    box5Vert(sq5P, sm5P, A5P[1], B5P[1], w, s0)
    box3Vert(sq3P, sm3P, A3P[3], B3P[3], w, s1)
    finishMix(2)
    output1()
  }
  const vert1 = (): void => {
    sq5P[4] = sq5P[3]; sm5P[4] = sm5P[3]
    sq3P[2] = sq3P[1]; sm3P[2] = sm3P[1]
    box5Vert(sq5P, sm5P, A5P[1], B5P[1], w, s0)
    rotate(A5P, B5P, 2)
    box3Vert(sq3P, sm3P, A3P[3], B3P[3], w, s1)
    rotate(A3P, B3P, 4)
    output1()
  }

  if (ctx.edges & LR_HAVE_TOP) {
    sq5P[0] = sq5Rows[0]; sq5P[1] = sq5Rows[0]; sq5P[2] = sq5Rows[1]; sq5P[3] = sq5Rows[2]; sq5P[4] = sq5Rows[3]
    sm5P[0] = sm5Rows[0]; sm5P[1] = sm5Rows[0]; sm5P[2] = sm5Rows[1]; sm5P[3] = sm5Rows[2]; sm5P[4] = sm5Rows[3]
    sq3P[0] = sq3Rows[0]; sq3P[1] = sq3Rows[1]; sq3P[2] = sq3Rows[2]
    sm3P[0] = sm3Rows[0]; sm3P[1] = sm3Rows[1]; sm3P[2] = sm3Rows[2]
    box35(sq3Rows[0], sm3Rows[0], sq5Rows[0], sm5Rows[0], null, acc.topSrc(Y - 2))
    box35(sq3Rows[1], sm3Rows[1], sq5Rows[1], sm5Rows[1], null, acc.topSrc(Y - 1))
    box35(sq3Rows[2], sm3Rows[2], sq5Rows[2], sm5Rows[2], acc.intLeft(jj), acc.intSrc(jj))
    jj++
    box3Vert(sq3P, sm3P, A3P[3], B3P[3], w, s1)
    rotate(A3P, B3P, 4)
    if (--h <= 0) { vert1(); return }
    box35(sq3P[2], sm3P[2], sq5Rows[3], sm5Rows[3], acc.intLeft(jj), acc.intSrc(jj))
    jj++
    box5Vert(sq5P, sm5P, A5P[1], B5P[1], w, s0)
    rotate(A5P, B5P, 2)
    box3Vert(sq3P, sm3P, A3P[3], B3P[3], w, s1)
    rotate(A3P, B3P, 4)
    if (--h <= 0) { vert2(); return }
    sq5P[3] = sq5Rows[4]
    sm5P[3] = sm5Rows[4]
  }
  else {
    for (let i = 0; i < 5; i++) { sq5P[i] = sq5Rows[0]; sm5P[i] = sm5Rows[0] }
    sq3P[0] = sq3Rows[0]; sq3P[1] = sq3Rows[0]; sq3P[2] = sq3Rows[0]
    sm3P[0] = sm3Rows[0]; sm3P[1] = sm3Rows[0]; sm3P[2] = sm3Rows[0]
    box35(sq3Rows[0], sm3Rows[0], sq5Rows[0], sm5Rows[0], acc.intLeft(jj), acc.intSrc(jj))
    jj++
    box3Vert(sq3P, sm3P, A3P[3], B3P[3], w, s1)
    rotate(A3P, B3P, 4)
    if (--h <= 0) { vert1(); return }
    sq5P[4] = sq5Rows[1]
    sm5P[4] = sm5Rows[1]
    sq3P[2] = sq3Rows[1]
    sm3P[2] = sm3Rows[1]
    box35(sq3Rows[1], sm3Rows[1], sq5Rows[1], sm5Rows[1], acc.intLeft(jj), acc.intSrc(jj))
    jj++
    box5Vert(sq5P, sm5P, A5P[1], B5P[1], w, s0)
    rotate(A5P, B5P, 2)
    box3Vert(sq3P, sm3P, A3P[3], B3P[3], w, s1)
    rotate(A3P, B3P, 4)
    if (--h <= 0) { vert2(); return }
    sq5P[3] = sq5Rows[2]; sq5P[4] = sq5Rows[3]
    sm5P[3] = sm5Rows[2]; sm5P[4] = sm5Rows[3]
    sq3P[2] = sq3Rows[2]
    sm3P[2] = sm3Rows[2]
    box35(sq3Rows[2], sm3Rows[2], sq5Rows[2], sm5Rows[2], acc.intLeft(jj), acc.intSrc(jj))
    jj++
    box3Vert(sq3P, sm3P, A3P[3], B3P[3], w, s1)
    rotate(A3P, B3P, 4)
    if (--h <= 0) { odd(); return }
    box35(sq3P[2], sm3P[2], sq5Rows[3], sm5Rows[3], acc.intLeft(jj), acc.intSrc(jj))
    jj++
    box5Vert(sq5P, sm5P, A5P[1], B5P[1], w, s0)
    box3Vert(sq3P, sm3P, A3P[3], B3P[3], w, s1)
    finishMix(2)
    if (--h <= 0) { vert2(); return }
    sq5P[3] = sq5Rows[4]
    sm5P[3] = sm5Rows[4]
  }

  for (;;) {
    box35(sq3P[2], sm3P[2], sq5P[3], sm5P[3], acc.intLeft(jj), acc.intSrc(jj))
    jj++
    box3Vert(sq3P, sm3P, A3P[3], B3P[3], w, s1)
    rotate(A3P, B3P, 4)
    if (--h <= 0) { odd(); return }
    box35(sq3P[2], sm3P[2], sq5P[4], sm5P[4], acc.intLeft(jj), acc.intSrc(jj))
    jj++
    box5Vert(sq5P, sm5P, A5P[1], B5P[1], w, s0)
    box3Vert(sq3P, sm3P, A3P[3], B3P[3], w, s1)
    finishMix(2)
    if (--h <= 0)
      break
  }

  if (!bh) { vert2(); return }
  box35(sq3P[2], sm3P[2], sq5P[3], sm5P[3], null, acc.topSrc(lb))
  box3Vert(sq3P, sm3P, A3P[3], B3P[3], w, s1)
  rotate(A3P, B3P, 4)
  box35(sq3P[2], sm3P[2], sq5P[4], sm5P[4], null, acc.topSrc(lb + 1))
  output2()
}

// --- Stripe / superblock-row driver (port of dav1d lr_apply_tmpl.c) ---

function processUnit(ctx: SgrCtx, unit: LrUnit): void {
  if (unit.type === LR_SGRPROJ) {
    const s0 = SGR_PARAMS[unit.sgrIdx * 2]
    const s1 = SGR_PARAMS[unit.sgrIdx * 2 + 1]
    const w0 = unit.sgrWeights[0]
    const w1 = 128 - (unit.sgrWeights[0] + unit.sgrWeights[1])
    if (s0 && s1)
      sgrMix(ctx, s0, s1, w0, w1)
    else if (s0)
      sgr5x5(ctx, s0, w0)
    else
      sgr3x3(ctx, s1, w1)
  }
  else if (unit.type === LR_WIENER) {
    wienerUnit(ctx, unit)
  }
}

export function applyRestoration(
  postCdef: { y: Uint8Array, u: Uint8Array, v: Uint8Array, yStride: number, uvStride: number },
  info: RestorationInfo,
  seq: SequenceHeader,
  hdr: FrameHeader,
  deblocked: { y: Uint8Array, u: Uint8Array, v: Uint8Array },
): void {
  const sb128 = seq.use128x128Superblock ? 1 : 0
  const W = hdr.frameWidth
  const H = hdr.frameHeight
  const sbSize = 64 << sb128
  const sbh = (H + sbSize - 1) >> (6 + sb128)

  const curY = postCdef.y.slice()
  const curU = postCdef.u.slice()
  const curV = postCdef.v.slice()

  for (let p = 0; p < seq.numPlanes; p++) {
    if (!((info.restorePlanes >> p) & 1))
      continue
    const ssHor = p ? seq.subsamplingX : 0
    const ssVer = p ? seq.subsamplingY : 0
    const pw = (W + ssHor) >> ssHor
    const ph = (H + ssVer) >> ssVer
    const stride = p ? postCdef.uvStride : postCdef.yStride
    const buf = p === 0 ? postCdef.y : p === 1 ? postCdef.u : postCdef.v
    const cur = p === 0 ? curY : p === 1 ? curU : curV
    const deb = p === 0 ? deblocked.y : p === 1 ? deblocked.u : deblocked.v
    const unitSize = hdr.lr.loopRestorationSize[p]
    const unitLog2 = 31 - Math.clz32(unitSize)
    const half = unitSize >> 1
    const maxUnit = unitSize + half
    const units = info.units[p]
    const unitCols = info.unitCols[p]
    const shift = (6 - ssVer) + sb128

    for (let sby = 0; sby < sbh; sby++) {
      const notLast = sby + 1 < sbh
      const offset = (8 * (sby > 0 ? 1 : 0)) >> ssVer
      const nextRowY = (sby + 1) << shift
      const rowH = Math.min(nextRowY - (8 >> ssVer) * (notLast ? 1 : 0), ph)
      const yStripe = (sby << shift) - offset

      // Select the unit row for this superblock row.
      const rowY = yStripe + (8 >> ssVer) * (yStripe > 0 ? 1 : 0)
      let aligned = rowY & ~(unitSize - 1)
      if (aligned && aligned + half > ph)
        aligned -= unitSize
      const unitRow = aligned >> unitLog2

      let edges = (yStripe > 0 ? LR_HAVE_TOP : 0) | LR_HAVE_RIGHT
      let x = 0
      let unit = units[unitRow * unitCols]
      let restore = unit.type !== LR_NONE

      const runStripe = (u: LrUnit, xx: number, unitW: number, e: number): void => {
        let y = yStripe
        let stripeH = Math.min((64 - 8 * (y === 0 ? 1 : 0)) >> ssVer, rowH - y)
        while (y + stripeH <= rowH) {
          const sbyLocal = (y + (y > 0 ? 8 << ssVer : 0)) >> shift
          const haveBottom = (sbyLocal + 1 !== sbh) || (y + stripeH !== rowH)
          const e2 = haveBottom ? (e | LR_HAVE_BOTTOM) : (e & ~LR_HAVE_BOTTOM)
          const ctx: SgrCtx = {
            cur, buf, deb, stride, dstride: stride, ux: xx, Y: y, ph, w: unitW, h: stripeH, edges: e2,
          }
          processUnit(ctx, u)
          y += stripeH
          e |= LR_HAVE_TOP
          stripeH = Math.min(64 >> ssVer, rowH - y)
          if (stripeH === 0)
            break
        }
      }

      while (x + maxUnit <= pw) {
        const nextX = x + unitSize
        const nextCol = Math.min(nextX >> unitLog2, unitCols - 1)
        const nextUnit = units[unitRow * unitCols + nextCol]
        const restoreNext = nextUnit.type !== LR_NONE
        if (restore)
          runStripe(unit, x, unitSize, edges)
        x = nextX
        unit = nextUnit
        restore = restoreNext
        edges |= LR_HAVE_LEFT
      }
      if (restore) {
        edges &= ~LR_HAVE_RIGHT
        runStripe(unit, x, pw - x, edges)
      }
    }
  }
}

// --- Wiener (classic padded whole-buffer form; not exercised by this stream) ---

const REST_STRIDE = 390

function wienerUnit(ctx: SgrCtx, unit: LrUnit): void {
  const { cur, buf, deb, stride, ux, Y, ph, w, h, edges } = ctx
  const fh0 = unit.filterH[0]
  const fh1 = unit.filterH[1]
  const fh2 = unit.filterH[2]
  const fv0 = unit.filterV[0]
  const fv1 = unit.filterV[1]
  const fv2 = unit.filterV[2]
  const fh = [fh0, fh1, fh2, -(fh0 + fh1 + fh2) * 2, fh2, fh1, fh0]
  const fv = [fv0, fv1, fv2, 128 - (fv0 + fv1 + fv2) * 2, fv2, fv1, fv0]
  const P = REST_STRIDE
  const hl = edges & LR_HAVE_LEFT ? 1 : 0
  const hr = edges & LR_HAVE_RIGHT ? 1 : 0
  const haveTop = edges & LR_HAVE_TOP
  const haveBottom = edges & LR_HAVE_BOTTOM
  const unitW = w + 3 * hl + 3 * hr
  const dstL = 3 * (1 - hl)
  const pCol0 = -3 * hl
  const clampRow = (r: number): number => (r < 0 ? 0 : r >= ph ? ph - 1 : r)
  const curAt = (row: number, col: number): number => cur[row * stride + ux + col]
  const debAt = (row: number, col: number): number => deb[clampRow(row) * stride + ux + col]
  const leftAt = (j: number, k: number): number => cur[(Y + j) * stride + ux - 4 + k]
  const tmp = new Uint8Array((h + 6) * P)

  for (let k = 0; k < unitW; k++) {
    const col = pCol0 + k
    const c = dstL + k
    if (haveTop) {
      tmp[c] = debAt(Y - 2, col)
      tmp[P + c] = debAt(Y - 2, col)
      tmp[2 * P + c] = debAt(Y - 1, col)
    }
    else {
      const v = curAt(Y, col)
      tmp[c] = v
      tmp[P + c] = v
      tmp[2 * P + c] = v
    }
  }
  if (!haveTop && hl) {
    for (let k = 0; k < 3; k++) {
      const v = leftAt(0, 1 + k)
      tmp[k] = v
      tmp[P + k] = v
      tmp[2 * P + k] = v
    }
  }

  const botBase = (3 + h) * P
  for (let k = 0; k < unitW; k++) {
    const col = pCol0 + k
    const c = dstL + k
    if (haveBottom) {
      tmp[botBase + c] = debAt(Y + h, col)
      tmp[botBase + P + c] = debAt(Y + h + 1, col)
      tmp[botBase + 2 * P + c] = debAt(Y + h + 1, col)
    }
    else {
      const v = curAt(Y + h - 1, col)
      tmp[botBase + c] = v
      tmp[botBase + P + c] = v
      tmp[botBase + 2 * P + c] = v
    }
  }
  if (!haveBottom && hl) {
    for (let k = 0; k < 3; k++) {
      const v = leftAt(h - 1, 1 + k)
      tmp[botBase + k] = v
      tmp[botBase + P + k] = v
      tmp[botBase + 2 * P + k] = v
    }
  }

  const wid = w + 3 * hr
  for (let j = 0; j < h; j++) {
    const rr = (3 + j) * P
    for (let m = 0; m < wid; m++)
      tmp[rr + 3 + m] = curAt(Y + j, m)
    if (hl) {
      for (let k = 0; k < 3; k++)
        tmp[rr + k] = leftAt(j, 1 + k)
    }
  }

  if (!hr) {
    const lastCol = dstL + unitW - 1
    for (let r = 0; r < h + 6; r++) {
      const v = tmp[r * P + lastCol]
      tmp[r * P + lastCol + 1] = v
      tmp[r * P + lastCol + 2] = v
      tmp[r * P + lastCol + 3] = v
    }
  }
  if (!hl) {
    for (let r = 0; r < h + 6; r++) {
      const v = tmp[r * P + 3]
      tmp[r * P] = v
      tmp[r * P + 1] = v
      tmp[r * P + 2] = v
    }
  }

  const hor = new Int32Array((h + 6) * P)
  for (let j = 0; j < h + 6; j++) {
    const rr = j * P
    for (let i = 0; i < w; i++) {
      let sum = (1 << 14) + tmp[rr + i + 3] * 128
      sum += tmp[rr + i] * fh[0] + tmp[rr + i + 1] * fh[1] + tmp[rr + i + 2] * fh[2]
        + tmp[rr + i + 3] * fh[3] + tmp[rr + i + 4] * fh[4] + tmp[rr + i + 5] * fh[5] + tmp[rr + i + 6] * fh[6]
      hor[rr + i] = iclip((sum + 4) >> 3, 0, 8191)
    }
  }
  for (let j = 0; j < h; j++) {
    const base = (Y + j) * stride + ux
    for (let i = 0; i < w; i++) {
      let sum = -(1 << 18)
      sum += hor[j * P + i] * fv[0] + hor[(j + 1) * P + i] * fv[1] + hor[(j + 2) * P + i] * fv[2]
        + hor[(j + 3) * P + i] * fv[3] + hor[(j + 4) * P + i] * fv[4] + hor[(j + 5) * P + i] * fv[5]
        + hor[(j + 6) * P + i] * fv[6]
      buf[base + i] = iclip((sum + 1024) >> 11, 0, 255)
    }
  }
}

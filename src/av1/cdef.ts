/**
 * AV1 CDEF (Constrained Directional Enhancement Filter), spec 7.15. Ports
 * dav1d's cdef_tmpl.c: the 8x8 direction search and the primary/secondary
 * constrained filter, plus a whole-frame driver. 8-bit only.
 */
import type { PixelPlane } from './pixels'
import { CDEF_DIRECTIONS } from './tables'

export const CDEF_HAVE_LEFT = 1
export const CDEF_HAVE_RIGHT = 2
export const CDEF_HAVE_TOP = 4
export const CDEF_HAVE_BOTTOM = 8

const TMP_STRIDE = 12
const SENTINEL = -32768

function ulog2(x: number): number {
  return 31 - Math.clz32(x)
}

function umin(a: number, b: number): number {
  return (a >>> 0) < (b >>> 0) ? a : b
}

function applySign(a: number, s: number): number {
  return s < 0 ? -a : a
}

function constrain(diff: number, threshold: number, shift: number): number {
  const adiff = Math.abs(diff)
  return applySign(Math.min(adiff, Math.max(0, threshold - (adiff >> shift))), diff)
}

const DIV_TABLE = [840, 420, 280, 210, 168, 140, 120]

/**
 * Direction search over an 8x8 block. Returns the best direction (0..7) and
 * writes the variance into `varOut[0]`.
 */
export function cdefFindDir(
  img: PixelPlane,
  off: number,
  stride: number,
  varOut: Int32Array,
  bitDepth = 8,
): number {
  const shift = bitDepth - 8
  const psHv = [new Int32Array(8), new Int32Array(8)]
  const psDiag = [new Int32Array(15), new Int32Array(15)]
  const psAlt = [new Int32Array(11), new Int32Array(11), new Int32Array(11), new Int32Array(11)]

  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const px = (img[off + y * stride + x] >> shift) - 128
      psDiag[0][y + x] += px
      psAlt[0][y + (x >> 1)] += px
      psHv[0][y] += px
      psAlt[1][3 + y - (x >> 1)] += px
      psDiag[1][7 + y - x] += px
      psAlt[2][3 - (y >> 1) + x] += px
      psHv[1][x] += px
      psAlt[3][(y >> 1) + x] += px
    }
  }

  const cost = new Float64Array(8)
  for (let n = 0; n < 8; n++) {
    cost[2] += psHv[0][n] * psHv[0][n]
    cost[6] += psHv[1][n] * psHv[1][n]
  }
  cost[2] *= 105
  cost[6] *= 105
  for (let n = 0; n < 7; n++) {
    const d = DIV_TABLE[n]
    cost[0] += (psDiag[0][n] * psDiag[0][n] + psDiag[0][14 - n] * psDiag[0][14 - n]) * d
    cost[4] += (psDiag[1][n] * psDiag[1][n] + psDiag[1][14 - n] * psDiag[1][14 - n]) * d
  }
  cost[0] += psDiag[0][7] * psDiag[0][7] * 105
  cost[4] += psDiag[1][7] * psDiag[1][7] * 105

  for (let n = 0; n < 4; n++) {
    const ci = n * 2 + 1
    for (let m = 0; m < 5; m++)
      cost[ci] += psAlt[n][3 + m] * psAlt[n][3 + m]
    cost[ci] *= 105
    for (let m = 0; m < 3; m++) {
      const d = DIV_TABLE[2 * m + 1]
      cost[ci] += (psAlt[n][m] * psAlt[n][m] + psAlt[n][10 - m] * psAlt[n][10 - m]) * d
    }
  }

  let bestDir = 0
  let bestCost = cost[0]
  for (let n = 1; n < 8; n++) {
    if (cost[n] > bestCost) {
      bestCost = cost[n]
      bestDir = n
    }
  }
  varOut[0] = Math.floor((bestCost - cost[bestDir ^ 4]) / 1024)
  return bestDir
}

function fillSentinel(tmp: Int32Array, off: number, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++)
      tmp[off + y * TMP_STRIDE + x] = SENTINEL
  }
}

/**
 * Pad the working buffer. `left` is a flat [h*2] array (2 samples per row);
 * `top`/`bottom` index into the source plane 2 rows above / h rows below.
 */
function padding(
  tmp: Int32Array,
  tmpBase: number,
  src: PixelPlane,
  srcOff: number,
  srcStride: number,
  left: Int32Array,
  top: PixelPlane,
  topOff: number,
  bottom: PixelPlane,
  botOff: number,
  w: number,
  h: number,
  edges: number,
): void {
  let xStart = -2
  let xEnd = w + 2
  let yStart = -2
  let yEnd = h + 2
  if (!(edges & CDEF_HAVE_TOP)) {
    fillSentinel(tmp, tmpBase - 2 - 2 * TMP_STRIDE, w + 4, 2)
    yStart = 0
  }
  if (!(edges & CDEF_HAVE_BOTTOM)) {
    fillSentinel(tmp, tmpBase + h * TMP_STRIDE - 2, w + 4, 2)
    yEnd -= 2
  }
  if (!(edges & CDEF_HAVE_LEFT)) {
    fillSentinel(tmp, tmpBase + yStart * TMP_STRIDE - 2, 2, yEnd - yStart)
    xStart = 0
  }
  if (!(edges & CDEF_HAVE_RIGHT)) {
    fillSentinel(tmp, tmpBase + yStart * TMP_STRIDE + w, 2, yEnd - yStart)
    xEnd -= 2
  }

  let tp = topOff
  for (let y = yStart; y < 0; y++) {
    for (let x = xStart; x < xEnd; x++)
      tmp[tmpBase + y * TMP_STRIDE + x] = top[tp + x]
    tp += srcStride
  }
  for (let y = 0; y < h; y++) {
    for (let x = xStart; x < 0; x++)
      tmp[tmpBase + y * TMP_STRIDE + x] = left[y * 2 + 2 + x]
  }
  let sp = srcOff
  let tb = tmpBase
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < xEnd; x++)
      tmp[tb + x] = src[sp + x]
    sp += srcStride
    tb += TMP_STRIDE
  }
  let bp = botOff
  for (let y = h; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++)
      tmp[tmpBase + y * TMP_STRIDE + x] = bottom[bp + x]
    bp += srcStride
  }
}

/**
 * CDEF filter one w×h block in place. `left` holds the 2 pre-filter samples to
 * the left of each row; `top`/`bottom` point at the pre-filter neighbor rows.
 */
export function cdefFilterBlock(
  dst: PixelPlane,
  dstOff: number,
  dstStride: number,
  left: Int32Array,
  top: PixelPlane,
  topOff: number,
  bottom: PixelPlane,
  botOff: number,
  priStrength: number,
  secStrength: number,
  dir: number,
  damping: number,
  w: number,
  h: number,
  edges: number,
  src: PixelPlane = dst,
  srcOff: number = dstOff,
  srcStride: number = dstStride,
  bitDepth = 8,
): void {
  const tmp = new Int32Array(TMP_STRIDE * (h + 4))
  const tmpBase = 2 * TMP_STRIDE + 2
  padding(tmp, tmpBase, src, srcOff, srcStride, left, top, topOff, bottom, botOff, w, h, edges)

  const dirBase = dir // CDEF_DIRECTIONS is prefixed by 2 rows, so table[dir+2] is dir

  if (priStrength) {
    const priTap = 4 - ((priStrength >> (bitDepth - 8)) & 1)
    const priShift = Math.max(0, damping - ulog2(priStrength))
    if (secStrength) {
      const secShift = damping - ulog2(secStrength)
      let dp = dstOff
      let tb = tmpBase
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const px = tmp[tb + x]
          let sum = 0
          let max = px
          let min = px
          let priTapK = priTap
          for (let k = 0; k < 2; k++) {
            const off1 = CDEF_DIRECTIONS[(dirBase + 2) * 2 + k]
            const p0 = tmp[tb + x + off1]
            const p1 = tmp[tb + x - off1]
            sum += priTapK * constrain(p0 - px, priStrength, priShift)
            sum += priTapK * constrain(p1 - px, priStrength, priShift)
            priTapK = (priTapK & 3) | 2
            min = umin(p0, min)
            max = p0 > max ? p0 : max
            min = umin(p1, min)
            max = p1 > max ? p1 : max
            const off2 = CDEF_DIRECTIONS[(dirBase + 4) * 2 + k]
            const off3 = CDEF_DIRECTIONS[(dirBase + 0) * 2 + k]
            const s0 = tmp[tb + x + off2]
            const s1 = tmp[tb + x - off2]
            const s2 = tmp[tb + x + off3]
            const s3 = tmp[tb + x - off3]
            const secTap = 2 - k
            sum += secTap * constrain(s0 - px, secStrength, secShift)
            sum += secTap * constrain(s1 - px, secStrength, secShift)
            sum += secTap * constrain(s2 - px, secStrength, secShift)
            sum += secTap * constrain(s3 - px, secStrength, secShift)
            min = umin(s0, min)
            max = s0 > max ? s0 : max
            min = umin(s1, min)
            max = s1 > max ? s1 : max
            min = umin(s2, min)
            max = s2 > max ? s2 : max
            min = umin(s3, min)
            max = s3 > max ? s3 : max
          }
          let v = px + ((sum - (sum < 0 ? 1 : 0) + 8) >> 4)
          v = v < min ? min : v > max ? max : v
          dst[dp + x] = v
        }
        dp += dstStride
        tb += TMP_STRIDE
      }
    }
    else {
      let dp = dstOff
      let tb = tmpBase
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const px = tmp[tb + x]
          let sum = 0
          let priTapK = priTap
          for (let k = 0; k < 2; k++) {
            const off = CDEF_DIRECTIONS[(dirBase + 2) * 2 + k]
            const p0 = tmp[tb + x + off]
            const p1 = tmp[tb + x - off]
            sum += priTapK * constrain(p0 - px, priStrength, priShift)
            sum += priTapK * constrain(p1 - px, priStrength, priShift)
            priTapK = (priTapK & 3) | 2
          }
          dst[dp + x] = px + ((sum - (sum < 0 ? 1 : 0) + 8) >> 4)
        }
        dp += dstStride
        tb += TMP_STRIDE
      }
    }
  }
  else {
    const secShift = damping - ulog2(secStrength)
    let dp = dstOff
    let tb = tmpBase
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = tmp[tb + x]
        let sum = 0
        for (let k = 0; k < 2; k++) {
          const off1 = CDEF_DIRECTIONS[(dirBase + 4) * 2 + k]
          const off2 = CDEF_DIRECTIONS[(dirBase + 0) * 2 + k]
          const s0 = tmp[tb + x + off1]
          const s1 = tmp[tb + x - off1]
          const s2 = tmp[tb + x + off2]
          const s3 = tmp[tb + x - off2]
          const secTap = 2 - k
          sum += secTap * constrain(s0 - px, secStrength, secShift)
          sum += secTap * constrain(s1 - px, secStrength, secShift)
          sum += secTap * constrain(s2 - px, secStrength, secShift)
          sum += secTap * constrain(s3 - px, secStrength, secShift)
        }
        dst[dp + x] = px + ((sum - (sum < 0 ? 1 : 0) + 8) >> 4)
      }
      dp += dstStride
      tb += TMP_STRIDE
    }
  }
}

/**
 * Per-frame CDEF metadata recorded during decode: the cdef index per 64x64
 * superblock, and per-4x4 non-skip flags (CDEF only filters 8x8 blocks that
 * carry coded coefficients).
 */
export class CdefData {
  idx: Int8Array
  noskip: Uint8Array
  readonly sb64w: number

  constructor(readonly miCols: number, readonly miRows: number) {
    this.sb64w = (miCols + 15) >> 4
    const sb64h = (miRows + 15) >> 4
    this.idx = new Int8Array(this.sb64w * sb64h).fill(-1)
    this.noskip = new Uint8Array(miCols * miRows)
  }
}

function adjustStrength(strength: number, variance: number): number {
  if (!variance)
    return 0
  const i = variance >> 6 ? Math.min(ulog2(variance >> 6), 12) : 0
  return (strength * (4 + i) + 8) >> 4
}

// chroma direction remap: identity for 4:2:0 / 4:4:4; special-cased for 4:2:2
const UV_DIRS = [
  [0, 1, 2, 3, 4, 5, 6, 7],
  [7, 0, 2, 4, 5, 6, 6, 6],
]

interface CdefPlanes {
  y: PixelPlane
  u: PixelPlane
  v: PixelPlane
  yStride: number
  uvStride: number
}

/**
 * Apply CDEF across the whole frame. Reads pre-CDEF neighbor samples from a
 * copy of each plane and writes filtered pixels back. 64x64-superblock,
 * single-tile, non-superres path.
 */
export function applyCdef(
  buf: CdefPlanes,
  data: CdefData,
  opts: {
    enableCdef: boolean
    damping: number
    bits: number
    yPri: number[]
    ySec: number[]
    uvPri: number[]
    uvSec: number[]
    monochrome: boolean
    ssHor: number
    ssVer: number
    layout: number
    bitDepth?: number
  },
): void {
  if (!opts.enableCdef)
    return
  const miCols = data.miCols
  const miRows = data.miRows
  const bitDepth = opts.bitDepth ?? 8
  const depthShift = bitDepth - 8
  const damping = opts.damping + depthShift
  const ssHor = opts.ssHor
  const ssVer = opts.ssVer
  const uvDir = UV_DIRS[opts.layout === 2 ? 1 : 0]
  const varOut = new Int32Array(1)

  const preY = buf.y.slice()
  const preU = opts.monochrome ? buf.u : buf.u.slice()
  const preV = opts.monochrome ? buf.v : buf.v.slice()

  for (let by = 0; by < miRows; by += 2) {
    for (let bx = 0; bx < miCols; bx += 2) {
      const sb64 = (by >> 4) * data.sb64w + (bx >> 4)
      const cdefIdx = data.idx[sb64]
      if (cdefIdx === -1)
        continue
      const yPri = opts.yPri[cdefIdx] << depthShift
      const ySec = opts.ySec[cdefIdx] << depthShift
      const uvPri = opts.uvPri[cdefIdx] << depthShift
      const uvSec = opts.uvSec[cdefIdx] << depthShift
      if (!yPri && !ySec && !uvPri && !uvSec)
        continue

      // non-skip check over the 8x8's up-to-4 luma cells
      let noskip = false
      for (let dy = 0; dy < 2 && by + dy < miRows; dy++) {
        for (let dx = 0; dx < 2 && bx + dx < miCols; dx++) {
          if (data.noskip[(by + dy) * miCols + bx + dx])
            noskip = true
        }
      }
      if (!noskip)
        continue

      let edges = 0
      if (bx > 0)
        edges |= CDEF_HAVE_LEFT
      if (bx + 2 < miCols)
        edges |= CDEF_HAVE_RIGHT
      if (by > 0)
        edges |= CDEF_HAVE_TOP
      if (by + 2 < miRows)
        edges |= CDEF_HAVE_BOTTOM

      let dir = 0
      if (yPri || uvPri)
        dir = cdefFindDir(preY, by * 4 * buf.yStride + bx * 4, buf.yStride, varOut, bitDepth)

      // luma
      if (yPri || ySec) {
        const stride = buf.yStride
        const dstOff = by * 4 * stride + bx * 4
        const left = new Int32Array(8 * 2)
        if (bx > 0) {
          for (let y = 0; y < 8; y++) {
            left[y * 2] = preY[(by * 4 + y) * stride + bx * 4 - 2]
            left[y * 2 + 1] = preY[(by * 4 + y) * stride + bx * 4 - 1]
          }
        }
        const topOff = (by * 4 - 2) * stride + bx * 4
        const botOff = (by * 4 + 8) * stride + bx * 4
        const adj = yPri ? adjustStrength(yPri, varOut[0]) : 0
        if (yPri ? (adj || ySec) : ySec) {
          cdefFilterBlock(
            buf.y, dstOff, stride, left, preY, topOff, preY, botOff,
            adj, ySec, dir, damping, 8, 8, edges, preY, dstOff, stride, bitDepth,
          )
        }
      }

      // chroma
      if (!opts.monochrome && (uvPri || uvSec)) {
        const uvdir = uvPri ? uvDir[dir] : 0
        const cw = 8 >> ssHor
        const ch = 8 >> ssVer
        const cbx = (bx * 4) >> ssHor
        const cby = (by * 4) >> ssVer
        const stride = buf.uvStride
        for (let pl = 1; pl <= 2; pl++) {
          const plane = pl === 1 ? buf.u : buf.v
          const pre = pl === 1 ? preU : preV
          const dstOff = cby * stride + cbx
          const left = new Int32Array(ch * 2)
          if (bx > 0) {
            for (let y = 0; y < ch; y++) {
              left[y * 2] = pre[(cby + y) * stride + cbx - 2]
              left[y * 2 + 1] = pre[(cby + y) * stride + cbx - 1]
            }
          }
          const topOff = (cby - 2) * stride + cbx
          const botOff = (cby + ch) * stride + cbx
          cdefFilterBlock(
            plane, dstOff, stride, left, pre, topOff, pre, botOff,
            uvPri, uvSec, uvdir, damping - 1, cw, ch, edges, pre, dstOff, stride, bitDepth,
          )
        }
      }
    }
  }
}

/**
 * Forward 4x4 DCT_DCT for the intra encoder.
 *
 * Rather than re-deriving libaom's integer forward transform (and risking a
 * mismatch with this repo's inverse), we treat the decoder's `itxfmAdd` as the
 * ground-truth linear operator and numerically invert it. We probe `itxfmAdd`
 * with unit coefficients to build the 16x16 inverse-transform matrix `INV`
 * (pixel-residual response per dequantized coefficient), then `FWD = INV^-1`.
 *
 * Because reconstruction in the encoder always runs the *real* `itxfmAdd`, this
 * matrix only steers coefficient selection (rate/distortion); it never affects
 * bit-exactness between encoder and decoder. Probing at a large amplitude keeps
 * the (integer-rounded) operator effectively linear, so `FWD` is accurate.
 */
import { itxfmAdd } from './itx'

const N = 16
const W = 4
const TX_4X4 = 0
const DCT_DCT = 0
const PROBE_AMP = 256

let fwd: Float64Array[] | null = null

function buildInv(): number[][] {
  const inv: number[][] = Array.from({ length: N }, () => Array.from({ length: N }, () => 0))
  const cf = new Int32Array(N)
  const dst = new Uint8Array(N)
  for (let j = 0; j < N; j++) {
    // Symmetric probe (+/-amp) cancels the operator's rounding bias.
    cf.fill(0)
    cf[j] = PROBE_AMP
    dst.fill(128)
    itxfmAdd(dst, 0, W, cf, TX_4X4, DCT_DCT, 15)
    const plus = Array.from(dst, v => v - 128)
    cf.fill(0)
    cf[j] = -PROBE_AMP
    dst.fill(128)
    itxfmAdd(dst, 0, W, cf, TX_4X4, DCT_DCT, 15)
    for (let p = 0; p < N; p++)
      inv[p][j] = (plus[p] - (dst[p] - 128)) / (2 * PROBE_AMP)
  }
  return inv
}

/** Gauss-Jordan inversion of a small dense matrix. */
function invertMatrix(m: number[][]): Float64Array[] {
  const n = m.length
  const a = m.map((row, i) => {
    const r = new Float64Array(2 * n)
    for (let j = 0; j < n; j++)
      r[j] = row[j]
    r[n + i] = 1
    return r
  })
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(a[r][c]) > Math.abs(a[piv][c]))
        piv = r
    }
    const tmp = a[c]
    a[c] = a[piv]
    a[piv] = tmp
    const d = a[c][c]
    for (let k = 0; k < 2 * n; k++)
      a[c][k] /= d
    for (let r = 0; r < n; r++) {
      if (r === c)
        continue
      const f = a[r][c]
      if (f === 0)
        continue
      for (let k = 0; k < 2 * n; k++)
        a[r][k] -= f * a[c][k]
    }
  }
  return a.map((row) => {
    const out = new Float64Array(n)
    for (let j = 0; j < n; j++)
      out[j] = row[n + j]
    return out
  })
}

/** Lazily-built forward transform matrix (rows = coefficients, cols = pixels). */
export function forwardMatrix(): Float64Array[] {
  if (!fwd)
    fwd = invertMatrix(buildInv())
  return fwd
}

/**
 * Forward-transform a 16-pixel residual block (row-major) into raster-order
 * transform coefficients. Coefficient index `rc` matches the decoder's cf[]
 * indexing used by the scan tables and `itxfmAdd`.
 */
export function forward4x4(residual: Int32Array | number[], out: Float64Array): void {
  const f = forwardMatrix()
  for (let j = 0; j < N; j++) {
    const row = f[j]
    let s = 0
    for (let p = 0; p < N; p++)
      s += row[p] * residual[p]
    out[j] = s
  }
}

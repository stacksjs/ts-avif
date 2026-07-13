import { CdfContext } from './cdf'
import { BlockLevel, BlockPartition, IntraPredMode } from './consts'
import { forward4x4 } from './fwd-txfm'
import { itxfmAdd } from './itx'
import { SymbolEncoder } from './msac'
import {
  AL_PART_CTX,
  DQ_TBL_8BPC,
  INTRA_MODE_CONTEXT,
  LO_CTX_OFFSETS,
  PARTITION_TYPE_COUNT,
  SCANS,
} from './tables'

// 4x4 DCT_DCT is the only transform the intra encoder emits. These mirror the
// decoder's per-tx constants (see decodeCoefs / itxfmAdd) for tx = TX_4X4.
const TX_4X4 = 0
const TXTP_DCT_DCT = 0
const SCAN_4X4 = SCANS[TX_4X4]
const LEVEL_STRIDE = 4 // 2D level-buffer stride for 4x4 (= 4 << slh, slh = 0)
const RC_SHIFT = 2 // slh + 2
const RC_MASK = 3 // (4 << slh) - 1
const CF_MAX = 32767 // 8bpc coefficient clamp (dav1d cf_max)

interface Yuv420 {
  y: Uint8Array
  u: Uint8Array
  v: Uint8Array
  yStride: number
  uvStride: number
  miCols: number
  miRows: number
}

class EncoderContext {
  mode: Uint8Array
  skip: Uint8Array
  partition: Uint8Array
  lcoef: Uint8Array
  ccoef: [Uint8Array, Uint8Array]

  constructor(n4: number) {
    this.mode = new Uint8Array(n4)
    this.skip = new Uint8Array(n4)
    this.partition = new Uint8Array(n4 >> 1)
    this.lcoef = new Uint8Array(n4)
    this.ccoef = [new Uint8Array(n4), new Uint8Array(n4)]
    this.reset()
  }

  reset(): void {
    this.mode.fill(IntraPredMode.DC_PRED)
    this.skip.fill(0)
    this.partition.fill(0)
    this.lcoef.fill(0x40)
    this.ccoef[0].fill(0x40)
    this.ccoef[1].fill(0x40)
  }
}

/** Convert opaque RGBA pixels to the encoder's full-range BT.709 4:2:0 planes. */
export function rgbaToYuv420(data: Uint8Array, width: number, height: number): Yuv420 {
  if (data.byteLength !== width * height * 4)
    throw new Error('ts-avif: imageData.data must be RGBA (width × height × 4 bytes)')

  const miCols = 2 * ((width + 7) >> 3)
  const miRows = 2 * ((height + 7) >> 3)
  const yStride = miCols * 4
  const yHeight = miRows * 4
  const uvStride = yStride >> 1
  const uvHeight = yHeight >> 1
  const y = new Uint8Array(yStride * yHeight)
  const uFull = new Float64Array(yStride * yHeight)
  const vFull = new Float64Array(yStride * yHeight)

  for (let py = 0; py < yHeight; py++) {
    const sy = Math.min(py, height - 1)
    for (let px = 0; px < yStride; px++) {
      const sx = Math.min(px, width - 1)
      const src = (sy * width + sx) * 4
      if (data[src + 3] !== 255)
        throw new Error('ts-avif: alpha encoding is not implemented; input pixels must be opaque')
      const r = data[src]
      const g = data[src + 1]
      const b = data[src + 2]
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
      const off = py * yStride + px
      y[off] = clipByte(Math.round(luma))
      uFull[off] = 128 + (b - luma) / 1.8556
      vFull[off] = 128 + (r - luma) / 1.5748
    }
  }

  const u = new Uint8Array(uvStride * uvHeight)
  const v = new Uint8Array(uvStride * uvHeight)
  for (let py = 0; py < uvHeight; py++) {
    for (let px = 0; px < uvStride; px++) {
      const src = (py * 2) * yStride + px * 2
      const offsets = [src, src + 1, src + yStride, src + yStride + 1]
      let su = 0
      let sv = 0
      for (const off of offsets) {
        su += uFull[off]
        sv += vFull[off]
      }
      u[py * uvStride + px] = clipByte(Math.round(su / 4))
      v[py * uvStride + px] = clipByte(Math.round(sv / 4))
    }
  }

  return { y, u, v, yStride, uvStride, miCols, miRows }
}

/** Encode one adaptive-CDF tile using 4x4 DC-predicted DCT blocks. */
export function encodeIntraTile(source: Yuv420, baseQIdx: number): Uint8Array {
  if (baseQIdx < 1 || baseQIdx > 255)
    throw new RangeError('ts-avif: the DC intra encoder requires a quantizer in 1..255')
  return new IntraTileEncoder(source, baseQIdx).encode()
}

class IntraTileEncoder {
  private msac = new SymbolEncoder(false)
  private cdf: CdfContext
  private a: EncoderContext
  private l = new EncoderContext(32)
  private bx = 0
  private by = 0
  private recon: [Uint8Array, Uint8Array, Uint8Array]
  private dqDc: number
  private dqAc: number
  // Per-block coefficient scratch (raster order), reused across blocks.
  private residual = new Int32Array(16)
  private coef = new Float64Array(16)
  private absLevel = new Int32Array(16)
  private signBit = new Uint8Array(16)
  private cf = new Int32Array(16)
  private levels = new Uint8Array(LEVEL_STRIDE * (4 + 2))

  constructor(private source: Yuv420, private baseQIdx: number) {
    this.cdf = new CdfContext(baseQIdx)
    this.a = new EncoderContext((source.miCols + 31) & ~31)
    this.recon = [
      new Uint8Array(source.y.length),
      new Uint8Array(source.u.length),
      new Uint8Array(source.v.length),
    ]
    // Frame-level quantizers (no segmentation / delta-q): matches computeDq().
    this.dqDc = DQ_TBL_8BPC[baseQIdx * 2]
    this.dqAc = DQ_TBL_8BPC[baseQIdx * 2 + 1]
  }

  encode(): Uint8Array {
    for (this.by = 0; this.by < this.source.miRows; this.by += 16) {
      this.l.reset()
      for (this.bx = 0; this.bx < this.source.miCols; this.bx += 16)
        this.encodeSb(BlockLevel.BL_64X64)
    }
    return this.msac.finish()
  }

  private encodeSb(bl: BlockLevel): void {
    const hsz = 16 >> bl
    const haveHSplit = this.source.miCols > this.bx + hsz
    const haveVSplit = this.source.miRows > this.by + hsz

    if (!haveHSplit && !haveVSplit) {
      this.encodeSb(bl + 1)
      return
    }

    const by8 = (this.by & 31) >> 1
    const ctx = ((this.a.partition[this.bx >> 1] >> (4 - bl)) & 1)
      + (((this.l.partition[by8] >> (4 - bl)) & 1) << 1)
    const pcOff = this.cdf.offset('partition', bl, ctx)

    if (haveHSplit && haveVSplit) {
      this.msac.encodeSymbol(this.cdf.data, pcOff, PARTITION_TYPE_COUNT[bl], BlockPartition.SPLIT)
      if (bl === BlockLevel.BL_8X8) {
        this.encodeBlock()
        this.bx++
        this.encodeBlock()
        this.bx--
        this.by++
        this.encodeBlock()
        this.bx++
        this.encodeBlock()
        this.bx--
        this.by--
      }
      else {
        this.encodeSb(bl + 1)
        this.bx += hsz
        this.encodeSb(bl + 1)
        this.bx -= hsz
        this.by += hsz
        this.encodeSb(bl + 1)
        this.bx += hsz
        this.encodeSb(bl + 1)
        this.bx -= hsz
        this.by -= hsz
      }
    }
    else if (haveHSplit) {
      this.msac.encodeBool(1, gatherTopPartitionProb(this.cdf.data, pcOff, bl))
      this.encodeSb(bl + 1)
      this.bx += hsz
      this.encodeSb(bl + 1)
      this.bx -= hsz
    }
    else {
      this.msac.encodeBool(1, gatherLeftPartitionProb(this.cdf.data, pcOff, bl))
      this.encodeSb(bl + 1)
      this.by += hsz
      this.encodeSb(bl + 1)
      this.by -= hsz
    }

    if (bl === BlockLevel.BL_8X8) {
      const aVal = AL_PART_CTX[(0 * 5 + bl) * 10 + BlockPartition.SPLIT]
      const lVal = AL_PART_CTX[(1 * 5 + bl) * 10 + BlockPartition.SPLIT]
      this.a.partition[this.bx >> 1] = aVal
      this.l.partition[by8] = lVal
    }
  }

  private encodeBlock(): void {
    const bx4 = this.bx
    const by4 = this.by & 31

    const skipCtx = this.a.skip[bx4] + this.l.skip[by4]
    this.msac.encodeBoolAdapt(this.cdf.data, this.cdf.offset('skip', skipCtx), 0)

    const ctxA = INTRA_MODE_CONTEXT[this.a.mode[bx4]]
    const ctxL = INTRA_MODE_CONTEXT[this.l.mode[by4]]
    this.msac.encodeSymbol(this.cdf.data, this.cdf.offset('kfym', ctxA, ctxL), 12, IntraPredMode.DC_PRED)

    const hasChroma = (this.bx & 1) === 1 && (this.by & 1) === 1
    if (hasChroma) {
      // CFL is allowed for 4x4 blocks, making this a 14-symbol alphabet.
      this.msac.encodeSymbol(this.cdf.data, this.cdf.offset('uv_mode', 1, IntraPredMode.DC_PRED), 13, IntraPredMode.DC_PRED)
    }

    this.encodeCoefficients(0, this.a.lcoef, bx4, this.l.lcoef, by4)
    if (hasChroma) {
      const cbx4 = bx4 >> 1
      const cby4 = by4 >> 1
      this.encodeCoefficients(1, this.a.ccoef[0], cbx4, this.l.ccoef[0], cby4)
      this.encodeCoefficients(2, this.a.ccoef[1], cbx4, this.l.ccoef[1], cby4)
    }

    this.a.mode[bx4] = IntraPredMode.DC_PRED
    this.l.mode[by4] = IntraPredMode.DC_PRED
    this.a.skip[bx4] = 0
    this.l.skip[by4] = 0
  }

  /**
   * Forward-transform, quantize and entropy-code one 4x4 DCT_DCT tx block, then
   * reconstruct it via the real inverse transform so the encoder's neighbor
   * predictions stay bit-identical to the decoder's. The entropy layer is the
   * exact inverse of TileDecoder.decodeCoefs for the TWO_D 4x4 path.
   */
  private encodeCoefficients(
    plane: number,
    aArr: Uint8Array,
    aOff: number,
    lArr: Uint8Array,
    lOff: number,
  ): void {
    const chroma = plane ? 1 : 0
    let skipCtx = 0
    if (chroma) {
      const ca = aArr[aOff] === 0x40 ? 0 : 1
      const cl = lArr[lOff] === 0x40 ? 0 : 1
      skipCtx = 7 + ca + cl
    }

    const target = plane === 0 ? this.source.y : plane === 1 ? this.source.u : this.source.v
    const reconstructed = this.recon[plane]
    const stride = plane === 0 ? this.source.yStride : this.source.uvStride
    const px = plane === 0 ? this.bx * 4 : (this.bx >> 1) * 4
    const py = plane === 0 ? this.by * 4 : (this.by >> 1) * 4
    const pred = dcPredict(reconstructed, stride, px, py)

    // residual = source - DC prediction (row-major), then forward transform.
    const residual = this.residual
    for (let r = 0; r < 4; r++) {
      const row = (py + r) * stride + px
      for (let c = 0; c < 4; c++)
        residual[r * 4 + c] = target[row + c] - pred
    }
    forward4x4(residual, this.coef)

    // Quantize each coefficient to an integer token; keep magnitude and sign.
    const absLevel = this.absLevel
    const signBit = this.signBit
    let eob = -1
    for (let rc = 0; rc < 16; rc++) {
      const q = rc === 0 ? this.dqDc : this.dqAc
      const t = Math.round(this.coef[rc] / q)
      const a = t < 0 ? -t : t
      absLevel[rc] = a
      signBit[rc] = t < 0 ? 1 : 0
    }
    // eob = highest scan position with a non-zero level.
    for (let i = 15; i >= 0; i--) {
      if (absLevel[SCAN_4X4[i]] !== 0) {
        eob = i
        break
      }
    }

    const coefSkipOff = this.cdf.offset('coef_skip', 0, skipCtx)
    if (eob < 0) {
      // Whole block quantizes to zero: signal coef_skip and keep the prediction.
      this.msac.encodeBoolAdapt(this.cdf.data, coefSkipOff, 1)
      aArr[aOff] = 0x40
      lArr[lOff] = 0x40
      fillBlock(reconstructed, stride, px, py, pred)
      return
    }
    this.msac.encodeBoolAdapt(this.cdf.data, coefSkipOff, 0)

    if (!chroma) {
      // Reduced intra transform set: symbol index 1 maps to DCT_DCT.
      this.msac.encodeSymbol(this.cdf.data, this.cdf.offset('txtp_intra2', 0, IntraPredMode.DC_PRED), 4, 1)
    }

    this.encodeEob(chroma, eob)
    this.encodeLevels(chroma, eob)
    const culLevel = this.encodeSignsAndDequant(chroma, eob, aArr, aOff, lArr, lOff)

    // Reconstruct exactly as the decoder does: prediction + inverse transform.
    fillBlock(reconstructed, stride, px, py, pred)
    const dstOff = py * stride + px
    itxfmAdd(reconstructed, dstOff, stride, this.cf, TX_4X4, TXTP_DCT_DCT, eob)

    const dcSignLevel = absLevel[0] === 0 ? (1 << 6) : (signBit[0] ? 0 : (2 << 6))
    const ctx = Math.min(culLevel, 63) | dcSignLevel
    aArr[aOff] = ctx
    lArr[lOff] = ctx
  }

  /** Emit the end-of-block position (inverse of the decoder's eob decode). */
  private encodeEob(chroma: number, eob: number): void {
    const eobPt = eob === 0 ? 0 : eob === 1 ? 1 : eob <= 3 ? 2 : eob <= 7 ? 3 : 4
    // is1d = 0 (DCT_DCT is TWO_D); tDim.ctx = 0 for 4x4.
    this.msac.encodeSymbol(this.cdf.data, this.cdf.offset('eob_bin_16', chroma, 0), 4, eobPt)
    if (eobPt > 1) {
      const eobBin = eobPt - 2
      const hiBit = (eob >> eobBin) & 1
      this.msac.encodeBoolAdapt(this.cdf.data, this.cdf.offset('eob_hi_bit', 0, chroma, eobBin), hiBit)
      if (eobBin > 0)
        this.msac.writeLiteral(eob & ((1 << eobBin) - 1), eobBin)
    }
  }

  /**
   * Emit the coefficient base/range tokens in the decoder's read order
   * (eob position, then descending scan to 1, then DC), maintaining the level
   * neighborhood buffer so contexts match TileDecoder.decodeCoefs exactly.
   */
  private encodeLevels(chroma: number, eob: number): void {
    const { absLevel } = this
    const eobBase = this.cdf.offset('eob_base_tok', 0, chroma)
    const hiBase = this.cdf.offset('br_tok', 0, chroma)
    const loBase = this.cdf.offset('base_tok', 0, chroma)
    const levels = this.levels
    levels.fill(0, 0, LEVEL_STRIDE * (4 + 2))

    if (eob === 0) {
      // dc-only block: eob_base_tok at context 0.
      const lv = absLevel[0]
      const tokBr = Math.min(lv, 3) - 1
      this.msac.encodeSymbol(this.cdf.data, eobBase, 2, tokBr)
      if (tokBr === 2)
        this.encodeHiTok(hiBase, lv)
      return
    }

    // eob-position coefficient.
    const rcEob = SCAN_4X4[eob]
    const xE = rcEob >> RC_SHIFT
    const yE = rcEob & RC_MASK
    const eobCtx = 1 + (eob > 2 ? 1 : 0) + (eob > 4 ? 1 : 0)
    const lvEob = absLevel[rcEob]
    const eobTok = Math.min(lvEob, 3) - 1
    this.msac.encodeSymbol(this.cdf.data, eobBase + eobCtx * 4, 2, eobTok)
    if (eobTok === 2) {
      const hctx = (xE | yE) > 1 ? 14 : 7
      this.encodeHiTok(hiBase + hctx * 4, lvEob)
      levels[rcEob] = (Math.min(lvEob, 15) + (3 << 6)) & 0xFF
    }
    else {
      levels[rcEob] = (lvEob * 0x41) & 0xFF
    }

    // remaining AC coefficients, descending scan order.
    for (let i = eob - 1; i > 0; i--) {
      const rc = SCAN_4X4[i]
      const x = rc >> RC_SHIFT
      const y = rc & RC_MASK
      let mag = levels[rc + 1] + levels[rc + LEVEL_STRIDE] + levels[rc + LEVEL_STRIDE + 1]
      const hiMag = mag
      mag += levels[rc + 2] + levels[rc + 2 * LEVEL_STRIDE]
      const loCtx = LO_CTX_OFFSETS[Math.min(y, 4) * 5 + Math.min(x, 4)]
        + (mag > 512 ? 4 : (mag + 64) >> 7)
      const lv = absLevel[rc]
      const base = Math.min(lv, 3)
      this.msac.encodeSymbol(this.cdf.data, loBase + loCtx * 4, 3, base)
      if (base === 3) {
        const m = hiMag & 63
        const hctx = ((x | y) > 1 ? 14 : 7) + (m > 12 ? 6 : (m + 1) >> 1)
        this.encodeHiTok(hiBase + hctx * 4, lv)
        levels[rc] = (Math.min(lv, 15) + (3 << 6)) & 0xFF
      }
      else {
        levels[rc] = (base * 0x41) & 0xFF
      }
    }

    // DC coefficient (context 0 for TWO_D).
    const lvDc = absLevel[0]
    const baseDc = Math.min(lvDc, 3)
    this.msac.encodeSymbol(this.cdf.data, loBase, 3, baseDc)
    if (baseDc === 3) {
      const m = (levels[1] + levels[LEVEL_STRIDE] + levels[LEVEL_STRIDE + 1]) & 63
      const hctx = m > 12 ? 6 : (m + 1) >> 1
      this.encodeHiTok(hiBase + hctx * 4, lvDc)
    }
  }

  /**
   * Emit DC/AC signs and Golomb tails, and build the dequantized coefficient
   * array `this.cf` used for reconstruction. Returns the cumulative level.
   */
  private encodeSignsAndDequant(
    chroma: number,
    eob: number,
    aArr: Uint8Array,
    aOff: number,
    lArr: Uint8Array,
    lOff: number,
  ): number {
    const { absLevel, signBit, cf } = this
    cf.fill(0)
    let culLevel = 0

    // DC (position 0).
    const dcLv = absLevel[0]
    if (dcLv !== 0) {
      const dcSignCtx = this.dcSignCtx(aArr, aOff, lArr, lOff)
      const neg = signBit[0]
      this.msac.encodeBoolAdapt(this.cdf.data, this.cdf.offset('dc_sign', chroma, dcSignCtx), neg)
      let dq: number
      if (dcLv >= 15) {
        this.msac.writeGolomb(dcLv - 15)
        dq = Math.min((this.dqDc * dcLv) & 0xFFFFFF, CF_MAX + neg)
      }
      else {
        dq = this.dqDc * dcLv
      }
      cf[0] = neg ? -dq : dq
      culLevel += dcLv
    }

    // AC coefficients in ascending scan order (the decoder's chain order).
    for (let i = 1; i <= eob; i++) {
      const rc = SCAN_4X4[i]
      const lv = absLevel[rc]
      if (lv === 0)
        continue
      const neg = signBit[rc]
      this.msac.encodeBoolEqui(neg)
      let dq: number
      if (lv >= 15) {
        this.msac.writeGolomb(lv - 15)
        dq = Math.min((this.dqAc * lv) & 0xFFFFFF, CF_MAX + neg)
      }
      else {
        dq = this.dqAc * lv
      }
      cf[rc] = neg ? -dq : dq
      culLevel += lv
    }

    return culLevel
  }

  /** dc_sign context from the neighbor coefficient-sign state (4x4: w=h=1). */
  private dcSignCtx(aArr: Uint8Array, aOff: number, lArr: Uint8Array, lOff: number): number {
    let s = -2 + (aArr[aOff] >> 6) + (lArr[lOff] >> 6)
    s = (s !== 0 ? 1 : 0) + (s > 0 ? 1 : 0)
    return s
  }

  /** Encode a base-range (br_tok) level in [3, 15], capping at 15 like the decoder. */
  private encodeHiTok(cdfOff: number, level: number): void {
    const lv = Math.min(level, 15)
    for (const base of [3, 6, 9, 12]) {
      const symbol = Math.min(lv - base, 3)
      this.msac.encodeSymbol(this.cdf.data, cdfOff, 3, symbol)
      if (symbol < 3)
        return
    }
  }
}

function dcPredict(plane: Uint8Array, stride: number, px: number, py: number): number {
  if (px === 0 && py === 0)
    return 128
  let sum = 0
  let count = 0
  if (py > 0) {
    for (let x = 0; x < 4; x++)
      sum += plane[(py - 1) * stride + px + x]
    count += 4
  }
  if (px > 0) {
    for (let y = 0; y < 4; y++)
      sum += plane[(py + y) * stride + px - 1]
    count += 4
  }
  return Math.floor((sum + (count >> 1)) / count)
}

function blockAverage(plane: Uint8Array, stride: number, px: number, py: number): number {
  let sum = 0
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++)
      sum += plane[(py + y) * stride + px + x]
  return Math.round(sum / 16)
}

function fillBlock(plane: Uint8Array, stride: number, px: number, py: number, value: number): void {
  for (let y = 0; y < 4; y++)
    plane.fill(value, (py + y) * stride + px, (py + y) * stride + px + 4)
}

function gatherTopPartitionProb(data: Uint16Array, off: number, bl: BlockLevel): number {
  let out = data[off + BlockPartition.V - 1] - data[off + BlockPartition.T_TOP_SPLIT]
  out += data[off + BlockPartition.T_LEFT_SPLIT - 1]
  if (bl !== BlockLevel.BL_128X128)
    out += data[off + BlockPartition.V4 - 1] - data[off + BlockPartition.T_RIGHT_SPLIT]
  return out
}

function gatherLeftPartitionProb(data: Uint16Array, off: number, bl: BlockLevel): number {
  let out = data[off + BlockPartition.H - 1] - data[off + BlockPartition.H]
  out += data[off + BlockPartition.SPLIT - 1] - data[off + BlockPartition.T_LEFT_SPLIT]
  if (bl !== BlockLevel.BL_128X128)
    out += data[off + BlockPartition.H4 - 1] - data[off + BlockPartition.H4]
  return out
}

function clipByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value
}

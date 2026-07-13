import { CdfContext } from './cdf'
import { BlockLevel, BlockPartition, IntraPredMode } from './consts'
import { SymbolEncoder } from './msac'
import {
  AL_PART_CTX,
  DQ_TBL_8BPC,
  INTRA_MODE_CONTEXT,
  PARTITION_TYPE_COUNT,
} from './tables'

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
  private dq: number

  constructor(private source: Yuv420, private baseQIdx: number) {
    this.cdf = new CdfContext(baseQIdx)
    this.a = new EncoderContext((source.miCols + 31) & ~31)
    this.recon = [
      new Uint8Array(source.y.length),
      new Uint8Array(source.u.length),
      new Uint8Array(source.v.length),
    ]
    this.dq = DQ_TBL_8BPC[baseQIdx * 2]
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
    const wanted = blockAverage(target, stride, px, py)
    const { token, residual } = chooseDcToken(wanted - pred, this.dq)

    const coefSkipOff = this.cdf.offset('coef_skip', 0, skipCtx)
    if (token === 0) {
      this.msac.encodeBoolAdapt(this.cdf.data, coefSkipOff, 1)
      aArr[aOff] = 0x40
      lArr[lOff] = 0x40
      fillBlock(reconstructed, stride, px, py, pred)
      return
    }

    this.msac.encodeBoolAdapt(this.cdf.data, coefSkipOff, 0)
    if (!chroma) {
      // In the reduced intra transform set, index 1 is DCT_DCT.
      this.msac.encodeSymbol(this.cdf.data, this.cdf.offset('txtp_intra2', 0, IntraPredMode.DC_PRED), 4, 1)
    }
    this.msac.encodeSymbol(this.cdf.data, this.cdf.offset('eob_bin_16', chroma, 0), 4, 0)

    const eobBase = this.cdf.offset('eob_base_tok', 0, chroma)
    this.msac.encodeSymbol(this.cdf.data, eobBase, 2, Math.min(token - 1, 2))
    if (token >= 3)
      this.encodeHighToken(this.cdf.offset('br_tok', 0, chroma), Math.min(token, 15))

    let signSum = -2 + (aArr[aOff] >> 6) + (lArr[lOff] >> 6)
    signSum = (signSum !== 0 ? 1 : 0) + (signSum > 0 ? 1 : 0)
    const negative = residual < 0 ? 1 : 0
    this.msac.encodeBoolAdapt(this.cdf.data, this.cdf.offset('dc_sign', chroma, signSum), negative)
    if (token >= 15)
      this.msac.writeGolomb(token - 15)

    const ctx = Math.min(token, 63) | (negative ? 0 : 2 << 6)
    aArr[aOff] = ctx
    lArr[lOff] = ctx
    fillBlock(reconstructed, stride, px, py, clipByte(pred + residual))
  }

  private encodeHighToken(cdfOff: number, token: number): void {
    const remaining = token
    for (const base of [3, 6, 9, 12]) {
      const symbol = Math.min(remaining - base, 3)
      this.msac.encodeSymbol(this.cdf.data, cdfOff, 3, symbol)
      if (symbol < 3)
        return
    }
  }
}

function chooseDcToken(delta: number, dq: number): { token: number, residual: number } {
  const negative = delta < 0
  const estimate = Math.max(0, Math.round(Math.abs(delta) * 32 / dq))
  let bestToken = 0
  let bestResidual = 0
  let bestError = Math.abs(delta)
  const lo = Math.max(1, estimate - 12)
  const hi = Math.min(4095, Math.max(16, estimate + 12))
  for (let token = lo; token <= hi; token++) {
    const residual = dct4DcResidual((negative ? -1 : 1) * dq * token)
    const error = Math.abs(delta - residual)
    if (error < bestError) {
      bestToken = token
      bestResidual = residual
      bestError = error
    }
  }
  return { token: bestToken, residual: bestResidual }
}

function dct4DcResidual(coefficient: number): number {
  let dc = (coefficient * 181 + 128) >> 8
  dc = (dc * 181 + 128 + 2048) >> 12
  return dc
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

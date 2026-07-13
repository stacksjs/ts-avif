/**
 * AV1 intra tile decoder: superblock/partition traversal, mode info, and
 * transform-coefficient entropy decoding. This is a TypeScript port of the
 * intra paths of dav1d's decode.c / recon_tmpl.c, using the same CDF layout
 * and helper tables (see cdf-tables.ts / tables.ts).
 *
 * Entropy decoding is self-contained: pixel reconstruction hooks in through
 * the `Reconstructor` interface so the entropy layer can be validated by
 * exact bitstream consumption alone.
 */
import type { CdfContext } from './cdf'
import type { FrameHeader } from './frame-header'
import type { EdgeNode } from './intra-edge'
import type { SequenceHeader } from './sequence'
import { clamp, floorLog2 } from './bits'
import {
  BlockLevel,
  BlockPartition,
  BlockSize,
  CFL_ALLOWED_MASK,
  IntraPredMode,
  TxClass,
  TxfmSize,
  TxfmType,
} from './consts'
import { SymbolDecoder } from './msac'
import {
  AL_PART_CTX,
  BLOCK_DIMENSIONS,
  BLOCK_SIZES,
  DQ_TBL_8BPC,
  INTRA_MODE_CONTEXT,
  LO_CTX_OFFSETS,
  MAX_TXFM_SIZE_FOR_BS,
  PARTITION_TYPE_COUNT,
  SCANS,
  SKIP_CTX,
  TX_TYPE_CLASS,
  TX_TYPES_PER_SET,
  TXFM_DIMENSIONS,
  TXTP_FROM_UVMODE,
} from './tables'

export interface TxfmInfo {
  w: number
  h: number
  lw: number
  lh: number
  min: number
  max: number
  sub: number
  ctx: number
}

const TXFM_INFO: TxfmInfo[] = []
for (let i = 0; i < TXFM_DIMENSIONS.length; i += 8) {
  TXFM_INFO.push({
    w: TXFM_DIMENSIONS[i],
    h: TXFM_DIMENSIONS[i + 1],
    lw: TXFM_DIMENSIONS[i + 2],
    lh: TXFM_DIMENSIONS[i + 3],
    min: TXFM_DIMENSIONS[i + 4],
    max: TXFM_DIMENSIONS[i + 5],
    sub: TXFM_DIMENSIONS[i + 6],
    ctx: TXFM_DIMENSIONS[i + 7],
  })
}
export { TXFM_INFO }

// dav1d_filter_mode_to_y_mode: y mode implied by each filter-intra mode
const FILTER_MODE_TO_Y_MODE_LOCAL = [
  IntraPredMode.DC_PRED,
  IntraPredMode.VERT_PRED,
  IntraPredMode.HOR_PRED,
  IntraPredMode.HOR_DOWN_PRED,
  IntraPredMode.DC_PRED,
]

export interface Av1Block {
  bl: number
  bp: number
  bs: number
  segId: number
  skipMode: number
  skip: number
  intra: number
  yMode: number
  yAngle: number
  uvMode: number
  uvAngle: number
  cflAlpha: [number, number]
  palSz: [number, number]
  tx: number
  uvtx: number
}

/**
 * Neighbor context state for one direction (above the current row of
 * superblocks, or left within the current superblock column). Above arrays
 * span the whole tile width; left arrays cover one 128px superblock column.
 */
class BlockContext {
  mode: Uint8Array
  lcoef: Uint8Array
  ccoef: [Uint8Array, Uint8Array]
  segPred: Uint8Array
  skip: Uint8Array
  skipMode: Uint8Array
  intra: Uint8Array
  txIntra: Int8Array
  tx: Int8Array
  partition: Uint8Array
  uvmode: Uint8Array
  palSz: Uint8Array

  constructor(n4: number) {
    this.mode = new Uint8Array(n4)
    this.lcoef = new Uint8Array(n4)
    this.ccoef = [new Uint8Array(n4), new Uint8Array(n4)]
    this.segPred = new Uint8Array(n4)
    this.skip = new Uint8Array(n4)
    this.skipMode = new Uint8Array(n4)
    this.intra = new Uint8Array(n4)
    this.txIntra = new Int8Array(n4)
    this.tx = new Int8Array(n4)
    this.partition = new Uint8Array(n4 >> 1)
    this.uvmode = new Uint8Array(n4)
    this.palSz = new Uint8Array(n4)
  }

  reset(keyframe: boolean): void {
    this.intra.fill(keyframe ? 1 : 0)
    this.uvmode.fill(IntraPredMode.DC_PRED)
    if (keyframe)
      this.mode.fill(IntraPredMode.DC_PRED)
    this.partition.fill(0)
    this.skip.fill(0)
    this.skipMode.fill(0)
    this.txIntra.fill(-1)
    this.tx.fill(TxfmSize.TX_64X64)
    this.lcoef.fill(0x40)
    this.ccoef[0].fill(0x40)
    this.ccoef[1].fill(0x40)
    this.segPred.fill(0)
    this.palSz.fill(0)
  }
}

/** Pixel-level reconstruction hooks, invoked in bitstream order. */
export interface Reconstructor {
  /** Called once per block before its tx-block loops. */
  startBlock: (bs: number, b: Av1Block, dec: TileDecoder) => void
  /** Whole-block CFL chroma prediction, after luma reconstruction. */
  predictCfl: (b: Av1Block, dec: TileDecoder, cbw4: number, cbh4: number, cw4: number, ch4: number) => void
  /**
   * Predict one tx block and add its residual (`eob` = -1 means none;
   * `bx`/`by` are in the plane's own 4px units; `edgeFlags` carries the
   * I444-style top-right/bottom-left availability for this tx block).
   */
  reconTxBlock: (
    plane: number,
    bx: number,
    by: number,
    tx: number,
    txtp: number,
    eob: number,
    cf: Int32Array,
    b: Av1Block,
    dec: TileDecoder,
    edgeFlags: number,
  ) => void
}

export class TileDecoder {
  msac: SymbolDecoder
  cdf: CdfContext
  bx = 0
  by = 0
  a: BlockContext
  l: BlockContext
  bw4: number
  bh4: number
  ssHor: number
  ssVer: number
  layout: number

  colStart = 0
  colEnd: number
  rowStart = 0
  rowEnd: number

  /** dq[segId][plane][0=dc,1=ac] for the frame-level qindex. */
  frameDq: number[][][]
  dq: number[][][]
  lastQIdx: number
  lastDeltaLf = [0, 0, 0, 0]

  cf = new Int32Array(32 * 32)
  levels = new Uint8Array(1088)
  cdefIdx = [-1, -1, -1, -1]

  /** Per-4x4 segment id map for the whole frame (spatial prediction). */
  segMap: Uint8Array | null = null

  /** Loop-restoration reader (consumes per-SB entropy bits when active). */
  restoration: { readForSuperblock: (m: SymbolDecoder, c: CdfContext, bx: number, by: number) => void } | null = null

  /** CDEF metadata sink: cdef index per 64x64 sb, non-skip per 4x4. */
  cdefData: { idx: Int8Array, noskip: Uint8Array, sb64w: number } | null = null

  recon: Reconstructor | null

  constructor(
    readonly seq: SequenceHeader,
    readonly hdr: FrameHeader,
    tileData: Uint8Array,
    cdf: CdfContext,
    recon: Reconstructor | null = null,
  ) {
    if (seq.bitDepth !== 8)
      throw new Error('ts-avif: only 8-bit AV1 streams are supported so far')
    this.msac = new SymbolDecoder(tileData, hdr.disableCdfUpdate)
    this.cdf = cdf
    this.recon = recon
    this.bw4 = hdr.miCols
    this.bh4 = hdr.miRows
    this.ssVer = seq.subsamplingY
    this.ssHor = seq.subsamplingX
    this.layout = seq.monochrome ? 0 : seq.subsamplingX === 0 ? 3 : seq.subsamplingY === 0 ? 2 : 1
    this.colEnd = this.bw4
    this.rowEnd = this.bh4
    const aligned = (this.bw4 + 31) & ~31
    this.a = new BlockContext(aligned)
    this.l = new BlockContext(32)
    this.a.reset(true)

    this.frameDq = []
    for (let seg = 0; seg < 8; seg++)
      this.frameDq.push(computeDq(hdr, hdr.segQIndex[seg]))
    this.dq = this.frameDq
    this.lastQIdx = hdr.quantization.baseQIdx

    if (hdr.segmentation.enabled)
      this.segMap = new Uint8Array(this.bw4 * this.bh4)
  }

  /** Decode every superblock of the (single-tile-column) tile. */
  decodeTile(sbRoot: EdgeNode): void {
    const sbStep = this.seq.use128x128Superblock ? 32 : 16
    const rootBl = this.seq.use128x128Superblock ? BlockLevel.BL_128X128 : BlockLevel.BL_64X64
    for (this.by = this.rowStart; this.by < this.rowEnd; this.by += sbStep) {
      this.l.reset(true)
      for (this.bx = this.colStart; this.bx < this.colEnd; this.bx += sbStep) {
        this.cdefIdx[0] = this.cdefIdx[1] = this.cdefIdx[2] = this.cdefIdx[3] = -1
        this.restoration?.readForSuperblock(this.msac, this.cdf, this.bx, this.by)
        this.decodeSb(rootBl, sbRoot)
        if (this.cdefData && this.cdefIdx[0] >= 0)
          this.cdefData.idx[(this.by >> 4) * this.cdefData.sb64w + (this.bx >> 4)] = this.cdefIdx[0]
      }
    }
  }

  private decodeSb(bl: BlockLevel, node: EdgeNode): void {
    const hsz = 16 >> bl
    const haveHSplit = this.bw4 > this.bx + hsz
    const haveVSplit = this.bh4 > this.by + hsz

    if (!haveHSplit && !haveVSplit) {
      this.decodeSb(bl + 1, node.split![0])
      return
    }

    const by8 = (this.by & 31) >> 1
    const ctx = ((this.a.partition[this.bx >> 1] >> (4 - bl)) & 1)
      + (((this.l.partition[by8] >> (4 - bl)) & 1) << 1)
    const pcOff = this.cdf.offset('partition', bl, ctx)

    let bp: BlockPartition
    if (haveHSplit && haveVSplit) {
      bp = this.msac.decodeSymbol(this.cdf.data, pcOff, PARTITION_TYPE_COUNT[bl])
      const b0 = BLOCK_SIZES[(bl * 10 + bp) * 2]
      const b1 = BLOCK_SIZES[(bl * 10 + bp) * 2 + 1]

      switch (bp) {
        case BlockPartition.NONE:
          this.decodeB(bl, b0, bp, node.o)
          break
        case BlockPartition.H:
          this.decodeB(bl, b0, bp, node.h[0])
          this.by += hsz
          this.decodeB(bl, b0, bp, node.h[1])
          this.by -= hsz
          break
        case BlockPartition.V:
          this.decodeB(bl, b0, bp, node.v[0])
          this.bx += hsz
          this.decodeB(bl, b0, bp, node.v[1])
          this.bx -= hsz
          break
        case BlockPartition.SPLIT:
          if (bl === BlockLevel.BL_8X8) {
            const tip = node.tipSplit!
            this.decodeB(bl, BlockSize.BS_4x4, bp, 0x3F /* EDGE_ALL_TR_AND_BL */)
            this.bx++
            this.decodeB(bl, BlockSize.BS_4x4, bp, tip[0])
            this.bx--
            this.by++
            this.decodeB(bl, BlockSize.BS_4x4, bp, tip[1])
            this.bx++
            this.decodeB(bl, BlockSize.BS_4x4, bp, tip[2])
            this.bx--
            this.by--
          }
          else {
            this.decodeSb(bl + 1, node.split![0])
            this.bx += hsz
            this.decodeSb(bl + 1, node.split![1])
            this.bx -= hsz
            this.by += hsz
            this.decodeSb(bl + 1, node.split![2])
            this.bx += hsz
            this.decodeSb(bl + 1, node.split![3])
            this.bx -= hsz
            this.by -= hsz
          }
          break
        case BlockPartition.T_TOP_SPLIT:
          this.decodeB(bl, b0, bp, 0x3F)
          this.bx += hsz
          this.decodeB(bl, b0, bp, node.v[1])
          this.bx -= hsz
          this.by += hsz
          this.decodeB(bl, b1, bp, node.h[1])
          this.by -= hsz
          break
        case BlockPartition.T_BOTTOM_SPLIT:
          this.decodeB(bl, b0, bp, node.h[0])
          this.by += hsz
          this.decodeB(bl, b1, bp, node.v[0])
          this.bx += hsz
          this.decodeB(bl, b1, bp, 0)
          this.bx -= hsz
          this.by -= hsz
          break
        case BlockPartition.T_LEFT_SPLIT:
          this.decodeB(bl, b0, bp, 0x3F)
          this.by += hsz
          this.decodeB(bl, b0, bp, node.h[1])
          this.by -= hsz
          this.bx += hsz
          this.decodeB(bl, b1, bp, node.v[1])
          this.bx -= hsz
          break
        case BlockPartition.T_RIGHT_SPLIT:
          this.decodeB(bl, b0, bp, node.v[0])
          this.bx += hsz
          this.decodeB(bl, b1, bp, node.h[0])
          this.by += hsz
          this.decodeB(bl, b1, bp, 0)
          this.by -= hsz
          this.bx -= hsz
          break
        case BlockPartition.H4:
          this.decodeB(bl, b0, bp, node.h[0])
          this.by += hsz >> 1
          this.decodeB(bl, b0, bp, node.h4!)
          this.by += hsz >> 1
          this.decodeB(bl, b0, bp, 0x38 /* EDGE_ALL_LEFT_HAS_BOTTOM */)
          this.by += hsz >> 1
          if (this.by < this.bh4)
            this.decodeB(bl, b0, bp, node.h[1])
          this.by -= (hsz * 3) >> 1
          break
        case BlockPartition.V4:
          this.decodeB(bl, b0, bp, node.v[0])
          this.bx += hsz >> 1
          this.decodeB(bl, b0, bp, node.v4!)
          this.bx += hsz >> 1
          this.decodeB(bl, b0, bp, 0x07 /* EDGE_ALL_TOP_HAS_RIGHT */)
          this.bx += hsz >> 1
          if (this.bx < this.bw4)
            this.decodeB(bl, b0, bp, node.v[1])
          this.bx -= (hsz * 3) >> 1
          break
        default:
          throw new Error(`ts-avif: invalid partition ${bp}`)
      }
    }
    else if (haveHSplit) {
      const isSplit = this.msac.decodeBool(gatherTopPartitionProb(this.cdf.data, pcOff, bl))
      if (isSplit) {
        bp = BlockPartition.SPLIT
        this.decodeSb(bl + 1, node.split![0])
        this.bx += hsz
        this.decodeSb(bl + 1, node.split![1])
        this.bx -= hsz
      }
      else {
        bp = BlockPartition.H
        this.decodeB(bl, BLOCK_SIZES[(bl * 10 + BlockPartition.H) * 2], bp, node.h[0])
      }
    }
    else {
      const isSplit = this.msac.decodeBool(gatherLeftPartitionProb(this.cdf.data, pcOff, bl))
      if (isSplit) {
        bp = BlockPartition.SPLIT
        this.decodeSb(bl + 1, node.split![0])
        this.by += hsz
        this.decodeSb(bl + 1, node.split![2])
        this.by -= hsz
      }
      else {
        bp = BlockPartition.V
        this.decodeB(bl, BLOCK_SIZES[(bl * 10 + BlockPartition.V) * 2], bp, node.v[0])
      }
    }

    if (bp !== BlockPartition.SPLIT || bl === BlockLevel.BL_8X8) {
      const aVal = AL_PART_CTX[(0 * 5 + bl) * 10 + bp]
      const lVal = AL_PART_CTX[(1 * 5 + bl) * 10 + bp]
      const bx8a = this.bx >> 1
      for (let i = 0; i < hsz; i++) {
        this.a.partition[bx8a + i] = aVal
        this.l.partition[by8 + i] = lVal
      }
    }
  }

  private decodeB(bl: BlockLevel, bs: BlockSize, bp: BlockPartition, intraEdgeFlags: number): void {
    const { msac, cdf, hdr } = this
    const bDimOff = bs * 4
    const bw4 = BLOCK_DIMENSIONS[bDimOff]
    const bh4 = BLOCK_DIMENSIONS[bDimOff + 1]
    const bx4 = this.bx
    const by4 = this.by & 31
    const w4 = Math.min(bw4, this.bw4 - this.bx)
    const h4 = Math.min(bh4, this.bh4 - this.by)
    const ssHor = this.ssHor
    const ssVer = this.ssVer
    const cbx4 = bx4 >> ssHor
    const cby4 = by4 >> ssVer
    const cbw4 = (bw4 + ssHor) >> ssHor
    const cbh4 = (bh4 + ssVer) >> ssVer
    const haveLeft = this.bx > this.colStart
    const haveTop = this.by > this.rowStart
    const hasChroma = !this.seq.monochrome
      && (bw4 > ssHor || (this.bx & 1) === 1)
      && (bh4 > ssVer || (this.by & 1) === 1)

    const b: Av1Block = {
      bl,
      bp,
      bs,
      segId: 0,
      skipMode: 0,
      skip: 0,
      intra: 1,
      yMode: IntraPredMode.DC_PRED,
      yAngle: 0,
      uvMode: IntraPredMode.DC_PRED,
      uvAngle: 0,
      cflAlpha: [0, 0],
      palSz: [0, 0],
      tx: TxfmSize.TX_4X4,
      uvtx: TxfmSize.TX_4X4,
    }

    // segment_id (pre-skip). The seg map is frame-absolute, so use this.by.
    const seg = hdr.segmentation
    if (seg.enabled && seg.updateMap && seg.segIdPreSkip)
      b.segId = this.readSegId(this.bx, this.by, w4, h4, haveTop, haveLeft, false)

    // skip_mode: never present in intra frames
    b.skipMode = 0

    // skip
    {
      const sctx = this.a.skip[bx4] + this.l.skip[by4]
      b.skip = msac.decodeBoolAdapt(cdf.data, cdf.offset('skip', sctx))
    }

    // segment_id (post-skip)
    if (seg.enabled && seg.updateMap && !seg.segIdPreSkip)
      b.segId = this.readSegId(this.bx, this.by, w4, h4, haveTop, haveLeft, b.skip === 1)
    if (seg.enabled)
      this.writeSegMap(this.bx, this.by, bw4, bh4, b.segId)

    // CDEF non-skip map (blocks with coded coefficients get filtered)
    if (this.cdefData && !b.skip) {
      const cd = this.cdefData
      const hh = Math.min(bh4, this.bh4 - this.by)
      const ww = Math.min(bw4, this.bw4 - this.bx)
      for (let y = 0; y < hh; y++)
        cd.noskip.fill(1, (this.by + y) * this.bw4 + this.bx, (this.by + y) * this.bw4 + this.bx + ww)
    }

    // cdef index
    if (!b.skip) {
      const idx = this.seq.use128x128Superblock
        ? ((this.bx & 16) >> 4) + ((this.by & 16) >> 3)
        : 0
      if (this.cdefIdx[idx] === -1) {
        const v = msac.readLiteral(hdr.cdef.bits)
        this.cdefIdx[idx] = v
        if (bw4 > 16)
          this.cdefIdx[idx + 1] = v
        if (bh4 > 16)
          this.cdefIdx[idx + 2] = v
        if (bw4 === 32 && bh4 === 32)
          this.cdefIdx[idx + 3] = v
      }
    }

    // delta-q/lf at superblock top-left
    const sbMask = this.seq.use128x128Superblock ? 31 : 15
    if (((this.bx | this.by) & sbMask) === 0) {
      const sbBs = this.seq.use128x128Superblock ? BlockSize.BS_128x128 : BlockSize.BS_64x64
      const haveDeltaQ = hdr.deltaQPresent && (bs !== sbBs || !b.skip)
      if (haveDeltaQ) {
        let deltaQ = msac.decodeSymbol(cdf.data, cdf.offset('delta_q'), 3)
        if (deltaQ === 3) {
          const nBits = 1 + msac.readLiteral(3)
          deltaQ = msac.readLiteral(nBits) + 1 + (1 << nBits)
        }
        if (deltaQ) {
          if (msac.decodeBoolEqui())
            deltaQ = -deltaQ
          deltaQ *= 1 << hdr.deltaQRes
        }
        this.lastQIdx = clamp(this.lastQIdx + deltaQ, 1, 255)

        if (hdr.deltaLfPresent) {
          const nLfs = hdr.deltaLfMulti ? (this.seq.monochrome ? 2 : 4) : 1
          for (let i = 0; i < nLfs; i++) {
            let deltaLf = msac.decodeSymbol(
              cdf.data,
              cdf.offset('delta_lf', i + (hdr.deltaLfMulti ? 1 : 0)),
              3,
            )
            if (deltaLf === 3) {
              const nBits = 1 + msac.readLiteral(3)
              deltaLf = msac.readLiteral(nBits) + 1 + (1 << nBits)
            }
            if (deltaLf) {
              if (msac.decodeBoolEqui())
                deltaLf = -deltaLf
              deltaLf *= 1 << hdr.deltaLfRes
            }
            this.lastDeltaLf[i] = clamp(this.lastDeltaLf[i] + deltaLf, -63, 63)
          }
        }
        if (this.lastQIdx === hdr.quantization.baseQIdx) {
          this.dq = this.frameDq
        }
        else {
          this.dq = []
          for (let s = 0; s < 8; s++)
            this.dq.push(computeDq(hdr, this.lastQIdx))
        }
      }
    }

    // intra flag: key/intra frames without intrabc are always intra
    if (hdr.allowIntrabc) {
      const isIntra = !msac.decodeBoolAdapt(cdf.data, cdf.offset('intrabc'))
      if (!isIntra)
        throw new Error('ts-avif: intra block copy is not supported yet')
    }
    b.intra = 1

    // y mode (key-frame contexts from neighbors)
    const ctxA = INTRA_MODE_CONTEXT[this.a.mode[bx4]]
    const ctxL = INTRA_MODE_CONTEXT[this.l.mode[by4]]
    b.yMode = msac.decodeSymbol(cdf.data, cdf.offset('kfym', ctxA, ctxL), 12)

    const lw = BLOCK_DIMENSIONS[bDimOff + 2]
    const lh = BLOCK_DIMENSIONS[bDimOff + 3]
    if (lw + lh >= 2 && b.yMode >= IntraPredMode.VERT_PRED
      && b.yMode <= IntraPredMode.VERT_LEFT_PRED) {
      const angle = msac.decodeSymbol(
        cdf.data,
        cdf.offset('angle_delta', b.yMode - IntraPredMode.VERT_PRED),
        6,
      )
      b.yAngle = angle - 3
    }

    if (hasChroma) {
      const cflAllowed = hdr.losslessArray[b.segId]
        ? cbw4 === 1 && cbh4 === 1
        : (CFL_ALLOWED_MASK & (1 << bs)) !== 0
      b.uvMode = msac.decodeSymbol(
        cdf.data,
        cdf.offset('uv_mode', cflAllowed ? 1 : 0, b.yMode),
        13 - (cflAllowed ? 0 : 1),
      )
      if (b.uvMode === IntraPredMode.CFL_PRED) {
        const sign = msac.decodeSymbol(cdf.data, cdf.offset('cfl_sign'), 7) + 1
        const signU = (sign * 0x56) >> 8
        const signV = sign - signU * 3
        if (signU) {
          const alphaCtx = (signU === 2 ? 3 : 0) + signV
          b.cflAlpha[0] = msac.decodeSymbol(cdf.data, cdf.offset('cfl_alpha', alphaCtx), 15) + 1
          if (signU === 1)
            b.cflAlpha[0] = -b.cflAlpha[0]
        }
        if (signV) {
          const alphaCtx = (signV === 2 ? 3 : 0) + signU
          b.cflAlpha[1] = msac.decodeSymbol(cdf.data, cdf.offset('cfl_alpha', alphaCtx), 15) + 1
          if (signV === 1)
            b.cflAlpha[1] = -b.cflAlpha[1]
        }
      }
      else if (lw + lh >= 2 && b.uvMode >= IntraPredMode.VERT_PRED
        && b.uvMode <= IntraPredMode.VERT_LEFT_PRED) {
        const angle = msac.decodeSymbol(
          cdf.data,
          cdf.offset('angle_delta', b.uvMode - IntraPredMode.VERT_PRED),
          6,
        )
        b.uvAngle = angle - 3
      }
    }

    // palette
    if (hdr.allowScreenContentTools && Math.max(bw4, bh4) <= 16 && bw4 + bh4 >= 4) {
      const szCtx = lw + lh - 2
      if (b.yMode === IntraPredMode.DC_PRED) {
        const palCtx = (this.a.palSz[bx4] > 0 ? 1 : 0) + (this.l.palSz[by4] > 0 ? 1 : 0)
        if (msac.decodeBoolAdapt(cdf.data, cdf.offset('pal_y', szCtx, palCtx)))
          throw new Error('ts-avif: palette mode is not supported yet')
      }
      if (hasChroma && b.uvMode === IntraPredMode.DC_PRED) {
        const palCtx = b.palSz[0] > 0 ? 1 : 0
        if (msac.decodeBoolAdapt(cdf.data, cdf.offset('pal_uv', palCtx)))
          throw new Error('ts-avif: palette mode is not supported yet')
      }
    }

    // filter intra
    if (b.yMode === IntraPredMode.DC_PRED && b.palSz[0] === 0
      && Math.max(lw, lh) <= 3 && this.seq.enableFilterIntra) {
      const isFilter = msac.decodeBoolAdapt(cdf.data, cdf.offset('use_filter_intra', bs))
      if (isFilter) {
        b.yMode = IntraPredMode.FILTER_PRED
        b.yAngle = msac.decodeSymbol(cdf.data, cdf.offset('filter_intra'), 4)
      }
    }

    // tx size
    let tDim: TxfmInfo
    if (hdr.losslessArray[b.segId]) {
      b.tx = TxfmSize.TX_4X4
      b.uvtx = TxfmSize.TX_4X4
      tDim = TXFM_INFO[TxfmSize.TX_4X4]
    }
    else {
      b.tx = MAX_TXFM_SIZE_FOR_BS[bs * 4]
      b.uvtx = MAX_TXFM_SIZE_FOR_BS[bs * 4 + this.layout]
      tDim = TXFM_INFO[b.tx]
      if (hdr.txMode === 2 /* TX_MODE_SELECT */ && tDim.max > TxfmSize.TX_4X4) {
        const tctx = (this.l.txIntra[by4] >= tDim.lh ? 1 : 0)
          + (this.a.txIntra[bx4] >= tDim.lw ? 1 : 0)
        let depth = msac.decodeSymbol(
          cdf.data,
          cdf.offset('txsz', tDim.max - 1, tctx),
          Math.min(tDim.max, 2),
        )
        while (depth--) {
          b.tx = tDim.sub
          tDim = TXFM_INFO[b.tx]
        }
      }
    }

    // reconstruction traversal (coefficients + pixels)
    this.reconBIntra(bs, b, w4, h4, cbw4, cbh4, hasChroma, intraEdgeFlags)

    // update neighbor contexts
    const yModeNofilt = b.yMode === IntraPredMode.FILTER_PRED ? IntraPredMode.DC_PRED : b.yMode
    for (let i = 0; i < bw4; i++) {
      const o = bx4 + i
      this.a.txIntra[o] = tDim.lw
      this.a.tx[o] = tDim.lw
      this.a.mode[o] = yModeNofilt
      this.a.palSz[o] = b.palSz[0]
      this.a.segPred[o] = 0
      this.a.skipMode[o] = 0
      this.a.intra[o] = 1
      this.a.skip[o] = b.skip
    }
    for (let i = 0; i < bh4; i++) {
      const o = by4 + i
      this.l.txIntra[o] = tDim.lh
      this.l.tx[o] = tDim.lh
      this.l.mode[o] = yModeNofilt
      this.l.palSz[o] = b.palSz[0]
      this.l.segPred[o] = 0
      this.l.skipMode[o] = 0
      this.l.intra[o] = 1
      this.l.skip[o] = b.skip
    }
    if (hasChroma) {
      this.a.uvmode.fill(b.uvMode, cbx4, cbx4 + cbw4)
      this.l.uvmode.fill(b.uvMode, cby4, cby4 + cbh4)
    }
  }

  private readSegId(
    bx4: number,
    by4: number,
    _w4: number,
    _h4: number,
    haveTop: boolean,
    haveLeft: boolean,
    skip: boolean,
  ): number {
    const map = this.segMap!
    const stride = this.bw4
    const base = by4 * stride + bx4
    // get_cur_frame_segid: spatial prediction + context
    let segCtx: number
    let predSegId: number
    if (haveLeft && haveTop) {
      const l = map[base - 1]
      const a = map[base - stride]
      const al = map[base - stride - 1]
      if (l === a && al === l)
        segCtx = 2
      else if (l === a || al === l || a === al)
        segCtx = 1
      else
        segCtx = 0
      predSegId = a === al ? a : l
    }
    else {
      segCtx = 0
      predSegId = haveLeft ? map[base - 1] : haveTop ? map[base - stride] : 0
    }

    if (skip)
      return predSegId

    const diff = this.msac.decodeSymbol(this.cdf.data, this.cdf.offset('seg_id', segCtx), 7)
    const lastActive = this.hdr.segmentation.lastActiveSegId
    let segId = negDeinterleave(diff, predSegId, lastActive + 1)
    if (segId > lastActive || segId >= 8)
      segId = 0
    return segId
  }

  /** Write the block's segment id to every 4x4 cell it covers (frame-clamped). */
  private writeSegMap(bx4: number, by4: number, bw4: number, bh4: number, segId: number): void {
    const map = this.segMap!
    const stride = this.bw4
    const w = Math.min(bw4, this.bw4 - bx4)
    const h = Math.min(bh4, this.bh4 - by4)
    for (let y = 0; y < h; y++)
      map.fill(segId, (by4 + y) * stride + bx4, (by4 + y) * stride + bx4 + w)
  }

  /**
   * Coefficient + reconstruction traversal for an intra block, following
   * dav1d's recon_b_intra tx-block ordering exactly.
   */
  private reconBIntra(
    bs: BlockSize,
    b: Av1Block,
    w4: number,
    h4: number,
    cbw4: number,
    cbh4: number,
    hasChroma: boolean,
    intraEdgeFlags: number,
  ): void {
    const tDim = TXFM_INFO[b.tx]
    const uvTDim = TXFM_INFO[b.uvtx]
    const bx4 = this.bx
    const by4 = this.by & 31
    const ssHor = this.ssHor
    const ssVer = this.ssVer
    const cbx4 = bx4 >> ssHor
    const cby4 = by4 >> ssVer
    const cw4 = (w4 + ssHor) >> ssHor
    const ch4 = (h4 + ssVer) >> ssVer

    this.recon?.startBlock(bs, b, this)

    for (let initY = 0; initY < h4; initY += 16) {
      const subH4 = Math.min(h4, 16 + initY)
      const subCh4 = Math.min(ch4, (initY + 16) >> ssVer)
      for (let initX = 0; initX < w4; initX += 16) {
        const subW4 = Math.min(w4, initX + 16)
        const sbHasTr = initX + 16 < w4
          ? 1
          : initY ? 0 : intraEdgeFlags & 0x01 /* EDGE_I444_TOP_HAS_RIGHT */
        const sbHasBl = initX
          ? 0
          : initY + 16 < h4 ? 1 : intraEdgeFlags & 0x08 /* EDGE_I444_LEFT_HAS_BOTTOM */

        // luma tx blocks
        let x = 0
        let y = 0
        for (y = initY, this.by += initY; y < subH4; y += tDim.h, this.by += tDim.h) {
          for (x = initX, this.bx += initX; x < subW4; x += tDim.w, this.bx += tDim.w) {
            const txEdgeFlags
              = (((y > initY || !sbHasTr) && (x + tDim.w >= subW4)) ? 0 : 0x01)
                | ((x > initX || (!sbHasBl && y + tDim.h >= subH4)) ? 0 : 0x08)
            if (!b.skip) {
              this.cf.fill(0)
              const { eob, txtp, ctx } = this.decodeCoefs(
                this.a.lcoef,
                bx4 + x,
                this.l.lcoef,
                by4 + y,
                b.tx,
                bs,
                b,
                1,
                0,
              )
              this.a.lcoef.fill(ctx, bx4 + x, bx4 + x + Math.min(tDim.w, this.bw4 - this.bx))
              this.l.lcoef.fill(ctx, by4 + y, by4 + y + Math.min(tDim.h, this.bh4 - this.by))
              this.recon?.reconTxBlock(
                0,
                this.bx,
                this.by,
                b.tx,
                txtp,
                eob,
                this.cf,
                b,
                this,
                txEdgeFlags,
              )
            }
            else {
              this.a.lcoef.fill(0x40, bx4 + x, bx4 + x + tDim.w)
              this.l.lcoef.fill(0x40, by4 + y, by4 + y + tDim.h)
              this.recon?.reconTxBlock(0, this.bx, this.by, b.tx, 0, -1, this.cf, b, this, txEdgeFlags)
            }
          }
          this.bx -= x
        }
        this.by -= y

        if (!hasChroma)
          continue

        if (b.uvMode === IntraPredMode.CFL_PRED && initX === 0 && initY === 0)
          this.recon?.predictCfl(b, this, cbw4, cbh4, cw4, ch4)

        const uvSbHasTr = ((initX + 16) >> ssHor) < cw4
          ? 1
          : initY ? 0 : intraEdgeFlags & (0x04 >> (this.layout - 1))
        const uvSbHasBl = initX
          ? 0
          : ((initY + 16) >> ssVer) < ch4
            ? 1
            : intraEdgeFlags & (0x20 >> (this.layout - 1))

        const subCw4 = Math.min(cw4, (initX + 16) >> ssHor)
        for (let pl = 0; pl < 2; pl++) {
          for (y = initY >> ssVer, this.by += initY; y < subCh4;
            y += uvTDim.h, this.by += uvTDim.h << ssVer) {
            for (x = initX >> ssHor, this.bx += initX; x < subCw4;
              x += uvTDim.w, this.bx += uvTDim.w << ssHor) {
              const txEdgeFlags
                = (((y > (initY >> ssVer) || !uvSbHasTr) && (x + uvTDim.w >= subCw4)) ? 0 : 0x01)
                  | ((x > (initX >> ssHor) || (!uvSbHasBl && y + uvTDim.h >= subCh4)) ? 0 : 0x08)
              if (!b.skip) {
                this.cf.fill(0)
                const { eob, txtp, ctx } = this.decodeCoefs(
                  this.a.ccoef[pl],
                  cbx4 + x,
                  this.l.ccoef[pl],
                  cby4 + y,
                  b.uvtx,
                  bs,
                  b,
                  1,
                  1 + pl,
                )
                const ctw = Math.min(uvTDim.w, (this.bw4 - this.bx + ssHor) >> ssHor)
                const cth = Math.min(uvTDim.h, (this.bh4 - this.by + ssVer) >> ssVer)
                this.a.ccoef[pl].fill(ctx, cbx4 + x, cbx4 + x + ctw)
                this.l.ccoef[pl].fill(ctx, cby4 + y, cby4 + y + cth)
                this.recon?.reconTxBlock(
                  1 + pl,
                  this.bx >> ssHor,
                  this.by >> ssVer,
                  b.uvtx,
                  txtp,
                  eob,
                  this.cf,
                  b,
                  this,
                  txEdgeFlags,
                )
              }
              else {
                this.a.ccoef[pl].fill(0x40, cbx4 + x, cbx4 + x + uvTDim.w)
                this.l.ccoef[pl].fill(0x40, cby4 + y, cby4 + y + uvTDim.h)
                this.recon?.reconTxBlock(1 + pl, this.bx >> ssHor, this.by >> ssVer, b.uvtx, 0, -1, this.cf, b, this, txEdgeFlags)
              }
            }
            this.bx -= x << ssHor
          }
          this.by -= y << ssVer
        }
      }
    }
  }

  /** Port of dav1d decode_coefs (intra still-image paths). */
  decodeCoefs(
    aArr: Uint8Array,
    aOff: number,
    lArr: Uint8Array,
    lOff: number,
    tx: number,
    bs: BlockSize,
    b: Av1Block,
    intra: number,
    plane: number,
  ): { eob: number, txtp: number, ctx: number } {
    const { msac, cdf, hdr } = this
    const chroma = plane ? 1 : 0
    const lossless = hdr.losslessArray[b.segId]
    const tDim = TXFM_INFO[tx]
    const cf = this.cf

    // skip flag
    const sctx = this.getSkipCtx(tDim, bs, aArr, aOff, lArr, lOff, chroma)
    const allSkip = msac.decodeBoolAdapt(cdf.data, cdf.offset('coef_skip', tDim.ctx, sctx))
    if (allSkip) {
      return {
        eob: -1,
        txtp: lossless ? TxfmType.WHT_WHT : TxfmType.DCT_DCT,
        ctx: 0x40,
      }
    }

    // transform type
    let txtp: number
    if (lossless) {
      txtp = TxfmType.WHT_WHT
    }
    else if (tDim.max + intra >= TxfmSize.TX_64X64) {
      txtp = TxfmType.DCT_DCT
    }
    else if (chroma) {
      txtp = TXTP_FROM_UVMODE[b.uvMode]
    }
    else if (hdr.segQIndex[b.segId] === 0) {
      txtp = TxfmType.DCT_DCT
    }
    else {
      const yModeNofilt = b.yMode === IntraPredMode.FILTER_PRED
        ? FILTER_MODE_TO_Y_MODE_LOCAL[b.yAngle]
        : b.yMode
      if (hdr.reducedTxSet || tDim.min === TxfmSize.TX_16X16) {
        const idx = msac.decodeSymbol(cdf.data, cdf.offset('txtp_intra2', tDim.min, yModeNofilt), 4)
        txtp = TX_TYPES_PER_SET[idx]
      }
      else {
        const idx = msac.decodeSymbol(cdf.data, cdf.offset('txtp_intra1', tDim.min, yModeNofilt), 6)
        txtp = TX_TYPES_PER_SET[idx + 5]
      }
    }

    // eob
    const slw = Math.min(tDim.lw, 3)
    const slh = Math.min(tDim.lh, 3)
    const tx2dSzCtx = slw + slh
    const txClass = TX_TYPE_CLASS[txtp]
    const is1d = txClass !== TxClass.TWO_D ? 1 : 0
    let eob: number
    switch (tx2dSzCtx) {
      case 0: eob = msac.decodeSymbol(cdf.data, cdf.offset('eob_bin_16', chroma, is1d), 4); break
      case 1: eob = msac.decodeSymbol(cdf.data, cdf.offset('eob_bin_32', chroma, is1d), 5); break
      case 2: eob = msac.decodeSymbol(cdf.data, cdf.offset('eob_bin_64', chroma, is1d), 6); break
      case 3: eob = msac.decodeSymbol(cdf.data, cdf.offset('eob_bin_128', chroma, is1d), 7); break
      case 4: eob = msac.decodeSymbol(cdf.data, cdf.offset('eob_bin_256', chroma, is1d), 8); break
      case 5: eob = msac.decodeSymbol(cdf.data, cdf.offset('eob_bin_512', chroma), 9); break
      default: eob = msac.decodeSymbol(cdf.data, cdf.offset('eob_bin_1024', chroma), 10); break
    }
    if (eob > 1) {
      const eobBin = eob - 2
      const hiBit = msac.decodeBoolAdapt(cdf.data, cdf.offset('eob_hi_bit', tDim.ctx, chroma, eobBin))
      eob = ((hiBit | 2) << eobBin) | msac.readLiteral(eobBin)
    }

    const eobCdfBase = cdf.offset('eob_base_tok', tDim.ctx, chroma)
    const hiCdfBase = cdf.offset('br_tok', Math.min(tDim.ctx, 3), chroma)
    let rc = 0
    let dcTok: number

    if (eob) {
      const loCdfBase = cdf.offset('base_tok', tDim.ctx, chroma)
      const levels = this.levels

      // eob position token
      let ctx = 1 + (eob > 2 << tx2dSzCtx ? 1 : 0) + (eob > 4 << tx2dSzCtx ? 1 : 0)
      const eobTok = msac.decodeSymbol(cdf.data, eobCdfBase + ctx * 4, 2)
      let tok = eobTok + 1
      let levelTok = tok * 0x41
      let mag = 0

      let stride: number
      let shift: number
      let shift2 = 0
      let mask: number
      let loCtxTblOff = 0 // into LO_CTX_OFFSETS, 2D only
      let scan: readonly number[] | null = null
      if (txClass === TxClass.TWO_D) {
        const nonsquare = tx >= 5 ? 1 : 0
        loCtxTblOff = (nonsquare + (tx & nonsquare)) * 25
        scan = SCANS[tx]
        stride = 4 << slh
        shift = slh + 2
        mask = (4 << slh) - 1
        levels.fill(0, 0, stride * ((4 << slw) + 2))
      }
      else if (txClass === TxClass.H) {
        stride = 16
        shift = slh + 2
        mask = (4 << slh) - 1
        levels.fill(0, 0, stride * ((4 << slh) + 2))
      }
      else {
        stride = 16
        shift = slw + 2
        shift2 = slh + 2
        mask = (4 << slw) - 1
        levels.fill(0, 0, stride * ((4 << slw) + 2))
      }

      let x: number
      let y: number
      let levelOff: number
      if (txClass === TxClass.TWO_D) {
        rc = scan![eob]
        x = rc >> shift
        y = rc & mask
        levelOff = rc
      }
      else if (txClass === TxClass.H) {
        x = eob & mask
        y = eob >> shift
        rc = eob
        levelOff = x * stride + y
      }
      else {
        x = eob & mask
        y = eob >> shift
        rc = (x << shift2) | y
        levelOff = x * stride + y
      }
      if (eobTok === 2) {
        ctx = (txClass === TxClass.TWO_D ? (x | y) > 1 : y !== 0) ? 14 : 7
        tok = this.decodeHiTok(hiCdfBase + ctx * 4)
        levelTok = tok + (3 << 6)
      }
      cf[rc] = tok << 11
      levels[levelOff] = levelTok & 0xFF

      for (let i = eob - 1; i > 0; i--) {
        let rcI: number
        if (txClass === TxClass.TWO_D) {
          rcI = scan![i]
          x = rcI >> shift
          y = rcI & mask
          levelOff = rcI
        }
        else if (txClass === TxClass.H) {
          x = i & mask
          y = i >> shift
          rcI = i
          levelOff = x * stride + y
        }
        else {
          x = i & mask
          y = i >> shift
          rcI = (x << shift2) | y
          levelOff = x * stride + y
        }

        // get_lo_ctx inline
        mag = levels[levelOff + 1] + levels[levelOff + stride]
        let loCtx: number
        if (txClass === TxClass.TWO_D) {
          mag += levels[levelOff + stride + 1]
          const hiMag = mag
          mag += levels[levelOff + 2] + levels[levelOff + 2 * stride]
          loCtx = LO_CTX_OFFSETS[loCtxTblOff + Math.min(y, 4) * 5 + Math.min(x, 4)]
            + (mag > 512 ? 4 : (mag + 64) >> 7)
          mag = hiMag
        }
        else {
          mag += levels[levelOff + 2]
          const hiMag = mag
          mag += levels[levelOff + 3] + levels[levelOff + 4]
          loCtx = 26 + (y > 1 ? 10 : y * 5) + (mag > 512 ? 4 : (mag + 64) >> 7)
          mag = hiMag
        }
        let yOr = y
        if (txClass === TxClass.TWO_D)
          yOr = y | x

        tok = msac.decodeSymbol(cdf.data, loCdfBase + loCtx * 4, 3)
        if (tok === 3) {
          mag &= 63
          ctx = (yOr > (txClass === TxClass.TWO_D ? 1 : 0) ? 14 : 7)
            + (mag > 12 ? 6 : (mag + 1) >> 1)
          tok = this.decodeHiTok(hiCdfBase + ctx * 4)
          levels[levelOff] = (tok + (3 << 6)) & 0xFF
          cf[rcI] = (tok << 11) | rc
          rc = rcI
        }
        else {
          levels[levelOff] = tok * 0x41
          if (tok) {
            cf[rcI] = (tok << 11) | rc
            rc = rcI
          }
          else {
            cf[rcI] = 0
          }
        }
      }

      // dc
      let dcCtx = 0
      if (txClass !== TxClass.TWO_D) {
        mag = levels[1] + levels[stride] + levels[2]
        const hiMag = mag
        mag += levels[3] + levels[4]
        dcCtx = 26 + (mag > 512 ? 4 : (mag + 64) >> 7)
        mag = hiMag
      }
      dcTok = msac.decodeSymbol(cdf.data, loCdfBase + dcCtx * 4, 3)
      if (dcTok === 3) {
        if (txClass === TxClass.TWO_D)
          mag = levels[1] + levels[stride] + levels[stride + 1]
        mag &= 63
        const hiCtx = mag > 12 ? 6 : (mag + 1) >> 1
        dcTok = this.decodeHiTok(hiCdfBase + hiCtx * 4)
      }
    }
    else {
      // dc-only block
      const tokBr = msac.decodeSymbol(cdf.data, eobCdfBase, 2)
      dcTok = 1 + tokBr
      if (tokBr === 2)
        dcTok = this.decodeHiTok(hiCdfBase)
      rc = 0
    }

    if (hdr.quantization.usingQMatrix)
      throw new Error('ts-avif: quantizer matrices are not supported yet')

    // dequant
    const dqTbl = this.dq[b.segId][plane]
    const dqShift = Math.max(0, tDim.ctx - 2)
    const cfMax = 32767 // 8bpc coef clamp, see dav1d cf_max
    let culLevel: number
    let dcSignLevel: number

    if (!dcTok) {
      culLevel = 0
      dcSignLevel = 1 << 6
    }
    else {
      const dcSignCtx = this.getDcSignCtx(tDim, aArr, aOff, lArr, lOff)
      const dcSign = msac.decodeBoolAdapt(cdf.data, cdf.offset('dc_sign', chroma, dcSignCtx))
      let dcDq = dqTbl[0]
      dcSignLevel = dcSign ? 0 : 2 << 6

      if (dcTok === 15) {
        dcTok = (msac.readGolomb() + 15) & 0xFFFFF
        dcDq = ((dcDq * dcTok) & 0xFFFFFF) >> dqShift
        dcDq = Math.min(dcDq, cfMax + dcSign)
      }
      else {
        dcDq = (dcDq * dcTok) >> dqShift
      }
      culLevel = dcTok
      cf[0] = dcSign ? -dcDq : dcDq
    }

    if (rc) {
      const acDq = dqTbl[1]
      do {
        const sign = msac.decodeBoolEqui()
        const rcTok = cf[rc]
        let tok: number
        let dq: number
        if (rcTok >= (15 << 11)) {
          tok = (msac.readGolomb() + 15) & 0xFFFFF
          dq = ((acDq * tok) & 0xFFFFFF) >> dqShift
          dq = Math.min(dq, cfMax + sign)
        }
        else {
          tok = rcTok >> 11
          dq = (acDq * tok) >> dqShift
        }
        culLevel += tok
        cf[rc] = sign ? -dq : dq
        rc = rcTok & 0x3FF
      } while (rc)
    }

    return { eob, txtp, ctx: Math.min(culLevel, 63) | dcSignLevel }
  }

  private decodeHiTok(cdfOff: number): number {
    const { msac, cdf } = this
    let tokBr = msac.decodeSymbol(cdf.data, cdfOff, 3)
    let tok = 3 + tokBr
    if (tokBr === 3) {
      tokBr = msac.decodeSymbol(cdf.data, cdfOff, 3)
      tok = 6 + tokBr
      if (tokBr === 3) {
        tokBr = msac.decodeSymbol(cdf.data, cdfOff, 3)
        tok = 9 + tokBr
        if (tokBr === 3)
          tok = 12 + msac.decodeSymbol(cdf.data, cdfOff, 3)
      }
    }
    return tok
  }

  private getSkipCtx(
    tDim: TxfmInfo,
    bs: BlockSize,
    aArr: Uint8Array,
    aOff: number,
    lArr: Uint8Array,
    lOff: number,
    chroma: number,
  ): number {
    const bDimOff = bs * 4
    if (chroma) {
      const lw = BLOCK_DIMENSIONS[bDimOff + 2]
      const lh = BLOCK_DIMENSIONS[bDimOff + 3]
      const notOneBlk = lw - (lw !== 0 && this.ssHor ? 1 : 0) > tDim.lw
        || lh - (lh !== 0 && this.ssVer ? 1 : 0) > tDim.lh
      let ca = 0
      let cl = 0
      for (let i = 0; i < tDim.w; i++) {
        if (aArr[aOff + i] !== 0x40) {
          ca = 1
          break
        }
      }
      for (let i = 0; i < tDim.h; i++) {
        if (lArr[lOff + i] !== 0x40) {
          cl = 1
          break
        }
      }
      return 7 + (notOneBlk ? 3 : 0) + ca + cl
    }
    if (BLOCK_DIMENSIONS[bDimOff + 2] === tDim.lw && BLOCK_DIMENSIONS[bDimOff + 3] === tDim.lh)
      return 0
    let la = 0
    for (let i = 0; i < tDim.w; i++)
      la |= aArr[aOff + i]
    let ll = 0
    for (let i = 0; i < tDim.h; i++)
      ll |= lArr[lOff + i]
    return SKIP_CTX[Math.min(la & 0x3F, 4) * 5 + Math.min(ll & 0x3F, 4)]
  }

  private getDcSignCtx(
    tDim: TxfmInfo,
    aArr: Uint8Array,
    aOff: number,
    lArr: Uint8Array,
    lOff: number,
  ): number {
    let s = -tDim.w - tDim.h
    for (let i = 0; i < tDim.w; i++)
      s += aArr[aOff + i] >> 6
    for (let i = 0; i < tDim.h; i++)
      s += lArr[lOff + i] >> 6
    return (s !== 0 ? 1 : 0) + (s > 0 ? 1 : 0)
  }
}

/** neg_deinterleave: recover a segment id from its neighbor-relative code. */
function negDeinterleave(diff: number, ref: number, max: number): number {
  if (!ref)
    return diff
  if (ref >= max - 1)
    return max - diff - 1
  if (2 * ref < max) {
    if (diff <= 2 * ref)
      return diff & 1 ? ref + ((diff + 1) >> 1) : ref - (diff >> 1)
    return diff
  }
  if (diff <= 2 * (max - ref - 1))
    return diff & 1 ? ref + ((diff + 1) >> 1) : ref - (diff >> 1)
  return max - (diff + 1)
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

function computeDq(hdr: FrameHeader, qidx: number): number[][] {
  const q = hdr.quantization
  const clip = (v: number): number => clamp(v, 0, 255)
  return [
    [DQ_TBL_8BPC[clip(qidx + q.deltaQYDc) * 2], DQ_TBL_8BPC[qidx * 2 + 1]],
    [DQ_TBL_8BPC[clip(qidx + q.deltaQUDc) * 2], DQ_TBL_8BPC[clip(qidx + q.deltaQUAc) * 2 + 1]],
    [DQ_TBL_8BPC[clip(qidx + q.deltaQVDc) * 2], DQ_TBL_8BPC[clip(qidx + q.deltaQVAc) * 2 + 1]],
  ]
}

export { floorLog2 as ulog2 }

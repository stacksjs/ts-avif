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
import { DQ_TBL_10BPC, DQ_TBL_12BPC } from './dequant-highbd'
import { getQuantMatrix } from './quant-matrices'
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

const Y_MODE_SIZE_CONTEXT = [3, 3, 3, 3, 3, 2, 3, 3, 2, 1, 2, 2, 2, 1, 0, 1, 1, 1, 0, 0, 0, 0]

function yModeSizeContext(bs: BlockSize): number {
  return Y_MODE_SIZE_CONTEXT[bs]
}

function uvInterTxtp(tDim: TxfmInfo, luma: number): number {
  if (tDim.max === TxfmSize.TX_32X32)
    return luma === TxfmType.IDTX ? TxfmType.IDTX : TxfmType.DCT_DCT
  if (tDim.min === TxfmSize.TX_16X16
    && (luma === TxfmType.H_FLIPADST || luma === TxfmType.V_FLIPADST
      || luma === TxfmType.H_ADST || luma === TxfmType.V_ADST))
    return TxfmType.DCT_DCT
  return luma
}

function binaryCountContext(first: number, second: number): number {
  return first === second ? 1 : first < second ? 0 : 2
}

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
  palettes: [Uint16Array, Uint16Array, Uint16Array]
  palIdxY: Uint8Array | null
  palIdxUv: Uint8Array | null
  /** Motion vector in AV1's 1/8-pixel units (integer-valued for intrabc). */
  mvX: number
  mvY: number
  ref0: number
  ref1: number
  mvX2: number
  mvY2: number
  newMv: number
  txSplit0: number
  txSplit1: number
  filterH: number
  filterV: number
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
  palSzUv: Uint8Array
  palettes: [Uint16Array, Uint16Array, Uint16Array]
  mvX: Int16Array
  mvY: Int16Array
  ref0: Int8Array
  ref1: Int8Array
  compType: Uint8Array

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
    this.palSzUv = new Uint8Array(n4)
    this.palettes = [new Uint16Array(n4 * 8), new Uint16Array(n4 * 8), new Uint16Array(n4 * 8)]
    this.mvX = new Int16Array(n4)
    this.mvY = new Int16Array(n4)
    this.ref0 = new Int8Array(n4)
    this.ref1 = new Int8Array(n4)
    this.compType = new Uint8Array(n4)
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
    this.palSzUv.fill(0)
    this.mvX.fill(0)
    this.mvY.fill(0)
    this.ref0.fill(-1)
    this.ref1.fill(-1)
    this.compType.fill(0)
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
  readonly frameIsIntra: boolean

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

  /** Independently adapted vertical/horizontal MV component CDFs. */
  mvCdf: [Uint16Array, Uint16Array]

  /** Per-4x4 segment id map for the whole frame (spatial prediction). */
  segMap: Uint8Array | null = null

  /** Current-frame inter metadata used to build spatial MV candidates. */
  interRef = new Int8Array(0)
  interMvX = new Int16Array(0)
  interMvY = new Int16Array(0)
  interNewMv = new Uint8Array(0)
  interBs = new Uint8Array(0)
  txtpMap = new Uint8Array(32 * 32)

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
    this.msac = new SymbolDecoder(tileData, hdr.disableCdfUpdate)
    this.cdf = cdf
    this.recon = recon
    this.bw4 = hdr.miCols
    this.bh4 = hdr.miRows
    this.ssVer = seq.subsamplingY
    this.ssHor = seq.subsamplingX
    this.layout = seq.monochrome ? 0 : seq.subsamplingX === 0 ? 3 : seq.subsamplingY === 0 ? 2 : 1
    this.frameIsIntra = hdr.frameType === 0 || hdr.frameType === 2
    this.colEnd = this.bw4
    this.rowEnd = this.bh4
    const aligned = (this.bw4 + 31) & ~31
    this.a = new BlockContext(aligned)
    this.l = new BlockContext(32)
    this.a.reset(this.frameIsIntra)

    // The packed default context stores one MV component template; the two
    // components adapt independently once tile decoding begins.
    const mvBase = cdf.offset('mv_classes')
    const mvTemplate = cdf.data.slice(mvBase, cdf.offset('mv_joint'))
    this.mvCdf = [mvTemplate.slice(), mvTemplate.slice()]

    this.frameDq = []
    for (let seg = 0; seg < 8; seg++)
      this.frameDq.push(computeDq(seq.bitDepth, hdr, hdr.segQIndex[seg]))
    this.dq = this.frameDq
    this.lastQIdx = hdr.quantization.baseQIdx

    const n4 = this.bw4 * this.bh4
    this.interRef = new Int8Array(n4)
    this.interRef.fill(-1)
    this.interMvX = new Int16Array(n4)
    this.interMvY = new Int16Array(n4)
    this.interNewMv = new Uint8Array(n4)
    this.interBs = new Uint8Array(n4)

    if (hdr.segmentation.enabled)
      this.segMap = new Uint8Array(this.bw4 * this.bh4)
  }

  /** Decode every superblock of the (single-tile-column) tile. */
  decodeTile(sbRoot: EdgeNode): void {
    const sbStep = this.seq.use128x128Superblock ? 32 : 16
    const rootBl = this.seq.use128x128Superblock ? BlockLevel.BL_128X128 : BlockLevel.BL_64X64
    for (this.by = this.rowStart; this.by < this.rowEnd; this.by += sbStep) {
      this.l.reset(this.frameIsIntra)
      for (this.bx = this.colStart; this.bx < this.colEnd; this.bx += sbStep) {
        this.cdefIdx[0] = this.cdefIdx[1] = this.cdefIdx[2] = this.cdefIdx[3] = -1
        this.restoration?.readForSuperblock(this.msac, this.cdf, this.bx, this.by)
        this.decodeSb(rootBl, sbRoot)
        if (this.cdefData) {
          const quadrants = this.seq.use128x128Superblock ? 4 : 1
          const baseX = this.bx >> 4
          const baseY = this.by >> 4
          for (let i = 0; i < quadrants; i++) {
            if (this.cdefIdx[i] < 0)
              continue
            const x = baseX + (i & 1)
            const y = baseY + (i >> 1)
            if (x < this.cdefData.sb64w && y < ((this.bh4 + 15) >> 4))
              this.cdefData.idx[y * this.cdefData.sb64w + x] = this.cdefIdx[i]
          }
        }
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
      palettes: [new Uint16Array(8), new Uint16Array(8), new Uint16Array(8)],
      palIdxY: null,
      palIdxUv: null,
      mvX: 0,
      mvY: 0,
      ref0: -1,
      ref1: -1,
      mvX2: 0,
      mvY2: 0,
      newMv: 0,
      txSplit0: 0,
      txSplit1: 0,
      filterH: hdr.interpolationFilter,
      filterV: hdr.interpolationFilter,
      tx: TxfmSize.TX_4X4,
      uvtx: TxfmSize.TX_4X4,
    }

    // segment_id (pre-skip). The seg map is frame-absolute, so use this.by.
    const seg = hdr.segmentation
    if (seg.enabled && seg.updateMap && seg.segIdPreSkip)
      b.segId = this.readSegId(this.bx, this.by, w4, h4, haveTop, haveLeft, false)

    if (!this.frameIsIntra && hdr.skipModePresent && Math.min(bw4, bh4) > 1) {
      const smctx = this.a.skipMode[bx4] + this.l.skipMode[by4]
      b.skipMode = msac.decodeBoolAdapt(cdf.data, cdf.offset('skip_mode', smctx))
    }

    // skip
    {
      if (b.skipMode) {
        b.skip = 1
      }
      else {
        const sctx = this.a.skip[bx4] + this.l.skip[by4]
        b.skip = msac.decodeBoolAdapt(cdf.data, cdf.offset('skip', sctx))
      }
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
            this.dq.push(computeDq(this.seq.bitDepth, hdr, this.lastQIdx))
        }
      }
    }

    if (b.skipMode) {
      b.intra = 0
    }
    else if (!this.frameIsIntra) {
      let ictx: number
      if (haveLeft && haveTop) {
        const sum = this.l.intra[by4] + this.a.intra[bx4]
        ictx = sum + (sum === 2 ? 1 : 0)
      }
      else if (haveLeft) {
        ictx = this.l.intra[by4] * 2
      }
      else {
        ictx = haveTop ? this.a.intra[bx4] * 2 : 0
      }
      b.intra = 1 - msac.decodeBoolAdapt(cdf.data, cdf.offset('intra', ictx))
    }
    else {
      b.intra = hdr.allowIntrabc
        ? 1 - msac.decodeBoolAdapt(cdf.data, cdf.offset('intrabc'))
        : 1
    }
    if (!b.intra) {
      if (this.frameIsIntra)
        this.decodeIntrabcBlock(bs, b, bw4, bh4, w4, h4, cbw4, cbh4, hasChroma, bx4, by4)
      else if (b.skipMode)
        this.decodeSkipModeBlock(bs, b, bw4, bh4, w4, h4, cbw4, cbh4, hasChroma, bx4, by4)
      else
        this.decodeInterBlock(bs, b, bw4, bh4, w4, h4, cbw4, cbh4, hasChroma, bx4, by4, haveTop, haveLeft)
      return
    }

    // y mode (key-frame contexts from neighbors)
    const ctxA = INTRA_MODE_CONTEXT[this.a.mode[bx4]]
    const ctxL = INTRA_MODE_CONTEXT[this.l.mode[by4]]
    b.yMode = this.frameIsIntra
      ? msac.decodeSymbol(cdf.data, cdf.offset('kfym', ctxA, ctxL), 12)
      : msac.decodeSymbol(cdf.data, cdf.offset('y_mode', yModeSizeContext(bs)), 12)

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
          this.readPalettePlane(b, 0, szCtx, bx4, by4)
      }
      if (hasChroma && b.uvMode === IntraPredMode.DC_PRED) {
        const palCtx = b.palSz[0] > 0 ? 1 : 0
        if (msac.decodeBoolAdapt(cdf.data, cdf.offset('pal_uv', palCtx))) {
          this.readPalettePlane(b, 1, szCtx, bx4, by4)
          this.readPaletteV(b)
        }
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

    if (b.palSz[0])
      b.palIdxY = this.readPaletteIndices(b.palSz[0], 0, w4, h4, bw4, bh4)
    if (b.palSz[1])
      b.palIdxUv = this.readPaletteIndices(b.palSz[1], 1, (w4 + this.ssHor) >> this.ssHor, (h4 + this.ssVer) >> this.ssVer, cbw4, cbh4)

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
      this.a.palSzUv[o] = b.palSz[1]
      for (let pl = 0; pl < 3; pl++)
        this.a.palettes[pl].set(b.palettes[pl], o * 8)
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
      this.l.palSzUv[o] = b.palSz[1]
      for (let pl = 0; pl < 3; pl++)
        this.l.palettes[pl].set(b.palettes[pl], o * 8)
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

  /** Decode the compound zero/nearest predictor implied by skip_mode. */
  private decodeSkipModeBlock(
    bs: BlockSize,
    b: Av1Block,
    bw4: number,
    bh4: number,
    w4: number,
    h4: number,
    cbw4: number,
    cbh4: number,
    hasChroma: boolean,
    bx4: number,
    by4: number,
  ): void {
    b.ref0 = this.hdr.skipModeRefs[0]
    b.ref1 = this.hdr.skipModeRefs[1]
    // A frame with no spatial/temporal MV candidate uses the zero candidate.
    // Candidate-stack refinement is added by the general inter path; this is
    // sufficient for the normative skip-mode bootstrap case.
    b.mvX = b.mvY = b.mvX2 = b.mvY2 = 0
    b.yMode = IntraPredMode.DC_PRED
    b.uvMode = IntraPredMode.DC_PRED
    b.tx = MAX_TXFM_SIZE_FOR_BS[bs * 4]
    b.uvtx = MAX_TXFM_SIZE_FOR_BS[bs * 4 + this.layout]

    this.reconBIntra(bs, b, w4, h4, cbw4, cbh4, hasChroma, 0)

    const tDim = TXFM_INFO[b.tx]
    for (let i = 0; i < bw4; i++) {
      const o = bx4 + i
      this.a.txIntra[o] = BLOCK_DIMENSIONS[bs * 4 + 2]
      this.a.tx[o] = tDim.lw
      this.a.mode[o] = 0
      this.a.palSz[o] = 0
      this.a.palSzUv[o] = 0
      this.a.segPred[o] = 0
      this.a.skipMode[o] = 1
      this.a.intra[o] = 0
      this.a.skip[o] = 1
      this.a.mvX[o] = 0
      this.a.mvY[o] = 0
    }
    for (let i = 0; i < bh4; i++) {
      const o = by4 + i
      this.l.txIntra[o] = BLOCK_DIMENSIONS[bs * 4 + 3]
      this.l.tx[o] = tDim.lh
      this.l.mode[o] = 0
      this.l.palSz[o] = 0
      this.l.palSzUv[o] = 0
      this.l.segPred[o] = 0
      this.l.skipMode[o] = 1
      this.l.intra[o] = 0
      this.l.skip[o] = 1
      this.l.mvX[o] = 0
      this.l.mvY[o] = 0
    }
    if (hasChroma) {
      const cbx4 = bx4 >> this.ssHor
      const cby4 = by4 >> this.ssVer
      this.a.uvmode.fill(IntraPredMode.DC_PRED, cbx4, cbx4 + cbw4)
      this.l.uvmode.fill(IntraPredMode.DC_PRED, cby4, cby4 + cbh4)
    }
  }

  /** Single-reference translational inter prediction. */
  private decodeInterBlock(
    bs: BlockSize,
    b: Av1Block,
    bw4: number,
    bh4: number,
    w4: number,
    h4: number,
    cbw4: number,
    cbh4: number,
    hasChroma: boolean,
    bx4: number,
    by4: number,
    haveTop: boolean,
    haveLeft: boolean,
  ): void {
    if (this.hdr.referenceSelect && Math.min(bw4, bh4) > 1) {
      const comp = this.msac.decodeBoolAdapt(
        this.cdf.data,
        this.cdf.offset('comp', this.compContext(bx4, by4, haveTop, haveLeft)),
      )
      if (comp)
        throw new Error('ts-avif: coded compound inter blocks are not implemented')
    }

    b.ref0 = this.readSingleReference(bx4, by4, haveTop, haveLeft)
    b.ref1 = -1
    const { stack, count: candidateCount, context: modeContext } = this.buildMvCandidates(
      b.ref0,
      bs,
      bw4,
      bh4,
      bx4,
      by4,
      haveTop,
      haveLeft,
    )
    let candidateIndex = 0
    const newMvMode = this.msac.decodeBoolAdapt(this.cdf.data, this.cdf.offset('newmv_mode', modeContext & 7))
    if (newMvMode) {
      if (!this.msac.decodeBoolAdapt(this.cdf.data, this.cdf.offset('globalmv_mode', (modeContext >> 3) & 1))) {
        b.mvX = b.mvY = 0
      }
      else if (this.msac.decodeBoolAdapt(this.cdf.data, this.cdf.offset('refmv_mode', (modeContext >> 4) & 15))) {
        candidateIndex = 1
        if (candidateCount > 2) {
          candidateIndex += this.msac.decodeBoolAdapt(
            this.cdf.data,
            this.cdf.offset('drl_bit', this.drlContext(stack, 1)),
          )
          if (candidateIndex === 2 && candidateCount > 3) {
            candidateIndex += this.msac.decodeBoolAdapt(
              this.cdf.data,
              this.cdf.offset('drl_bit', this.drlContext(stack, 2)),
            )
          }
        }
        const mv = stack[candidateIndex] ?? { x: 0, y: 0 }
        b.mvX = mv.x
        b.mvY = mv.y
        this.fixMvPrecision(b)
      }
      else {
        const mv = stack[0] ?? { x: 0, y: 0 }
        b.mvX = mv.x
        b.mvY = mv.y
        this.fixMvPrecision(b)
      }
    }
    else {
      b.newMv = 1
      if (candidateCount > 1) {
        candidateIndex += this.msac.decodeBoolAdapt(
          this.cdf.data,
          this.cdf.offset('drl_bit', this.drlContext(stack, 0)),
        )
        if (candidateIndex === 1 && candidateCount > 2) {
          candidateIndex += this.msac.decodeBoolAdapt(
            this.cdf.data,
            this.cdf.offset('drl_bit', this.drlContext(stack, 1)),
          )
        }
      }
      const mv = stack[candidateIndex] ?? { x: 0, y: 0 }
      b.mvX = mv.x
      b.mvY = mv.y
      this.fixMvPrecision(b)
      this.readMvResidual(b, this.hdr.forceIntegerMv ? -1 : this.hdr.allowHighPrecisionMv ? 1 : 0)
    }

    if (this.hdr.interpolationFilter === 4 && (b.mvX & 7 || b.mvY & 7))
      throw new Error('ts-avif: switchable sub-pixel inter filters are not implemented')

    b.yMode = IntraPredMode.DC_PRED
    b.uvMode = IntraPredMode.DC_PRED
    this.readVarTxTree(bs, b, bw4, bh4, bx4, by4)
    this.reconBInter(bs, b, w4, h4, cbw4, cbh4, hasChroma)
    this.updateInterContexts(bs, b, bw4, bh4, cbw4, cbh4, hasChroma, bx4, by4)
  }

  private readSingleReference(bx4: number, by4: number, haveTop: boolean, haveLeft: boolean): number {
    const refs = this.neighborReferences(bx4, by4, haveTop, haveLeft)
    const ctx1 = binaryCountContext(
      refs.filter(ref => ref < 4).length,
      refs.filter(ref => ref >= 4).length,
    )
    if (this.msac.decodeBoolAdapt(this.cdf.data, this.cdf.offset('ref', 0, ctx1))) {
      const backward = refs.filter(ref => ref >= 4)
      const ctx2 = binaryCountContext(
        backward.filter(ref => ref < 6).length,
        backward.filter(ref => ref === 6).length,
      )
      if (this.msac.decodeBoolAdapt(this.cdf.data, this.cdf.offset('ref', 1, ctx2)))
        return 6
      const ctx3 = binaryCountContext(
        backward.filter(ref => ref === 4).length,
        backward.filter(ref => ref === 5).length,
      )
      return 4 + this.msac.decodeBoolAdapt(this.cdf.data, this.cdf.offset('ref', 5, ctx3))
    }
    const forward = refs.filter(ref => ref < 4)
    const ctx2 = binaryCountContext(
      forward.filter(ref => ref < 2).length,
      forward.filter(ref => ref >= 2).length,
    )
    if (this.msac.decodeBoolAdapt(this.cdf.data, this.cdf.offset('ref', 2, ctx2))) {
      const ctx3 = binaryCountContext(
        forward.filter(ref => ref === 2).length,
        forward.filter(ref => ref === 3).length,
      )
      return 2 + this.msac.decodeBoolAdapt(this.cdf.data, this.cdf.offset('ref', 4, ctx3))
    }
    const ctx3 = binaryCountContext(
      forward.filter(ref => ref === 0).length,
      forward.filter(ref => ref === 1).length,
    )
    return this.msac.decodeBoolAdapt(this.cdf.data, this.cdf.offset('ref', 3, ctx3))
  }

  private neighborReferences(
    bx4: number,
    by4: number,
    haveTop: boolean,
    haveLeft: boolean,
  ): number[] {
    const refs: number[] = []
    const append = (ctx: BlockContext, off: number): void => {
      if (ctx.intra[off]) return
      refs.push(ctx.ref0[off])
      if (ctx.compType[off]) refs.push(ctx.ref1[off])
    }
    if (haveTop) append(this.a, bx4)
    if (haveLeft) append(this.l, by4)
    return refs
  }

  private compContext(bx4: number, by4: number, haveTop: boolean, haveLeft: boolean): number {
    if (!haveTop && !haveLeft) return 1
    const aComp = haveTop && this.a.compType[bx4] !== 0
    const lComp = haveLeft && this.l.compType[by4] !== 0
    if (aComp && lComp) return 4
    if (aComp) return haveLeft ? 2 + (this.l.ref0[by4] >= 4 ? 1 : 0) : 3
    if (lComp) return haveTop ? 2 + (this.a.ref0[bx4] >= 4 ? 1 : 0) : 3
    if (haveTop && haveLeft) return (this.a.ref0[bx4] >= 4 ? 1 : 0) ^ (this.l.ref0[by4] >= 4 ? 1 : 0)
    return (haveTop ? this.a.ref0[bx4] : this.l.ref0[by4]) >= 4 ? 1 : 0
  }

  private buildMvCandidates(
    ref: number,
    _bs: BlockSize,
    bw4: number,
    bh4: number,
    bx4: number,
    by4: number,
    haveTop: boolean,
    haveLeft: boolean,
  ): { stack: Array<{ x: number, y: number, weight: number }>, count: number, context: number } {
    const stack: Array<{ x: number, y: number, weight: number }> = []
    let rowMatch = 0
    let colMatch = 0
    let haveNewMv = 0
    const add = (x: number, y: number, weight: number, isNew: number): void => {
      const existing = stack.find(candidate => candidate.x === x && candidate.y === y)
      if (existing) existing.weight += weight
      else stack.push({ x, y, weight })
      haveNewMv |= isNew
    }
    if (haveTop) {
      const off = (by4 - 1) * this.bw4 + bx4
      if (this.interRef[off] === ref) {
        rowMatch = 1
        add(this.interMvX[off], this.interMvY[off], Math.min(bw4, 16) * 4 + 640, this.interNewMv[off])
      }
    }
    if (haveLeft) {
      const off = by4 * this.bw4 + bx4 - 1
      if (this.interRef[off] === ref) {
        colMatch = 1
        add(this.interMvX[off], this.interMvY[off], Math.min(bh4, 16) * 4 + 640, this.interNewMv[off])
      }
    }
    // A decoded top-right block participates in the nearest row scan. The
    // frame map naturally excludes unavailable top-right regions because
    // their reference entry is still -1 at this point in partition order.
    if (haveTop && Math.max(bw4, bh4) <= 16 && bx4 + bw4 < this.bw4) {
      const off = (by4 - 1) * this.bw4 + bx4 + bw4
      if (this.interRef[off] === ref) {
        rowMatch = 1
        add(this.interMvX[off], this.interMvY[off], 4 + 640, this.interNewMv[off])
      }
    }
    const nearestMatch = rowMatch + colMatch
    let anyRowMatch = rowMatch
    let anyColMatch = colMatch
    const addSecondary = (x: number, y: number, weight: number, row: boolean): void => {
      if (x < 0 || y < 0 || x >= this.bw4 || y >= this.bh4) return
      const off = y * this.bw4 + x
      if (this.interRef[off] !== ref) return
      if (row) anyRowMatch = 1
      else anyColMatch = 1
      // Secondary candidates do not contribute to the NEWMV nearest-match
      // flag, but they remain ordered after the 640-weight nearest group.
      add(this.interMvX[off], this.interMvY[off], weight, 0)
    }
    if (haveTop && haveLeft)
      addSecondary(bx4 - 1, by4 - 1, 4, true)
    for (const distance of [3, 5]) {
      if (by4 >= distance)
        addSecondary(bx4 | 1, by4 - distance, Math.max(2, Math.min(bw4, 16) * 2), true)
      if (bx4 >= distance)
        addSecondary(bx4 - distance, by4 | 1, Math.max(2, Math.min(bh4, 16) * 2), false)
    }
    const refMatchCount = anyRowMatch + anyColMatch
    let refMvContext: number
    let newMvContext: number
    if (nearestMatch === 0) {
      refMvContext = Math.min(2, refMatchCount)
      newMvContext = refMatchCount > 0 ? 1 : 0
    }
    else if (nearestMatch === 1) {
      refMvContext = Math.min(refMatchCount * 3, 4)
      newMvContext = 3 - haveNewMv
    }
    else {
      refMvContext = 5
      newMvContext = 5 - haveNewMv
    }
    stack.sort((a, c) => c.weight - a.weight)
    const count = stack.length
    while (stack.length < 2) stack.push({ x: 0, y: 0, weight: 2 })
    const globalMvContext = this.hdr.useRefFrameMvs ? 1 : 0
    return {
      stack,
      count,
      context: (refMvContext << 4) | (globalMvContext << 3) | newMvContext,
    }
  }

  private drlContext(stack: Array<{ weight: number }>, index: number): number {
    if (stack[index].weight >= 640)
      return stack[index + 1].weight < 640 ? 1 : 0
    return stack[index + 1].weight < 640 ? 2 : 0
  }

  private fixMvPrecision(b: Av1Block): void {
    if (this.hdr.forceIntegerMv) {
      b.mvX = (b.mvX - (b.mvX >> 15) + 3) & ~7
      b.mvY = (b.mvY - (b.mvY >> 15) + 3) & ~7
    }
    else if (!this.hdr.allowHighPrecisionMv) {
      b.mvX = (b.mvX - (b.mvX >> 15)) & ~1
      b.mvY = (b.mvY - (b.mvY >> 15)) & ~1
    }
  }

  private updateInterContexts(
    bs: BlockSize,
    b: Av1Block,
    bw4: number,
    bh4: number,
    cbw4: number,
    cbh4: number,
    hasChroma: boolean,
    bx4: number,
    by4: number,
  ): void {
    for (let i = 0; i < bw4; i++) {
      const o = bx4 + i
      this.a.txIntra[o] = BLOCK_DIMENSIONS[bs * 4 + 2]
      this.a.mode[o] = 0
      this.a.palSz[o] = this.a.palSzUv[o] = 0
      this.a.segPred[o] = 0
      this.a.skipMode[o] = b.skipMode
      this.a.intra[o] = 0
      this.a.skip[o] = b.skip
      this.a.mvX[o] = b.mvX
      this.a.mvY[o] = b.mvY
      this.a.ref0[o] = b.ref0
      this.a.ref1[o] = b.ref1
      this.a.compType[o] = b.ref1 >= 0 ? 1 : 0
    }
    for (let i = 0; i < bh4; i++) {
      const o = by4 + i
      this.l.txIntra[o] = BLOCK_DIMENSIONS[bs * 4 + 3]
      this.l.mode[o] = 0
      this.l.palSz[o] = this.l.palSzUv[o] = 0
      this.l.segPred[o] = 0
      this.l.skipMode[o] = b.skipMode
      this.l.intra[o] = 0
      this.l.skip[o] = b.skip
      this.l.mvX[o] = b.mvX
      this.l.mvY[o] = b.mvY
      this.l.ref0[o] = b.ref0
      this.l.ref1[o] = b.ref1
      this.l.compType[o] = b.ref1 >= 0 ? 1 : 0
    }
    if (hasChroma) {
      this.a.uvmode.fill(IntraPredMode.DC_PRED, bx4 >> this.ssHor, (bx4 >> this.ssHor) + cbw4)
      this.l.uvmode.fill(IntraPredMode.DC_PRED, by4 >> this.ssVer, (by4 >> this.ssVer) + cbh4)
    }
    const width = Math.min(bw4, this.bw4 - this.bx)
    const height = Math.min(bh4, this.bh4 - this.by)
    for (let y = 0; y < height; y++) {
      const off = (this.by + y) * this.bw4 + this.bx
      this.interRef.fill(b.ref0, off, off + width)
      this.interMvX.fill(b.mvX, off, off + width)
      this.interMvY.fill(b.mvY, off, off + width)
      this.interNewMv.fill(b.newMv, off, off + width)
      this.interBs.fill(bs, off, off + width)
    }
  }

  private readVarTxTree(
    bs: BlockSize,
    b: Av1Block,
    bw4: number,
    bh4: number,
    bx4: number,
    by4: number,
  ): void {
    b.txSplit0 = b.txSplit1 = 0
    b.tx = MAX_TXFM_SIZE_FOR_BS[bs * 4]
    if (!b.skip && (this.hdr.losslessArray[b.segId] || b.tx === TxfmSize.TX_4X4)) {
      b.tx = b.uvtx = TxfmSize.TX_4X4
      if (this.hdr.txMode === 2) {
        this.a.tx.fill(0, bx4, bx4 + bw4)
        this.l.tx.fill(0, by4, by4 + bh4)
      }
      return
    }
    b.uvtx = MAX_TXFM_SIZE_FOR_BS[bs * 4 + this.layout]
    if (this.hdr.txMode !== 2 || b.skip) {
      if (this.hdr.txMode === 2) {
        this.a.tx.fill(BLOCK_DIMENSIONS[bs * 4 + 2], bx4, bx4 + bw4)
        this.l.tx.fill(BLOCK_DIMENSIONS[bs * 4 + 3], by4, by4 + bh4)
      }
      return
    }

    const maxTx = TXFM_INFO[b.tx]
    let y = 0
    let yOff = 0
    for (y = 0, yOff = 0; y < bh4; y += maxTx.h, yOff++) {
      let x = 0
      let xOff = 0
      for (x = 0, xOff = 0; x < bw4; x += maxTx.w, xOff++) {
        this.readTxTree(b.tx, 0, b, xOff, yOff)
        this.bx += maxTx.w
      }
      this.bx -= x
      this.by += maxTx.h
    }
    this.by -= y
  }

  private readTxTree(from: number, depth: number, b: Av1Block, xOff: number, yOff: number): void {
    const tDim = TXFM_INFO[from]
    const bx4 = this.bx
    const by4 = this.by & 31
    let split = 0
    if (depth < 2 && from > TxfmSize.TX_4X4) {
      const category = 2 * (TxfmSize.TX_64X64 - tDim.max) - depth
      const context = (this.a.tx[bx4] < tDim.lw ? 1 : 0)
        + (this.l.tx[by4] < tDim.lh ? 1 : 0)
      split = this.msac.decodeBoolAdapt(this.cdf.data, this.cdf.offset('txpart', category, context))
      if (split) {
        if (depth === 0) b.txSplit0 |= 1 << (yOff * 4 + xOff)
        else b.txSplit1 |= 1 << (yOff * 4 + xOff)
      }
    }
    if (split && tDim.max > TxfmSize.TX_8X8) {
      const sub = tDim.sub
      const subDim = TXFM_INFO[sub]
      this.readTxTree(sub, depth + 1, b, xOff * 2, yOff * 2)
      this.bx += subDim.w
      if (tDim.lw >= tDim.lh && this.bx < this.bw4)
        this.readTxTree(sub, depth + 1, b, xOff * 2 + 1, yOff * 2)
      this.bx -= subDim.w
      this.by += subDim.h
      if (tDim.lh >= tDim.lw && this.by < this.bh4) {
        this.readTxTree(sub, depth + 1, b, xOff * 2, yOff * 2 + 1)
        this.bx += subDim.w
        if (tDim.lw >= tDim.lh && this.bx < this.bw4)
          this.readTxTree(sub, depth + 1, b, xOff * 2 + 1, yOff * 2 + 1)
        this.bx -= subDim.w
      }
      this.by -= subDim.h
    }
    else {
      this.a.tx.fill(split ? 0 : tDim.lw, bx4, bx4 + tDim.w)
      this.l.tx.fill(split ? 0 : tDim.lh, by4, by4 + tDim.h)
    }
  }

  private reconBInter(
    bs: BlockSize,
    b: Av1Block,
    w4: number,
    h4: number,
    cbw4: number,
    cbh4: number,
    hasChroma: boolean,
  ): void {
    const bx4 = this.bx
    const by4 = this.by & 31
    const ssHor = this.ssHor
    const ssVer = this.ssVer
    const cbx4 = bx4 >> ssHor
    const cby4 = by4 >> ssVer
    const maxTx = TXFM_INFO[b.tx]
    const uvTx = TXFM_INFO[b.uvtx]
    const cw4 = (w4 + ssHor) >> ssHor
    const ch4 = (h4 + ssVer) >> ssVer

    this.recon?.startBlock(bs, b, this)
    if (b.skip) {
      this.a.lcoef.fill(0x40, bx4, bx4 + BLOCK_DIMENSIONS[bs * 4])
      this.l.lcoef.fill(0x40, by4, by4 + BLOCK_DIMENSIONS[bs * 4 + 1])
      if (hasChroma) {
        for (let pl = 0; pl < 2; pl++) {
          this.a.ccoef[pl].fill(0x40, cbx4, cbx4 + cbw4)
          this.l.ccoef[pl].fill(0x40, cby4, cby4 + cbh4)
        }
      }
      return
    }

    for (let initY = 0; initY < h4; initY += 16) {
      for (let initX = 0; initX < w4; initX += 16) {
        let y = initY
        let yOff = initY ? 1 : 0
        for (y = initY, this.by += initY; y < Math.min(h4, initY + 16); y += maxTx.h, yOff++) {
          let x = initX
          let xOff = initX ? 1 : 0
          for (x = initX, this.bx += initX; x < Math.min(w4, initX + 16); x += maxTx.w, xOff++) {
            this.reconInterTxTree(bs, b, b.tx, 0, xOff, yOff)
            this.bx += maxTx.w
          }
          this.bx -= x
          this.by += maxTx.h
        }
        this.by -= y

        if (!hasChroma) continue
        const subCh4 = Math.min(ch4, (initY + 16) >> ssVer)
        const subCw4 = Math.min(cw4, (initX + 16) >> ssHor)
        for (let pl = 0; pl < 2; pl++) {
          for (y = initY >> ssVer, this.by += initY; y < subCh4;
            y += uvTx.h, this.by += uvTx.h << ssVer) {
            let x = initX >> ssHor
            for (x = initX >> ssHor, this.bx += initX; x < subCw4;
              x += uvTx.w, this.bx += uvTx.w << ssHor) {
              this.cf.fill(0)
              const { eob, txtp, ctx } = this.decodeCoefs(
                this.a.ccoef[pl],
                cbx4 + x,
                this.l.ccoef[pl],
                cby4 + y,
                b.uvtx,
                bs,
                b,
                0,
                1 + pl,
                this.txtpMap[((by4 + (y << ssVer)) & 31) * 32 + bx4 + (x << ssHor)],
              )
              const ctw = Math.min(uvTx.w, (this.bw4 - this.bx + ssHor) >> ssHor)
              const cth = Math.min(uvTx.h, (this.bh4 - this.by + ssVer) >> ssVer)
              this.a.ccoef[pl].fill(ctx, cbx4 + x, cbx4 + x + ctw)
              this.l.ccoef[pl].fill(ctx, cby4 + y, cby4 + y + cth)
              this.recon?.reconTxBlock(1 + pl, this.bx >> ssHor, this.by >> ssVer, b.uvtx, txtp, eob, this.cf, b, this, 0)
            }
            this.bx -= x << ssHor
          }
          this.by -= y << ssVer
        }
      }
    }
  }

  private reconInterTxTree(
    bs: BlockSize,
    b: Av1Block,
    tx: number,
    depth: number,
    xOff: number,
    yOff: number,
  ): void {
    const tDim = TXFM_INFO[tx]
    const mask = depth === 0 ? b.txSplit0 : b.txSplit1
    if (depth < 2 && (mask & (1 << (yOff * 4 + xOff)))) {
      const sub = tDim.sub
      const subDim = TXFM_INFO[sub]
      this.reconInterTxTree(bs, b, sub, depth + 1, xOff * 2, yOff * 2)
      this.bx += subDim.w
      if (tDim.lw >= tDim.lh && this.bx < this.bw4)
        this.reconInterTxTree(bs, b, sub, depth + 1, xOff * 2 + 1, yOff * 2)
      this.bx -= subDim.w
      this.by += subDim.h
      if (tDim.lh >= tDim.lw && this.by < this.bh4) {
        this.reconInterTxTree(bs, b, sub, depth + 1, xOff * 2, yOff * 2 + 1)
        this.bx += subDim.w
        if (tDim.lw >= tDim.lh && this.bx < this.bw4)
          this.reconInterTxTree(bs, b, sub, depth + 1, xOff * 2 + 1, yOff * 2 + 1)
        this.bx -= subDim.w
      }
      this.by -= subDim.h
      return
    }

    const x = this.bx & 31
    const y = this.by & 31
    this.cf.fill(0)
    const { eob, txtp, ctx } = this.decodeCoefs(
      this.a.lcoef,
      this.bx,
      this.l.lcoef,
      y,
      tx,
      bs,
      b,
      0,
      0,
    )
    this.a.lcoef.fill(ctx, this.bx, this.bx + Math.min(tDim.w, this.bw4 - this.bx))
    this.l.lcoef.fill(ctx, y, y + Math.min(tDim.h, this.bh4 - this.by))
    for (let row = 0; row < tDim.h; row++)
      this.txtpMap.fill(txtp, ((y + row) & 31) * 32 + x, ((y + row) & 31) * 32 + x + tDim.w)
    this.recon?.reconTxBlock(0, this.bx, this.by, tx, txtp, eob, this.cf, b, this, 0)
  }

  /** Decode and reconstruct an intra-block-copy block in an intra frame. */
  private decodeIntrabcBlock(
    bs: BlockSize,
    b: Av1Block,
    bw4: number,
    bh4: number,
    w4: number,
    h4: number,
    cbw4: number,
    cbh4: number,
    hasChroma: boolean,
    bx4: number,
    by4: number,
  ): void {
    // AV1 derives the predictor from the nearest intrabc reference. Keep the
    // two spatial candidates locally; a missing stack uses the normative
    // superblock-relative fallback.
    if (this.bx > this.colStart && this.l.intra[by4] === 0) {
      b.mvX = this.l.mvX[by4]
      b.mvY = this.l.mvY[by4]
    }
    else if (this.by > this.rowStart && this.a.intra[bx4] === 0) {
      b.mvX = this.a.mvX[bx4]
      b.mvY = this.a.mvY[bx4]
    }
    else if (this.by - (this.seq.use128x128Superblock ? 32 : 16) < this.rowStart) {
      b.mvX = -(this.seq.use128x128Superblock ? 4096 : 2048) - 2048
      b.mvY = 0
    }
    else {
      b.mvX = 0
      b.mvY = -(this.seq.use128x128Superblock ? 1024 : 512)
    }
    this.readMvResidual(b)
    this.clipIntrabcMv(b, bw4, bh4, hasChroma)

    b.yMode = IntraPredMode.DC_PRED
    b.uvMode = IntraPredMode.DC_PRED
    this.readVarTxTree(bs, b, bw4, bh4, bx4, by4)
    this.reconBInter(bs, b, w4, h4, cbw4, cbh4, hasChroma)
    this.updateInterContexts(bs, b, bw4, bh4, cbw4, cbh4, hasChroma, bx4, by4)
  }

  private readMvResidual(b: Av1Block, precision = -1): void {
    // MVJoint values are 0, horizontal, vertical, horizontal+vertical.
    const joint = this.msac.decodeSymbol(this.cdf.data, this.cdf.offset('mv_joint'), 3)
    if (joint & 2)
      b.mvY += this.readMvComponent(0, precision)
    if (joint & 1)
      b.mvX += this.readMvComponent(1, precision)
  }

  private readMvComponent(component: 0 | 1, precision: number): number {
    const cdf = this.mvCdf[component]
    const sign = this.msac.decodeBoolAdapt(cdf, 16)
    const mvClass = this.msac.decodeSymbol(cdf, 0, 10)
    let up: number
    if (mvClass === 0) {
      up = this.msac.decodeBoolAdapt(cdf, 18)
      let fp = 3
      let hp = 1
      if (precision >= 0) {
        fp = this.msac.decodeSymbol(cdf, 20 + up * 4, 3)
        if (precision > 0) hp = this.msac.decodeBoolAdapt(cdf, 28)
      }
      const diff = (up << 3 | fp << 1 | hp) + 1
      return sign ? -diff : diff
    }
    up = 1 << mvClass
    for (let bit = 0; bit < mvClass; bit++)
      up |= this.msac.decodeBoolAdapt(cdf, 30 + bit * 2) << bit
    let fp = 3
    let hp = 1
    if (precision >= 0) {
      fp = this.msac.decodeSymbol(cdf, 52, 3)
      if (precision > 0) hp = this.msac.decodeBoolAdapt(cdf, 56)
    }
    const diff = (up << 3 | fp << 1 | hp) + 1
    return sign ? -diff : diff
  }

  private clipIntrabcMv(b: Av1Block, bw4: number, bh4: number, hasChroma: boolean): void {
    let borderLeft = this.colStart * 4
    let borderTop = this.rowStart * 4
    if (hasChroma) {
      if (bw4 < 2 && this.ssHor) borderLeft += 4
      if (bh4 < 2 && this.ssVer) borderTop += 4
    }
    let srcLeft = this.bx * 4 + (b.mvX >> 3)
    let srcTop = this.by * 4 + (b.mvY >> 3)
    let srcRight = srcLeft + bw4 * 4
    let srcBottom = srcTop + bh4 * 4
    const borderRight = ((this.colEnd + bw4 - 1) & ~(bw4 - 1)) * 4

    if (srcLeft < borderLeft) {
      srcRight += borderLeft - srcLeft
      srcLeft = borderLeft
    }
    else if (srcRight > borderRight) {
      srcLeft -= srcRight - borderRight
      srcRight = borderRight
    }
    if (srcTop < borderTop) {
      srcBottom += borderTop - srcTop
      srcTop = borderTop
    }

    const sbShift = this.seq.use128x128Superblock ? 7 : 6
    const sbx = (this.bx >> (sbShift - 2)) << sbShift
    const sby = (this.by >> (sbShift - 2)) << sbShift
    const sbSize = 1 << sbShift
    if (srcBottom > sby && srcRight > sbx) {
      if (srcTop - borderTop >= srcBottom - sby) {
        srcTop -= srcBottom - sby
        srcBottom = sby
      }
      else if (srcLeft - borderLeft >= srcRight - sbx) {
        srcLeft -= srcRight - sbx
        srcRight = sbx
      }
    }
    if (srcBottom > sby + sbSize) {
      srcTop -= srcBottom - (sby + sbSize)
      srcBottom = sby + sbSize
    }
    if (srcBottom > sby && srcRight > sbx)
      throw new Error('ts-avif: invalid intrabc motion vector overlaps its superblock')

    b.mvX = (srcLeft - this.bx * 4) * 8
    b.mvY = (srcTop - this.by * 4) * 8
  }

  private readPalettePlane(b: Av1Block, pl: number, szCtx: number, bx4: number, by4: number): void {
    const palSz = this.msac.decodeSymbol(this.cdf.data, this.cdf.offset('pal_sz', pl ? 1 : 0, szCtx), 6) + 2
    b.palSz[pl ? 1 : 0] = palSz
    const leftSize = pl ? this.l.palSzUv[by4] : this.l.palSz[by4]
    const aboveSize = (by4 & 15) ? (pl ? this.a.palSzUv[bx4] : this.a.palSz[bx4]) : 0
    const left = this.l.palettes[pl]
    const above = this.a.palettes[pl]
    const cache: number[] = []
    for (let i = 0; i < leftSize; i++) cache.push(left[by4 * 8 + i])
    for (let i = 0; i < aboveSize; i++) cache.push(above[bx4 * 8 + i])
    cache.sort((a, c) => a - c)
    const unique = cache.filter((v, i) => i === 0 || v !== cache[i - 1])
    const reused: number[] = []
    for (const value of unique) {
      if (reused.length < palSz && this.msac.decodeBoolEqui())
        reused.push(value)
    }

    const fresh: number[] = []
    const max = (1 << this.seq.bitDepth) - 1
    if (reused.length < palSz) {
      let previous = this.msac.readLiteral(this.seq.bitDepth)
      fresh.push(previous)
      if (reused.length + fresh.length < palSz) {
        let bits = this.seq.bitDepth - 3 + this.msac.readLiteral(2)
        while (reused.length + fresh.length < palSz) {
          previous = Math.min(previous + this.msac.readLiteral(bits) + (pl ? 0 : 1), max)
          fresh.push(previous)
          if (previous + (pl ? 0 : 1) >= max) {
            while (reused.length + fresh.length < palSz) fresh.push(max)
            break
          }
          bits = Math.min(bits, 1 + floorLog2(max - previous - (pl ? 0 : 1)))
        }
      }
    }
    const palette = b.palettes[pl]
    const merged = [...reused, ...fresh].sort((a, c) => a - c)
    for (let i = 0; i < palSz; i++) palette[i] = merged[i]
  }

  private readPaletteV(b: Av1Block): void {
    const palette = b.palettes[2]
    const size = b.palSz[1]
    const max = (1 << this.seq.bitDepth) - 1
    if (this.msac.decodeBoolEqui()) {
      const bits = this.seq.bitDepth - 4 + this.msac.readLiteral(2)
      let previous = palette[0] = this.msac.readLiteral(this.seq.bitDepth)
      for (let i = 1; i < size; i++) {
        let delta = this.msac.readLiteral(bits)
        if (delta && this.msac.decodeBoolEqui()) delta = -delta
        previous = palette[i] = (previous + delta) & max
      }
    }
    else {
      for (let i = 0; i < size; i++) palette[i] = this.msac.readLiteral(this.seq.bitDepth)
    }
  }

  private readPaletteIndices(palSz: number, pl: number, w4: number, h4: number, bw4: number, bh4: number): Uint8Array {
    const width = bw4 * 4
    const height = bh4 * 4
    const visibleWidth = w4 * 4
    const visibleHeight = h4 * 4
    const indices = new Uint8Array(width * height)
    indices[0] = this.msac.decodeUniform(palSz)
    const cdfBase = this.cdf.offset('color_map', pl, palSz - 2)
    for (let diagonal = 1; diagonal < visibleWidth + visibleHeight - 1; diagonal++) {
      const first = Math.min(diagonal, visibleWidth - 1)
      const last = Math.max(0, diagonal - visibleHeight + 1)
      for (let x = first; x >= last; x--) {
        const y = diagonal - x
        const haveLeft = x > 0
        const haveTop = y > 0
        const order: number[] = []
        let ctx = 0
        if (!haveLeft) order.push(indices[(y - 1) * width + x])
        else if (!haveTop) order.push(indices[y * width + x - 1])
        else {
          const left = indices[y * width + x - 1]
          const top = indices[(y - 1) * width + x]
          const topLeft = indices[(y - 1) * width + x - 1]
          if (top === left && top === topLeft) { ctx = 4; order.push(top) }
          else if (top === left) { ctx = 3; order.push(top, topLeft) }
          else if (top === topLeft || left === topLeft) { ctx = 2; order.push(topLeft, top === topLeft ? left : top) }
          else { ctx = 1; order.push(Math.min(top, left), Math.max(top, left), topLeft) }
        }
        for (let color = 0; color < palSz; color++) {
          if (!order.includes(color)) order.push(color)
        }
        const symbol = this.msac.decodeSymbol(this.cdf.data, cdfBase + ctx * 8, palSz - 1)
        indices[y * width + x] = order[symbol]
      }
    }
    for (let y = 0; y < visibleHeight; y++)
      indices.fill(indices[y * width + visibleWidth - 1], y * width + visibleWidth, (y + 1) * width)
    for (let y = visibleHeight; y < height; y++)
      indices.set(indices.subarray((visibleHeight - 1) * width, visibleHeight * width), y * width)
    return indices
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
                b.intra,
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
                  b.intra,
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
    interLumaTxtp = TxfmType.DCT_DCT,
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
      txtp = intra ? TXTP_FROM_UVMODE[b.uvMode] : uvInterTxtp(tDim, interLumaTxtp)
    }
    else if (hdr.segQIndex[b.segId] === 0) {
      txtp = TxfmType.DCT_DCT
    }
    else {
      const yModeNofilt = b.yMode === IntraPredMode.FILTER_PRED
        ? FILTER_MODE_TO_Y_MODE_LOCAL[b.yAngle]
        : b.yMode
      if (!intra) {
        if (hdr.reducedTxSet || tDim.max === TxfmSize.TX_32X32) {
          const idx = msac.decodeBoolAdapt(cdf.data, cdf.offset('txtp_inter3', tDim.min))
          txtp = idx ? TxfmType.DCT_DCT : TxfmType.IDTX
        }
        else if (tDim.min === TxfmSize.TX_16X16) {
          const idx = msac.decodeSymbol(cdf.data, cdf.offset('txtp_inter2'), 11)
          txtp = TX_TYPES_PER_SET[idx + 12]
        }
        else {
          const idx = msac.decodeSymbol(cdf.data, cdf.offset('txtp_inter1', tDim.min), 15)
          txtp = TX_TYPES_PER_SET[idx + 24]
        }
      }
      else if (hdr.reducedTxSet || tDim.min === TxfmSize.TX_16X16) {
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

    // dequant
    const dqTbl = this.dq[b.segId][plane]
    const qmLevel = plane === 0
      ? hdr.quantization.qmY
      : plane === 1
        ? hdr.quantization.qmU
        : hdr.quantization.qmV
    const qm = hdr.quantization.usingQMatrix && !lossless && txtp < TxfmType.IDTX
      ? getQuantMatrix(qmLevel, plane, tx)
      : null
    const dqShift = Math.max(0, tDim.ctx - 2)
    const cfMax = (1 << (this.seq.bitDepth + 7)) - 1
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
      if (qm)
        dcDq = (dcDq * qm[0] + 16) >> 5
      dcSignLevel = dcSign ? 0 : 2 << 6

      if (dcTok === 15) {
        dcTok = (msac.readGolomb() + 15) & 0xFFFFF
        dcDq = ((dcDq * dcTok) & 0xFFFFFF) >> dqShift
        dcDq = Math.min(dcDq, cfMax + dcSign)
      }
      else {
        dcDq = (dcDq * dcTok) >> dqShift
        if (qm)
          dcDq = Math.min(dcDq, cfMax + dcSign)
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
        const weightedDq = qm ? (acDq * qm[rc] + 16) >> 5 : acDq
        if (rcTok >= (15 << 11)) {
          tok = (msac.readGolomb() + 15) & 0xFFFFF
          dq = ((weightedDq * tok) & 0xFFFFFF) >> dqShift
          dq = Math.min(dq, cfMax + sign)
        }
        else {
          tok = rcTok >> 11
          dq = (weightedDq * tok) >> dqShift
          if (qm)
            dq = Math.min(dq, cfMax + sign)
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

function computeDq(bitDepth: number, hdr: FrameHeader, qidx: number): number[][] {
  const q = hdr.quantization
  const clip = (v: number): number => clamp(v, 0, 255)
  const table = bitDepth === 12
    ? DQ_TBL_12BPC
    : bitDepth === 10
      ? DQ_TBL_10BPC
      : DQ_TBL_8BPC
  return [
    [table[clip(qidx + q.deltaQYDc) * 2], table[qidx * 2 + 1]],
    [table[clip(qidx + q.deltaQUDc) * 2], table[clip(qidx + q.deltaQUAc) * 2 + 1]],
    [table[clip(qidx + q.deltaQVDc) * 2], table[clip(qidx + q.deltaQVAc) * 2 + 1]],
  ]
}

export { floorLog2 as ulog2 }

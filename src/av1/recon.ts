/**
 * Pixel reconstruction: implements the TileDecoder's Reconstructor hooks by
 * intra-predicting each tx block into the frame planes and adding the
 * inverse-transformed residual (port of the pixel side of dav1d's
 * recon_b_intra).
 */
import type { Av1Block, TileDecoder } from './decode-tile'
import type { LoopFilterData } from './loopfilter'
import type { PixelPlane } from './pixels'
import type { SequenceHeader } from './sequence'
import { IntraPredMode } from './consts'
import { TXFM_INFO } from './decode-tile'
import {
  ANGLE_SMOOTH_EDGE_FLAG,
  cflAc,
  cflPred,
  intraPred,
  prepareIntraEdges,
} from './ipred'
import { itxfmAdd } from './itx'
import { createPixelPlane } from './pixels'
import { BLOCK_DIMENSIONS } from './tables'

const EDGE_OFF = 128

export class FrameBuffers {
  y: PixelPlane
  u: PixelPlane
  v: PixelPlane
  yStride: number
  uvStride: number

  constructor(
    miCols: number,
    miRows: number,
    ssHor: number,
    ssVer: number,
    monochrome: boolean,
    bitDepth = 8,
    pixelWidth = miCols * 4,
    pixelHeight = miRows * 4,
  ) {
    this.yStride = pixelWidth
    this.uvStride = (pixelWidth + ssHor) >> ssHor
    const yH = pixelHeight
    const uvH = (pixelHeight + ssVer) >> ssVer
    this.y = createPixelPlane(this.yStride * yH, bitDepth)
    this.u = createPixelPlane(monochrome ? 0 : this.uvStride * uvH, bitDepth)
    this.v = createPixelPlane(monochrome ? 0 : this.uvStride * uvH, bitDepth)
  }

  static forDimensions(
    width: number,
    height: number,
    ssHor: number,
    ssVer: number,
    monochrome: boolean,
    bitDepth: number,
  ): FrameBuffers {
    return new FrameBuffers(0, 0, ssHor, ssVer, monochrome, bitDepth, width, height)
  }

  plane(i: number): PixelPlane {
    return i === 0 ? this.y : i === 1 ? this.u : this.v
  }

  stride(i: number): number {
    return i === 0 ? this.yStride : this.uvStride
  }
}

function bx4Odd(v: number): boolean {
  return (v & 1) === 1
}

function smFlagY(intra: number, mode: number): number {
  if (!intra)
    return 0
  return (mode === IntraPredMode.SMOOTH_PRED
    || mode === IntraPredMode.SMOOTH_V_PRED
    || mode === IntraPredMode.SMOOTH_H_PRED)
    ? ANGLE_SMOOTH_EDGE_FLAG
    : 0
}

function smFlagUv(mode: number): number {
  return (mode === IntraPredMode.SMOOTH_PRED
    || mode === IntraPredMode.SMOOTH_V_PRED
    || mode === IntraPredMode.SMOOTH_H_PRED)
    ? ANGLE_SMOOTH_EDGE_FLAG
    : 0
}

export class PixelReconstructor {
  private edge: PixelPlane
  private ac = new Int16Array(32 * 32)
  private intraEdgeFilterFlag: number
  /** Per-block state captured at startBlock. */
  private blockIntraFlags = 0
  private blockUvFlags = 0
  /** Optional loop-filter metadata sink and per-segment levels. */
  lf: LoopFilterData | null = null
  lfLevels: Uint8Array | null = null

  constructor(readonly buf: FrameBuffers, readonly seq: SequenceHeader) {
    this.edge = createPixelPlane(260, seq.bitDepth)
    this.intraEdgeFilterFlag = seq.enableIntraEdgeFilter ? 1 << 10 : 0
  }

  startBlock(bs: number, b: Av1Block, dec: TileDecoder): void {
    const bx4 = dec.bx
    const by4 = dec.by & 31
    const cbx4 = bx4 >> dec.ssHor
    const cby4 = (dec.by & 31) >> dec.ssVer
    this.blockIntraFlags
      = smFlagY(dec.a.intra[bx4], dec.a.mode[bx4])
        | smFlagY(dec.l.intra[by4], dec.l.mode[by4])
        | this.intraEdgeFilterFlag
    this.blockUvFlags = smFlagUv(dec.a.uvmode[cbx4]) | smFlagUv(dec.l.uvmode[cby4])

    if (this.lf && this.lfLevels)
      this.recordLoopFilter(bs, b, dec)

    const bw4 = BLOCK_DIMENSIONS[bs * 4]
    const bh4 = BLOCK_DIMENSIONS[bs * 4 + 1]
    if (b.palSz[0] && b.palIdxY) {
      const width = bw4 * 4
      const height = bh4 * 4
      const off = dec.by * 4 * this.buf.yStride + dec.bx * 4
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++)
          this.buf.y[off + y * this.buf.yStride + x] = b.palettes[0][b.palIdxY[y * width + x]]
      }
    }
    if (b.palSz[1] && b.palIdxUv) {
      const width = ((bw4 + dec.ssHor) >> dec.ssHor) * 4
      const height = ((bh4 + dec.ssVer) >> dec.ssVer) * 4
      const off = (dec.by >> dec.ssVer) * 4 * this.buf.uvStride + (dec.bx >> dec.ssHor) * 4
      for (let pl = 1; pl <= 2; pl++) {
        const plane = this.buf.plane(pl)
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++)
            plane[off + y * this.buf.uvStride + x] = b.palettes[pl][b.palIdxUv[y * width + x]]
        }
      }
    }
  }

  private recordLoopFilter(bs: number, b: Av1Block, dec: TileDecoder): void {
    const lf = this.lf!
    const lvls = this.lfLevels!
    const ssHor = dec.ssHor
    const ssVer = dec.ssVer
    const bDimOff = bs * 4
    const bw4 = BLOCK_DIMENSIONS[bDimOff]
    const bh4 = BLOCK_DIMENSIONS[bDimOff + 1]
    const miCols = dec.bw4
    const miRows = dec.bh4

    const lvlYV = lvls[b.segId * 4 + 0]
    const lvlYH = lvls[b.segId * 4 + 1]
    const yt = TXFM_INFO[b.tx]

    for (let ly = 0; ly < bh4; ly++) {
      const cy = dec.by + ly
      if (cy >= miRows)
        break
      const hEdge = ly % yt.h === 0 ? 1 : 0
      for (let lx = 0; lx < bw4; lx++) {
        const cx = dec.bx + lx
        if (cx >= miCols)
          break
        const cell = cy * miCols + cx
        lf.lvlYV[cell] = lvlYV
        lf.lvlYH[cell] = lvlYH
        lf.txlwY[cell] = yt.lw
        lf.txlhY[cell] = yt.lh
        if (lx % yt.w === 0)
          lf.stepVY[cell] = 1
        if (hEdge)
          lf.stepHY[cell] = 1
      }
    }

    if (dec.seq.monochrome)
      return
    const hasChroma = (bw4 > ssHor || (bx4Odd(dec.bx)))
      && (bh4 > ssVer || (bx4Odd(dec.by)))
    if (!hasChroma)
      return
    const cbw4 = (bw4 + ssHor) >> ssHor
    const cbh4 = (bh4 + ssVer) >> ssVer
    const cbx4 = dec.bx >> ssHor
    const cby4 = dec.by >> ssVer
    const lvlU = lvls[b.segId * 4 + 2]
    const lvlV = lvls[b.segId * 4 + 3]
    const ut = TXFM_INFO[b.uvtx]

    for (let ly = 0; ly < cbh4; ly++) {
      const cy = cby4 + ly
      if (cy >= lf.cRows)
        break
      const hEdge = ly % ut.h === 0 ? 1 : 0
      for (let lx = 0; lx < cbw4; lx++) {
        const cx = cbx4 + lx
        if (cx >= lf.cCols)
          break
        const cell = cy * lf.cCols + cx
        lf.lvlU[cell] = lvlU
        lf.lvlV[cell] = lvlV
        lf.txlwUv[cell] = ut.lw
        lf.txlhUv[cell] = ut.lh
        if (lx % ut.w === 0)
          lf.stepVUv[cell] = 1
        if (hEdge)
          lf.stepHUv[cell] = 1
      }
    }
  }

  predictCfl(b: Av1Block, dec: TileDecoder, cbw4: number, cbh4: number, cw4: number, ch4: number): void {
    const { buf } = this
    const ssHor = dec.ssHor
    const ssVer = dec.ssVer
    const tDim = TXFM_INFO[b.tx]
    const uvTDim = TXFM_INFO[b.uvtx]
    const ySrcOff = 4 * (dec.bx & ~ssHor) + 4 * (dec.by & ~ssVer) * buf.yStride

    const furthestR = ((cw4 << ssHor) + tDim.w - 1) & ~(tDim.w - 1)
    const furthestB = ((ch4 << ssVer) + tDim.h - 1) & ~(tDim.h - 1)
    cflAc(
      this.ac,
      buf.y,
      ySrcOff,
      buf.yStride,
      cbw4 - (furthestR >> ssHor),
      cbh4 - (furthestB >> ssVer),
      cbw4 * 4,
      cbh4 * 4,
      ssHor,
      ssVer,
    )

    const xpos = dec.bx >> ssHor
    const ypos = dec.by >> ssVer
    const xstart = dec.colStart >> ssHor
    const ystart = dec.rowStart >> ssVer
    for (let pl = 0; pl < 2; pl++) {
      if (!b.cflAlpha[pl])
        continue
      const plane = buf.plane(1 + pl)
      const stride = buf.uvStride
      const dstOff = 4 * xpos + 4 * ypos * stride
      const { mode } = prepareIntraEdges(
        xpos,
        xpos > xstart,
        ypos,
        ypos > ystart,
        dec.colEnd >> ssHor,
        dec.rowEnd >> ssVer,
        0,
        plane,
        dstOff,
        stride,
        IntraPredMode.DC_PRED,
        0,
        uvTDim.w,
        uvTDim.h,
        0,
        this.edge,
        EDGE_OFF,
        this.seq.bitDepth,
      )
      cflPred(
        mode,
        plane,
        dstOff,
        stride,
        this.edge,
        EDGE_OFF,
        uvTDim.w * 4,
        uvTDim.h * 4,
        this.ac,
        b.cflAlpha[pl],
        this.seq.bitDepth,
      )
    }
  }

  reconTxBlock(
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
  ): void {
    const { buf } = this
    const tDim = TXFM_INFO[tx]
    const pl = buf.plane(plane)
    const stride = buf.stride(plane)
    const dstOff = 4 * bx + 4 * by * stride

    const usesPalette = b.palSz[plane === 0 ? 0 : 1] !== 0
    if (!usesPalette && plane === 0) {
      let angle = b.yAngle
      const prep = prepareIntraEdges(
        bx,
        bx > dec.colStart,
        by,
        by > dec.rowStart,
        dec.colEnd,
        dec.rowEnd,
        edgeFlags,
        pl,
        dstOff,
        stride,
        b.yMode,
        angle,
        tDim.w,
        tDim.h,
        this.seq.enableIntraEdgeFilter ? 1 : 0,
        this.edge,
        EDGE_OFF,
        this.seq.bitDepth,
      )
      angle = prep.angle
      intraPred(
        prep.mode,
        pl,
        dstOff,
        stride,
        this.edge,
        EDGE_OFF,
        tDim.w * 4,
        tDim.h * 4,
        angle | this.blockIntraFlags,
        4 * dec.bw4 - 4 * dec.bx,
        4 * dec.bh4 - 4 * dec.by,
        this.seq.bitDepth,
      )
    }
    else if (!usesPalette) {
      const skipPred = b.uvMode === IntraPredMode.CFL_PRED && b.cflAlpha[plane - 1] !== 0
      if (!skipPred) {
        const ssHor = dec.ssHor
        const ssVer = dec.ssVer
        const uvMode = b.uvMode === IntraPredMode.CFL_PRED ? IntraPredMode.DC_PRED : b.uvMode
        let angle = b.uvAngle
        const prep = prepareIntraEdges(
          bx,
          bx > (dec.colStart >> ssHor),
          by,
          by > (dec.rowStart >> ssVer),
          dec.colEnd >> ssHor,
          dec.rowEnd >> ssVer,
          edgeFlags,
          pl,
          dstOff,
          stride,
          uvMode,
          angle,
          tDim.w,
          tDim.h,
          this.seq.enableIntraEdgeFilter ? 1 : 0,
          this.edge,
          EDGE_OFF,
          this.seq.bitDepth,
        )
        angle = prep.angle | this.intraEdgeFilterFlag
        intraPred(
          prep.mode,
          pl,
          dstOff,
          stride,
          this.edge,
          EDGE_OFF,
          tDim.w * 4,
          tDim.h * 4,
          angle | this.blockUvFlags,
          (4 * dec.bw4 + ssHor - 4 * (bx << ssHor)) >> ssHor,
          (4 * dec.bh4 + ssVer - 4 * (by << ssVer)) >> ssVer,
          this.seq.bitDepth,
        )
      }
    }

    if (eob >= 0)
      itxfmAdd(pl, dstOff, stride, cf, tx, txtp, eob, this.seq.bitDepth)
  }
}

/**
 * Pixel reconstruction: implements the TileDecoder's Reconstructor hooks by
 * intra-predicting each tx block into the frame planes and adding the
 * inverse-transformed residual (port of the pixel side of dav1d's
 * recon_b_intra).
 */
import type { Av1Block, TileDecoder } from './decode-tile'
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

const EDGE_OFF = 128

export class FrameBuffers {
  y: Uint8Array
  u: Uint8Array
  v: Uint8Array
  yStride: number
  uvStride: number

  constructor(miCols: number, miRows: number, ssHor: number, ssVer: number, monochrome: boolean) {
    this.yStride = miCols * 4
    this.uvStride = (miCols * 4) >> ssHor
    const yH = miRows * 4
    const uvH = (miRows * 4) >> ssVer
    this.y = new Uint8Array(this.yStride * yH)
    this.u = monochrome ? new Uint8Array(0) : new Uint8Array(this.uvStride * uvH)
    this.v = monochrome ? new Uint8Array(0) : new Uint8Array(this.uvStride * uvH)
  }

  plane(i: number): Uint8Array {
    return i === 0 ? this.y : i === 1 ? this.u : this.v
  }

  stride(i: number): number {
    return i === 0 ? this.yStride : this.uvStride
  }
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
  private edge = new Uint8Array(260)
  private ac = new Int16Array(32 * 32)
  private intraEdgeFilterFlag: number
  /** Per-block state captured at startBlock. */
  private blockIntraFlags = 0
  private blockUvFlags = 0

  constructor(readonly buf: FrameBuffers, readonly seq: SequenceHeader) {
    this.intraEdgeFilterFlag = seq.enableIntraEdgeFilter ? 1 << 10 : 0
  }

  startBlock(_bs: number, _b: Av1Block, dec: TileDecoder): void {
    const bx4 = dec.bx
    const by4 = dec.by & 31
    const cbx4 = bx4 >> dec.ssHor
    const cby4 = (dec.by & 31) >> dec.ssVer
    this.blockIntraFlags
      = smFlagY(dec.a.intra[bx4], dec.a.mode[bx4])
        | smFlagY(dec.l.intra[by4], dec.l.mode[by4])
        | this.intraEdgeFilterFlag
    this.blockUvFlags = smFlagUv(dec.a.uvmode[cbx4]) | smFlagUv(dec.l.uvmode[cby4])
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
      )
      cflPred(mode, plane, dstOff, stride, this.edge, EDGE_OFF, uvTDim.w * 4, uvTDim.h * 4, this.ac, b.cflAlpha[pl])
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

    if (plane === 0) {
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
      )
    }
    else {
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
        )
      }
    }

    if (eob >= 0)
      itxfmAdd(pl, dstOff, stride, cf, tx, txtp, eob)
  }
}

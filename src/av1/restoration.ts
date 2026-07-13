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
import { SGR_PARAMS } from './tables'

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

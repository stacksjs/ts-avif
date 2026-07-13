/**
 * Frame-level decode orchestration: runs the tile decoder(s) with pixel
 * reconstruction into planar YUV buffers, then converts to interleaved RGBA.
 */
import type { FrameHeader } from './frame-header'
import type { SequenceHeader } from './sequence'
import type { Tile } from './tile-group'
import { CdfContext } from './cdf'
import { TileDecoder } from './decode-tile'
import { INTRA_EDGE_TREE } from './intra-edge'
import { applyLoopFilter, computeLoopFilterLevels, LoopFilterData } from './loopfilter'
import { FrameBuffers, PixelReconstructor } from './recon'

export interface DecodedFrame {
  buf: FrameBuffers
  width: number
  height: number
}

export function decodeFrame(seq: SequenceHeader, hdr: FrameHeader, tiles: Tile[]): DecodedFrame {
  const buf = new FrameBuffers(
    hdr.miCols,
    hdr.miRows,
    seq.subsamplingX,
    seq.subsamplingY,
    seq.monochrome,
  )
  const recon = new PixelReconstructor(buf, seq)
  const lfActive = hdr.loopFilter.levels[0] !== 0 || hdr.loopFilter.levels[1] !== 0
  if (lfActive) {
    recon.lf = new LoopFilterData(hdr.miCols, hdr.miRows, seq.subsamplingX, seq.subsamplingY)
    recon.lfLevels = computeLoopFilterLevels(hdr)
  }
  const sbRoot = INTRA_EDGE_TREE[seq.use128x128Superblock ? 0 : 1]

  const { tileCols, tileRows, miColStarts, miRowStarts } = hdr.tileInfo
  for (const tile of tiles) {
    if (tile.tileRow >= tileRows || tile.tileCol >= tileCols)
      throw new Error(`ts-avif: tile ${tile.tileNum} outside the tile grid`)
    const cdf = new CdfContext(hdr.quantization.baseQIdx)
    const dec = new TileDecoder(seq, hdr, tile.data, cdf, recon)
    dec.colStart = miColStarts[tile.tileCol]
    dec.colEnd = Math.min(miColStarts[tile.tileCol + 1], hdr.miCols)
    dec.rowStart = miRowStarts[tile.tileRow]
    dec.rowEnd = Math.min(miRowStarts[tile.tileRow + 1], hdr.miRows)
    dec.decodeTile(sbRoot)
  }

  if (recon.lf)
    applyLoopFilter(buf, recon.lf, seq, hdr)

  return { buf, width: hdr.frameWidth, height: hdr.frameHeight }
}

/**
 * Convert the decoded planar YUV to interleaved RGBA. Handles identity (RGB),
 * BT.601, BT.709, and BT.2020 non-constant-luminance matrices in full or
 * limited range; 4:2:0/4:2:2 chroma is upsampled with a simple co-located
 * bilinear filter.
 */
export function yuvToRgba(
  frame: DecodedFrame,
  seq: SequenceHeader,
): Uint8Array {
  const { buf, width, height } = frame
  const out = new Uint8Array(width * height * 4)

  if (seq.monochrome) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4
        const v = expandRange(buf.y[y * buf.yStride + x], seq.colorRange)
        out[o] = v
        out[o + 1] = v
        out[o + 2] = v
        out[o + 3] = 255
      }
    }
    return out
  }

  // matrix coefficients: kr/kb per ITU-T H.273
  let kr: number
  let kb: number
  switch (seq.matrixCoefficients) {
    case 1: kr = 0.2126; kb = 0.0722; break // BT.709
    case 9: kr = 0.2627; kb = 0.0593; break // BT.2020-NCL
    case 5:
    case 6:
    default: kr = 0.299; kb = 0.114; break // BT.601 (and unspecified)
  }
  const kg = 1 - kr - kb
  const crCoeff = 2 * (1 - kr)
  const cbCoeff = 2 * (1 - kb)
  const crG = (2 * kr * (1 - kr)) / kg
  const cbG = (2 * kb * (1 - kb)) / kg

  const ssHor = seq.subsamplingX
  const ssVer = seq.subsamplingY
  const fullRange = seq.colorRange

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const yv = buf.y[y * buf.yStride + x]
      const u = sampleChroma(buf.u, buf.uvStride, x, y, ssHor, ssVer, width, height)
      const v = sampleChroma(buf.v, buf.uvStride, x, y, ssHor, ssVer, width, height)

      let yf: number
      let uf: number
      let vf: number
      if (fullRange) {
        yf = yv / 255
        uf = (u - 128) / 255
        vf = (v - 128) / 255
      }
      else {
        yf = (yv - 16) / 219
        uf = (u - 128) / 224
        vf = (v - 128) / 224
      }

      out[o] = clip255(Math.round((yf + crCoeff * vf) * 255))
      out[o + 1] = clip255(Math.round((yf - crG * vf - cbG * uf) * 255))
      out[o + 2] = clip255(Math.round((yf + cbCoeff * uf) * 255))
      out[o + 3] = 255
    }
  }
  return out
}

function clip255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

function expandRange(v: number, fullRange: boolean): number {
  return fullRange ? v : clip255(Math.round(((v - 16) / 219) * 255))
}

/** Bilinear chroma upsample for one sample position (co-located siting). */
function sampleChroma(
  plane: Uint8Array,
  stride: number,
  x: number,
  y: number,
  ssHor: number,
  ssVer: number,
  width: number,
  height: number,
): number {
  if (!ssHor && !ssVer)
    return plane[y * stride + x]
  const cw = (width + ssHor) >> ssHor
  const ch = (height + ssVer) >> ssVer
  // fractional chroma coordinate for this luma sample (left/top co-sited)
  const cx = ssHor ? (x - 0.5) / 2 : x
  const cy = ssVer ? (y - 0.5) / 2 : y
  const x0 = Math.max(0, Math.min(cw - 1, Math.floor(cx)))
  const y0 = Math.max(0, Math.min(ch - 1, Math.floor(cy)))
  const x1 = Math.min(cw - 1, x0 + 1)
  const y1 = Math.min(ch - 1, y0 + 1)
  const fx = Math.max(0, Math.min(1, cx - x0))
  const fy = Math.max(0, Math.min(1, cy - y0))
  const p00 = plane[y0 * stride + x0]
  const p01 = plane[y0 * stride + x1]
  const p10 = plane[y1 * stride + x0]
  const p11 = plane[y1 * stride + x1]
  return (p00 * (1 - fx) + p01 * fx) * (1 - fy) + (p10 * (1 - fx) + p11 * fx) * fy
}

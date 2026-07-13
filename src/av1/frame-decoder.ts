/**
 * Frame-level decode orchestration: runs the tile decoder(s) with pixel
 * reconstruction into planar YUV buffers, then converts to interleaved RGBA.
 */
import type { FrameHeader } from './frame-header'
import type { SequenceHeader } from './sequence'
import type { Tile } from './tile-group'
import type { PixelPlane } from './pixels'
import { applyCdef, CdefData } from './cdef'
import { CdfContext } from './cdf'
import { TileDecoder } from './decode-tile'
import { INTRA_EDGE_TREE } from './intra-edge'
import { applyLoopFilter, computeLoopFilterLevels, LoopFilterData } from './loopfilter'
import { FrameBuffers, PixelReconstructor } from './recon'
import { applyRestoration, RestorationInfo } from './restoration'
import { upscaleFrame } from './superres'

export interface DecodedFrame {
  buf: FrameBuffers
  width: number
  height: number
}

export function decodeFrame(seq: SequenceHeader, hdr: FrameHeader, tiles: Tile[]): DecodedFrame {
  let buf = new FrameBuffers(
    hdr.miCols,
    hdr.miRows,
    seq.subsamplingX,
    seq.subsamplingY,
    seq.monochrome,
    seq.bitDepth,
  )
  const recon = new PixelReconstructor(buf, seq)
  const lfActive = hdr.loopFilter.levels[0] !== 0 || hdr.loopFilter.levels[1] !== 0
  if (lfActive) {
    recon.lf = new LoopFilterData(hdr.miCols, hdr.miRows, seq.subsamplingX, seq.subsamplingY)
    recon.lfLevels = computeLoopFilterLevels(hdr)
  }
  const cdefActive = seq.enableCdef
  const cdefData = cdefActive ? new CdefData(hdr.miCols, hdr.miRows) : null
  const restorationInfo = seq.enableRestoration ? new RestorationInfo(seq, hdr) : null
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
    dec.cdefData = cdefData
    dec.restoration = restorationInfo
    dec.decodeTile(sbRoot)
  }

  if (recon.lf)
    applyLoopFilter(buf, recon.lf, seq, hdr)

  // Loop restoration reads stripe boundaries from the deblocked (pre-CDEF)
  // planes, so snapshot them before CDEF runs.
  const lrActive = restorationInfo !== null && restorationInfo.restorePlanes !== 0
  let deblocked: { y: PixelPlane, u: PixelPlane, v: PixelPlane } | null = lrActive
    ? { y: buf.y.slice(), u: buf.u.slice(), v: buf.v.slice() }
    : null

  if (cdefData) {
    applyCdef(buf, cdefData, {
      enableCdef: true,
      damping: hdr.cdef.damping,
      bits: hdr.cdef.bits,
      yPri: hdr.cdef.yPriStrength,
      ySec: hdr.cdef.ySecStrength,
      uvPri: hdr.cdef.uvPriStrength,
      uvSec: hdr.cdef.uvSecStrength,
      monochrome: seq.monochrome,
      ssHor: seq.subsamplingX,
      ssVer: seq.subsamplingY,
      layout: seq.monochrome ? 0 : seq.subsamplingX === 0 ? 3 : seq.subsamplingY === 0 ? 2 : 1,
      bitDepth: seq.bitDepth,
    })
  }

  if (hdr.frameWidth !== hdr.upscaledWidth) {
    buf = upscaleFrame(buf, seq, hdr)
    if (deblocked) {
      const preCdef = new FrameBuffers(
        hdr.miCols,
        hdr.miRows,
        seq.subsamplingX,
        seq.subsamplingY,
        seq.monochrome,
        seq.bitDepth,
      )
      preCdef.y.set(deblocked.y)
      preCdef.u.set(deblocked.u)
      preCdef.v.set(deblocked.v)
      const upscaledDeblocked = upscaleFrame(preCdef, seq, hdr)
      deblocked = {
        y: upscaledDeblocked.y,
        u: upscaledDeblocked.u,
        v: upscaledDeblocked.v,
      }
    }
  }

  if (lrActive && deblocked)
    applyRestoration(buf, restorationInfo!, seq, hdr, deblocked)

  return { buf, width: hdr.upscaledWidth, height: hdr.frameHeight }
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
        const v = expandRange(buf.y[y * buf.yStride + x], seq.colorRange, seq.bitDepth)
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
  const depthScale = 1 << (seq.bitDepth - 8)
  const sampleMax = (1 << seq.bitDepth) - 1
  const neutral = 128 * depthScale

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
        yf = yv / sampleMax
        uf = (u - neutral) / sampleMax
        vf = (v - neutral) / sampleMax
      }
      else {
        yf = (yv - 16 * depthScale) / (219 * depthScale)
        uf = (u - neutral) / (224 * depthScale)
        vf = (v - neutral) / (224 * depthScale)
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

function expandRange(v: number, fullRange: boolean, bitDepth: number): number {
  const scale = 1 << (bitDepth - 8)
  const max = (1 << bitDepth) - 1
  return fullRange
    ? clip255(Math.round(v * 255 / max))
    : clip255(Math.round(((v - 16 * scale) / (219 * scale)) * 255))
}

/** Bilinear chroma upsample for one sample position (co-located siting). */
function sampleChroma(
  plane: PixelPlane,
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

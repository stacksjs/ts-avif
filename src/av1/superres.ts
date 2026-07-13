/**
 * AV1 horizontal super-resolution upscaling (spec 7.16).
 *
 * The normative eight-tap filter is stored as signed coefficients whose sum
 * is -128, matching dav1d's representation. Keeping the exact integer phase
 * accumulator here avoids floating-point drift at uncommon frame widths.
 */
import type { FrameHeader } from './frame-header'
import type { PixelPlane } from './pixels'
import type { SequenceHeader } from './sequence'
import { FrameBuffers } from './recon'
import { clipPixel } from './pixels'

const RESIZE_FILTER = [
  [0, 0, 0, -128, 0, 0, 0, 0], [0, 0, 1, -128, -2, 1, 0, 0],
  [0, -1, 3, -127, -4, 2, -1, 0], [0, -1, 4, -127, -6, 3, -1, 0],
  [0, -2, 6, -126, -8, 3, -1, 0], [0, -2, 7, -125, -11, 4, -1, 0],
  [1, -2, 8, -125, -13, 5, -2, 0], [1, -3, 9, -124, -15, 6, -2, 0],
  [1, -3, 10, -123, -18, 6, -2, 1], [1, -3, 11, -122, -20, 7, -3, 1],
  [1, -4, 12, -121, -22, 8, -3, 1], [1, -4, 13, -120, -25, 9, -3, 1],
  [1, -4, 14, -118, -28, 9, -3, 1], [1, -4, 15, -117, -30, 10, -4, 1],
  [1, -5, 16, -116, -32, 11, -4, 1], [1, -5, 16, -114, -35, 12, -4, 1],
  [1, -5, 17, -112, -38, 12, -4, 1], [1, -5, 18, -111, -40, 13, -5, 1],
  [1, -5, 18, -109, -43, 14, -5, 1], [1, -6, 19, -107, -45, 14, -5, 1],
  [1, -6, 19, -105, -48, 15, -5, 1], [1, -6, 19, -103, -51, 16, -5, 1],
  [1, -6, 20, -101, -53, 16, -6, 1], [1, -6, 20, -99, -56, 17, -6, 1],
  [1, -6, 20, -97, -58, 17, -6, 1], [1, -6, 20, -95, -61, 18, -6, 1],
  [2, -7, 20, -93, -64, 18, -6, 2], [2, -7, 20, -91, -66, 19, -6, 1],
  [2, -7, 20, -88, -69, 19, -6, 1], [2, -7, 20, -86, -71, 19, -6, 1],
  [2, -7, 20, -84, -74, 20, -7, 2], [2, -7, 20, -81, -76, 20, -7, 1],
  [2, -7, 20, -79, -79, 20, -7, 2], [1, -7, 20, -76, -81, 20, -7, 2],
  [2, -7, 20, -74, -84, 20, -7, 2], [1, -6, 19, -71, -86, 20, -7, 2],
  [1, -6, 19, -69, -88, 20, -7, 2], [1, -6, 19, -66, -91, 20, -7, 2],
  [2, -6, 18, -64, -93, 20, -7, 2], [1, -6, 18, -61, -95, 20, -6, 1],
  [1, -6, 17, -58, -97, 20, -6, 1], [1, -6, 17, -56, -99, 20, -6, 1],
  [1, -6, 16, -53, -101, 20, -6, 1], [1, -5, 16, -51, -103, 19, -6, 1],
  [1, -5, 15, -48, -105, 19, -6, 1], [1, -5, 14, -45, -107, 19, -6, 1],
  [1, -5, 14, -43, -109, 18, -5, 1], [1, -5, 13, -40, -111, 18, -5, 1],
  [1, -4, 12, -38, -112, 17, -5, 1], [1, -4, 12, -35, -114, 16, -5, 1],
  [1, -4, 11, -32, -116, 16, -5, 1], [1, -4, 10, -30, -117, 15, -4, 1],
  [1, -3, 9, -28, -118, 14, -4, 1], [1, -3, 9, -25, -120, 13, -4, 1],
  [1, -3, 8, -22, -121, 12, -4, 1], [1, -3, 7, -20, -122, 11, -3, 1],
  [1, -2, 6, -18, -123, 10, -3, 1], [0, -2, 6, -15, -124, 9, -3, 1],
  [0, -2, 5, -13, -125, 8, -2, 1], [0, -1, 4, -11, -125, 7, -2, 0],
  [0, -1, 3, -8, -126, 6, -2, 0], [0, -1, 3, -6, -127, 4, -1, 0],
  [0, -1, 2, -4, -127, 3, -1, 0], [0, 0, 1, -2, -128, 1, 0, 0],
] as const

function scaleFactor(inputWidth: number, outputWidth: number): number {
  return Math.floor(((inputWidth << 14) + (outputWidth >> 1)) / outputWidth)
}

function upscaleStart(inputWidth: number, outputWidth: number, step: number): number {
  const error = outputWidth * step - (inputWidth << 14)
  const centered = Math.trunc((-((outputWidth - inputWidth) << 13) + (outputWidth >> 1)) / outputWidth)
  return (centered + 128 - Math.trunc(error / 2)) & 0x3FFF
}

function clampIndex(v: number, width: number): number {
  return v < 0 ? 0 : v >= width ? width - 1 : v
}

function resizePlane(
  dst: PixelPlane,
  dstStride: number,
  dstWidth: number,
  src: PixelPlane,
  srcStride: number,
  srcWidth: number,
  inputWidth: number,
  height: number,
  bitDepth: number,
): void {
  const step = scaleFactor(inputWidth, dstWidth)
  const start = upscaleStart(inputWidth, dstWidth, step)
  for (let y = 0; y < height; y++) {
    const srcOff = y * srcStride
    const dstOff = y * dstStride
    let phase = start
    let srcX = -1
    for (let x = 0; x < dstWidth; x++) {
      const filter = RESIZE_FILTER[phase >> 8]
      let sum = 0
      for (let tap = 0; tap < 8; tap++)
        sum += filter[tap] * src[srcOff + clampIndex(srcX + tap - 3, srcWidth)]
      dst[dstOff + x] = clipPixel((-sum + 64) >> 7, bitDepth)
      phase += step
      srcX += phase >> 14
      phase &= 0x3FFF
    }
  }
}

/** Upscale every decoded plane to the frame's display width. */
export function upscaleFrame(
  src: FrameBuffers,
  seq: SequenceHeader,
  hdr: FrameHeader,
): FrameBuffers {
  if (hdr.frameWidth === hdr.upscaledWidth)
    return src

  const paddedHeight = hdr.miRows * 4
  const dst = FrameBuffers.forDimensions(
    hdr.upscaledWidth,
    paddedHeight,
    seq.subsamplingX,
    seq.subsamplingY,
    seq.monochrome,
    seq.bitDepth,
  )

  resizePlane(
    dst.y, dst.yStride, hdr.upscaledWidth,
    src.y, src.yStride, src.yStride,
    hdr.frameWidth, paddedHeight, seq.bitDepth,
  )

  if (!seq.monochrome) {
    const inputWidth = (hdr.frameWidth + seq.subsamplingX) >> seq.subsamplingX
    const outputWidth = (hdr.upscaledWidth + seq.subsamplingX) >> seq.subsamplingX
    const height = (paddedHeight + seq.subsamplingY) >> seq.subsamplingY
    resizePlane(
      dst.u, dst.uvStride, outputWidth,
      src.u, src.uvStride, src.uvStride,
      inputWidth, height, seq.bitDepth,
    )
    resizePlane(
      dst.v, dst.uvStride, outputWidth,
      src.v, src.uvStride, src.uvStride,
      inputWidth, height, seq.bitDepth,
    )
  }

  return dst
}

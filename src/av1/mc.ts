import type { PixelPlane } from './pixels'

// AV1 regular eight-tap interpolation filters for phases 1/16..15/16.
const REGULAR = [
  [0, 1, -3, 63, 4, -1, 0, 0],
  [0, 1, -5, 61, 9, -2, 0, 0],
  [0, 1, -6, 58, 14, -4, 1, 0],
  [0, 1, -7, 55, 19, -5, 1, 0],
  [0, 1, -7, 51, 24, -6, 1, 0],
  [0, 1, -8, 47, 29, -6, 1, 0],
  [0, 1, -7, 42, 33, -6, 1, 0],
  [0, 1, -7, 38, 38, -7, 1, 0],
  [0, 1, -6, 33, 42, -7, 1, 0],
  [0, 1, -6, 29, 47, -8, 1, 0],
  [0, 1, -6, 24, 51, -7, 1, 0],
  [0, 1, -5, 19, 55, -7, 1, 0],
  [0, 1, -4, 14, 58, -6, 1, 0],
  [0, 0, -2, 9, 61, -5, 1, 0],
  [0, 0, -1, 4, 63, -3, 1, 0],
] as const

const SMOOTH = [
  [0, 1, 14, 31, 17, 1, 0, 0], [0, 0, 13, 31, 18, 2, 0, 0],
  [0, 0, 11, 31, 20, 2, 0, 0], [0, 0, 10, 30, 21, 3, 0, 0],
  [0, 0, 9, 29, 22, 4, 0, 0], [0, 0, 8, 28, 23, 5, 0, 0],
  [0, -1, 8, 27, 24, 6, 0, 0], [0, -1, 7, 26, 26, 7, -1, 0],
  [0, 0, 6, 24, 27, 8, -1, 0], [0, 0, 5, 23, 28, 8, 0, 0],
  [0, 0, 4, 22, 29, 9, 0, 0], [0, 0, 3, 21, 30, 10, 0, 0],
  [0, 0, 2, 20, 31, 11, 0, 0], [0, 0, 2, 18, 31, 13, 0, 0],
  [0, 0, 1, 17, 31, 14, 1, 0],
] as const

const SHARP = [
  [-1, 1, -3, 63, 4, -1, 1, 0], [-1, 3, -6, 62, 8, -3, 2, -1],
  [-1, 4, -9, 60, 13, -5, 3, -1], [-2, 5, -11, 58, 19, -7, 3, -1],
  [-2, 5, -11, 54, 24, -9, 4, -1], [-2, 5, -12, 50, 30, -10, 4, -1],
  [-2, 5, -12, 45, 35, -11, 5, -1], [-2, 6, -12, 40, 40, -12, 6, -2],
  [-1, 5, -11, 35, 45, -12, 5, -2], [-1, 4, -10, 30, 50, -12, 5, -2],
  [-1, 4, -9, 24, 54, -11, 5, -2], [-1, 3, -7, 19, 58, -11, 5, -2],
  [-1, 3, -5, 13, 60, -9, 4, -1], [-1, 2, -3, 8, 62, -6, 3, -1],
  [0, 1, -1, 4, 63, -3, 1, -1],
] as const

const REGULAR_NARROW = REGULAR.map(row => [0, 0, row[2] + row[1], row[3], row[4], row[5] + row[6], 0, 0])
const SMOOTH_NARROW = [
  [0, 0, 15, 31, 17, 1, 0, 0], [0, 0, 13, 31, 18, 2, 0, 0],
  [0, 0, 11, 31, 20, 2, 0, 0], [0, 0, 10, 30, 21, 3, 0, 0],
  [0, 0, 9, 29, 22, 4, 0, 0], [0, 0, 8, 28, 23, 5, 0, 0],
  [0, 0, 7, 27, 24, 6, 0, 0], [0, 0, 6, 26, 26, 6, 0, 0],
  [0, 0, 6, 24, 27, 7, 0, 0], [0, 0, 5, 23, 28, 8, 0, 0],
  [0, 0, 4, 22, 29, 9, 0, 0], [0, 0, 3, 21, 30, 10, 0, 0],
  [0, 0, 2, 20, 31, 11, 0, 0], [0, 0, 2, 18, 31, 13, 0, 0],
  [0, 0, 1, 17, 31, 15, 0, 0],
] as const

const BILINEAR = Array.from({ length: 15 }, (_, phase) => {
  const right = (phase + 1) * 4
  return [0, 0, 0, 64 - right, right, 0, 0, 0]
})

function filter(mode: number, phase: number, size: number): readonly number[] | null {
  if (!phase) return null
  if (mode === 0) return (size > 4 ? REGULAR : REGULAR_NARROW)[phase - 1]
  if (mode === 1) return (size > 4 ? SMOOTH : SMOOTH_NARROW)[phase - 1]
  if (mode === 2) return (size > 4 ? SHARP : REGULAR_NARROW)[phase - 1]
  if (mode === 3) return BILINEAR[phase - 1]
  throw new Error(`ts-avif: inter interpolation filter ${mode} is not implemented`)
}

function clip(value: number, max: number): number {
  return value < 0 ? 0 : value > max ? max : value
}

/** Normative separable AV1 motion compensation for an unscaled reference. */
export function motionCompensate(
  dst: PixelPlane,
  dstStride: number,
  dstX: number,
  dstY: number,
  src: PixelPlane,
  srcStride: number,
  srcWidth: number,
  srcHeight: number,
  srcX: number,
  srcY: number,
  width: number,
  height: number,
  phaseX: number,
  phaseY: number,
  filterH: number,
  filterV: number,
  bitDepth: number,
): void {
  const fh = filter(filterH, phaseX, width)
  const fv = filter(filterV, phaseY, height)
  const max = (1 << bitDepth) - 1
  const sample = (x: number, y: number): number => src[
    clip(y, srcHeight - 1) * srcStride + clip(x, srcWidth - 1)
  ]

  if (!fh && !fv) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++)
        dst[(dstY + y) * dstStride + dstX + x] = sample(srcX + x, srcY + y)
    }
    return
  }

  const intermediateBits = bitDepth === 12 ? 2 : 4
  if (fh && fv) {
    const midHeight = height + 7
    const mid = new Int32Array(width * midHeight)
    const hShift = 6 - intermediateBits
    const hRound = 1 << (hShift - 1)
    for (let y = 0; y < midHeight; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0
        for (let tap = 0; tap < 8; tap++)
          sum += fh[tap] * sample(srcX + x + tap - 3, srcY + y - 3)
        mid[y * width + x] = (sum + hRound) >> hShift
      }
    }
    const vShift = 6 + intermediateBits
    const vRound = 1 << (vShift - 1)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0
        for (let tap = 0; tap < 8; tap++) sum += fv[tap] * mid[(y + tap) * width + x]
        dst[(dstY + y) * dstStride + dstX + x] = clip((sum + vRound) >> vShift, max)
      }
    }
    return
  }

  const taps = fh ?? fv!
  const round = fh ? 32 + ((1 << (6 - intermediateBits)) >> 1) : 32
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let tap = 0; tap < 8; tap++) {
        const sx = srcX + x + (fh ? tap - 3 : 0)
        const sy = srcY + y + (fv ? tap - 3 : 0)
        sum += taps[tap] * sample(sx, sy)
      }
      dst[(dstY + y) * dstStride + dstX + x] = clip((sum + round) >> 6, max)
    }
  }
}

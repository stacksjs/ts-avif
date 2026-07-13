import type { PixelPlane } from './pixels'
import type { GlobalMotionParams } from './frame-header'

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

const WARP_FILTER_BYTES = Uint8Array.fromBase64(
  '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',
)
const WARP_FILTER = new Int8Array(WARP_FILTER_BYTES.buffer, WARP_FILTER_BYTES.byteOffset, WARP_FILTER_BYTES.byteLength)

const DIV_LUT = [
  16384, 16320, 16257, 16194, 16132, 16070, 16009, 15948, 15888, 15828, 15768, 15709, 15650, 15592, 15534, 15477,
  15420, 15364, 15308, 15252, 15197, 15142, 15087, 15033, 14980, 14926, 14873, 14821, 14769, 14717, 14665, 14614,
  14564, 14513, 14463, 14413, 14364, 14315, 14266, 14218, 14170, 14122, 14075, 14028, 13981, 13935, 13888, 13843,
  13797, 13752, 13707, 13662, 13618, 13574, 13530, 13487, 13443, 13400, 13358, 13315, 13273, 13231, 13190, 13148,
  13107, 13066, 13026, 12985, 12945, 12906, 12866, 12827, 12788, 12749, 12710, 12672, 12633, 12596, 12558, 12520,
  12483, 12446, 12409, 12373, 12336, 12300, 12264, 12228, 12193, 12157, 12122, 12087, 12053, 12018, 11984, 11950,
  11916, 11882, 11848, 11815, 11782, 11749, 11716, 11683, 11651, 11619, 11586, 11555, 11523, 11491, 11460, 11429,
  11398, 11367, 11336, 11305, 11275, 11245, 11215, 11185, 11155, 11125, 11096, 11067, 11038, 11009, 10980, 10951,
  10923, 10894, 10866, 10838, 10810, 10782, 10755, 10727, 10700, 10673, 10645, 10618, 10592, 10565, 10538, 10512,
  10486, 10460, 10434, 10408, 10382, 10356, 10331, 10305, 10280, 10255, 10230, 10205, 10180, 10156, 10131, 10107,
  10082, 10058, 10034, 10010, 9986, 9963, 9939, 9916, 9892, 9869, 9846, 9823, 9800, 9777, 9754, 9732,
  9709, 9687, 9664, 9642, 9620, 9598, 9576, 9554, 9533, 9511, 9489, 9468, 9447, 9425, 9404, 9383,
  9362, 9341, 9321, 9300, 9279, 9259, 9239, 9218, 9198, 9178, 9158, 9138, 9118, 9098, 9079, 9059,
  9039, 9020, 9001, 8981, 8962, 8943, 8924, 8905, 8886, 8867, 8849, 8830, 8812, 8793, 8775, 8756,
  8738, 8720, 8702, 8684, 8666, 8648, 8630, 8613, 8595, 8577, 8560, 8542, 8525, 8508, 8490, 8473,
  8456, 8439, 8422, 8405, 8389, 8372, 8355, 8339, 8322, 8306, 8289, 8273, 8257, 8240, 8224, 8208, 8192,
] as const

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

function roundSigned(value: number, shift: number): number {
  const magnitude = Math.floor((Math.abs(value) + 2 ** (shift - 1)) / 2 ** shift)
  return value < 0 ? -magnitude : magnitude
}

function shearParams(matrix: GlobalMotionParams['matrix']): [number, number, number, number] {
  const reduce = (value: number): number => Math.max(-32768, Math.min(32767, roundSigned(value, 6) * 64))
  const alpha = reduce(matrix[2] - 65536)
  const beta = reduce(matrix[3])
  const d = Math.abs(matrix[2])
  const log = Math.floor(Math.log2(d))
  const e = d - 2 ** log
  const f = log > 8 ? (e + 2 ** (log - 9)) >> (log - 8) : e << (8 - log)
  const divisor = (matrix[2] < 0 ? -1 : 1) * DIV_LUT[f]
  const shift = log + 14
  const gamma = reduce(roundSigned(matrix[4] * 65536 * divisor, shift))
  const delta = reduce(matrix[5] - roundSigned(matrix[3] * matrix[4] * divisor, shift) - 65536)
  return [alpha, beta, gamma, delta]
}

/** Normative AV1 affine warp predictor, evaluated in 8x8 blocks. */
export function warpAffine(
  dst: PixelPlane,
  dstStride: number,
  dstX: number,
  dstY: number,
  src: PixelPlane,
  srcStride: number,
  srcWidth: number,
  srcHeight: number,
  width: number,
  height: number,
  ssHor: number,
  ssVer: number,
  motion: GlobalMotionParams,
  bitDepth: number,
): void {
  const matrix = motion.matrix
  const [alpha, beta, gamma, delta] = shearParams(matrix)
  const intermediateBits = bitDepth === 12 ? 2 : 4
  const max = (1 << bitDepth) - 1
  const sample = (x: number, y: number): number => src[
    clip(y, srcHeight - 1) * srcStride + clip(x, srcWidth - 1)
  ]
  const coeff = (phase: number, tap: number): number => WARP_FILTER[phase * 8 + tap]

  for (let oy = 0; oy < height; oy += 8) {
    for (let ox = 0; ox < width; ox += 8) {
      const centerX = ((dstX + ox + 4) << ssHor)
      const centerY = ((dstY + oy + 4) << ssVer)
      const mvx = Math.floor((matrix[2] * centerX + matrix[3] * centerY + matrix[0]) / 2 ** ssHor)
      const mvy = Math.floor((matrix[4] * centerX + matrix[5] * centerY + matrix[1]) / 2 ** ssVer)
      const dx = Math.floor(mvx / 65536) - 4
      const dy = Math.floor(mvy / 65536) - 4
      const fracX = ((mvx % 65536) + 65536) % 65536
      const fracY = ((mvy % 65536) + 65536) % 65536
      const mx = (fracX - alpha * 4 - beta * 7) & ~63
      const my = (fracY - gamma * 4 - delta * 4) & ~63
      const mid = new Int32Array(15 * 8)
      const hShift = 7 - intermediateBits
      const hRound = 1 << (hShift - 1)
      for (let y = 0; y < 15; y++) {
        for (let x = 0; x < 8; x++) {
          const phase = 64 + ((mx + y * beta + x * alpha + 512) >> 10)
          let sum = 0
          for (let tap = 0; tap < 8; tap++) sum += coeff(phase, tap) * sample(dx + x + tap - 3, dy + y - 3)
          mid[y * 8 + x] = (sum + hRound) >> hShift
        }
      }
      const vShift = 7 + intermediateBits
      const vRound = 1 << (vShift - 1)
      for (let y = 0; y < Math.min(8, height - oy); y++) {
        for (let x = 0; x < Math.min(8, width - ox); x++) {
          const phase = 64 + ((my + y * delta + x * gamma + 512) >> 10)
          let sum = 0
          for (let tap = 0; tap < 8; tap++) sum += coeff(phase, tap) * mid[(y + tap) * 8 + x]
          dst[(dstY + oy + y) * dstStride + dstX + ox + x] = clip((sum + vRound) >> vShift, max)
        }
      }
    }
  }
}

/** AV1 film-grain synthesis (spec 7.18), ported from dav1d's scalar kernels. */
import type { FilmGrainParams } from './frame-header'
import type { SequenceHeader } from './sequence'
import { clamp } from './bits'
import { FrameBuffers } from './recon'
import { GAUSSIAN_SEQUENCE } from './film-grain-data'

const GRAIN_WIDTH = 82
const GRAIN_HEIGHT = 73
const BLOCK = 32

function round2(value: number, shift: number): number {
  return (value + ((1 << shift) >> 1)) >> shift
}

function random(bits: number, state: { value: number }): number {
  const bit = (state.value ^ state.value >> 1 ^ state.value >> 3 ^ state.value >> 12) & 1
  state.value = state.value >> 1 | bit << 15
  return state.value >> (16 - bits) & ((1 << bits) - 1)
}

function generateScaling(bitDepth: number, points: [number, number][]): Uint8Array {
  const shiftX = bitDepth - 8
  const size = 1 << bitDepth
  const scaling = new Uint8Array(size)
  if (!points.length)
    return scaling
  scaling.fill(points[0][1], 0, points[0][0] << shiftX)
  for (let i = 0; i + 1 < points.length; i++) {
    const [bx, by] = points[i]
    const [ex, ey] = points[i + 1]
    const dx = ex - bx
    const delta = (ey - by) * Math.floor((0x10000 + (dx >> 1)) / dx)
    for (let x = 0, d = 0x8000; x < dx; x++, d += delta)
      scaling[(bx + x) << shiftX] = by + (d >> 16)
  }
  const last = points[points.length - 1]
  scaling.fill(last[1], last[0] << shiftX)
  if (shiftX) {
    const pad = 1 << shiftX
    for (let i = 0; i + 1 < points.length; i++) {
      const bx = points[i][0] << shiftX
      const ex = points[i + 1][0] << shiftX
      for (let x = 0; x < ex - bx; x += pad) {
        const range = scaling[bx + x + pad] - scaling[bx + x]
        for (let n = 1, r = pad >> 1; n < pad; n++) {
          r += range
          scaling[bx + x + n] = scaling[bx + x] + (r >> shiftX)
        }
      }
    }
  }
  return scaling
}

function generateLumaGrain(data: FilmGrainParams, bitDepth: number): Int16Array {
  const out = new Int16Array((GRAIN_HEIGHT + 1) * GRAIN_WIDTH)
  const state = { value: data.seed }
  const depthShift = bitDepth - 8
  const shift = 4 - depthShift + data.grainScaleShift
  const min = -(128 << depthShift)
  const max = (128 << depthShift) - 1
  for (let y = 0; y < GRAIN_HEIGHT; y++) {
    for (let x = 0; x < GRAIN_WIDTH; x++)
      out[y * GRAIN_WIDTH + x] = round2(GAUSSIAN_SEQUENCE[random(11, state)], shift)
  }
  const lag = data.arCoeffLag
  for (let y = 3; y < GRAIN_HEIGHT; y++) {
    for (let x = 3; x < GRAIN_WIDTH - 3; x++) {
      let coefficient = 0
      let sum = 0
      outer: for (let dy = -lag; dy <= 0; dy++) {
        for (let dx = -lag; dx <= lag; dx++) {
          if (dx === 0 && dy === 0)
            break outer
          sum += data.arCoeffsY[coefficient++] * out[(y + dy) * GRAIN_WIDTH + x + dx]
        }
      }
      const offset = y * GRAIN_WIDTH + x
      out[offset] = clamp(out[offset] + round2(sum, data.arCoeffShift), min, max)
    }
  }
  return out
}

function generateChromaGrain(
  data: FilmGrainParams,
  luma: Int16Array,
  plane: 0 | 1,
  ssX: number,
  ssY: number,
  bitDepth: number,
): Int16Array {
  const out = new Int16Array((GRAIN_HEIGHT + 1) * GRAIN_WIDTH)
  const state = { value: data.seed ^ (plane ? 0x49D8 : 0xB524) }
  const depthShift = bitDepth - 8
  const shift = 4 - depthShift + data.grainScaleShift
  const min = -(128 << depthShift)
  const max = (128 << depthShift) - 1
  const width = ssX ? 44 : GRAIN_WIDTH
  const height = ssY ? 38 : GRAIN_HEIGHT
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++)
      out[y * GRAIN_WIDTH + x] = round2(GAUSSIAN_SEQUENCE[random(11, state)], shift)
  }
  const lag = data.arCoeffLag
  for (let y = 3; y < height; y++) {
    for (let x = 3; x < width - 3; x++) {
      let coefficient = 0
      let sum = 0
      outer: for (let dy = -lag; dy <= 0; dy++) {
        for (let dx = -lag; dx <= lag; dx++) {
          if (dx === 0 && dy === 0) {
            if (!data.yPoints.length)
              break outer
            const lx = (x - 3 << ssX) + 3
            const ly = (y - 3 << ssY) + 3
            let value = 0
            for (let iy = 0; iy <= ssY; iy++) {
              for (let ix = 0; ix <= ssX; ix++)
                value += luma[(ly + iy) * GRAIN_WIDTH + lx + ix]
            }
            sum += round2(value, ssX + ssY) * data.arCoeffsUv[plane][coefficient]
            break outer
          }
          sum += data.arCoeffsUv[plane][coefficient++] * out[(y + dy) * GRAIN_WIDTH + x + dx]
        }
      }
      const offset = y * GRAIN_WIDTH + x
      out[offset] = clamp(out[offset] + round2(sum, data.arCoeffShift), min, max)
    }
  }
  return out
}

function sample(
  lut: Int16Array,
  offsets: number[][],
  ssX: number,
  ssY: number,
  blockX: number,
  blockY: number,
  x: number,
  y: number,
): number {
  const value = offsets[blockX][blockY]
  const ox = 3 + (2 >> ssX) * (3 + (value >> 4))
  const oy = 3 + (2 >> ssY) * (3 + (value & 15))
  return lut[(oy + y + (BLOCK >> ssY) * blockY) * GRAIN_WIDTH
    + ox + x + (BLOCK >> ssX) * blockX]
}

function applyPlane(
  dst: Uint8Array | Uint16Array,
  src: Uint8Array | Uint16Array,
  stride: number,
  width: number,
  height: number,
  scaling: Uint8Array,
  lut: Int16Array,
  data: FilmGrainParams,
  bitDepth: number,
  ssX: number,
  ssY: number,
  luma: Uint8Array | Uint16Array | null,
  lumaStride: number,
  uv: 0 | 1,
  identity: boolean,
): void {
  const depthShift = bitDepth - 8
  const grainMin = -(128 << depthShift)
  const grainMax = (128 << depthShift) - 1
  const min = data.clipToRestrictedRange ? 16 << depthShift : 0
  const max = data.clipToRestrictedRange
    ? ((luma === null || identity) ? 235 : 240) << depthShift
    : (1 << bitDepth) - 1
  const rowHeight = BLOCK >> ssY
  const blockWidth = BLOCK >> ssX
  const weights = ssX ? [[23, 22], [23, 22]] : [[27, 17], [17, 27]]

  for (let row = 0; row * rowHeight < height; row++) {
    const bh = Math.min(rowHeight, height - row * rowHeight)
    const rows = data.overlap && row > 0 ? 2 : 1
    const states = Array.from({ length: rows }, (_, i) => ({
      value: data.seed
        ^ (((row - i) * 37 + 178) & 0xFF) << 8
        ^ (((row - i) * 173 + 105) & 0xFF),
    }))
    const offsets = [[0, 0], [0, 0]]
    for (let bx = 0; bx < width; bx += blockWidth) {
      const bw = Math.min(blockWidth, width - bx)
      if (data.overlap && bx) {
        for (let i = 0; i < rows; i++) offsets[1][i] = offsets[0][i]
      }
      for (let i = 0; i < rows; i++) offsets[0][i] = random(8, states[i])
      const yStart = data.overlap && row ? Math.min(2 >> ssY, bh) : 0
      const xStart = data.overlap && bx ? Math.min(2 >> ssX, bw) : 0

      const add = (x: number, y: number, grain: number): void => {
        const py = row * rowHeight + y
        const offset = py * stride + bx + x
        let value = src[offset]
        if (luma) {
          const lx = (bx + x) << ssX
          const ly = py << ssY
          let average = luma[ly * lumaStride + lx]
          if (ssX) average = (average + luma[ly * lumaStride + lx + 1] + 1) >> 1
          if (!data.chromaScalingFromLuma) {
            const combined = average * data.uvLumaMult[uv] + value * data.uvMult[uv]
            average = clamp((combined >> 6) + data.uvOffset[uv] * (1 << depthShift), 0, (1 << bitDepth) - 1)
          }
          value = average
        }
        const noise = round2(scaling[value] * grain, data.scalingShift)
        dst[offset] = clamp(src[offset] + noise, min, max)
      }
      for (let y = yStart; y < bh; y++) {
        for (let x = xStart; x < bw; x++) add(x, y, sample(lut, offsets, ssX, ssY, 0, 0, x, y))
        for (let x = 0; x < xStart; x++) {
          let grain = round2(sample(lut, offsets, ssX, ssY, 1, 0, x, y) * weights[x][0]
            + sample(lut, offsets, ssX, ssY, 0, 0, x, y) * weights[x][1], 5)
          grain = clamp(grain, grainMin, grainMax)
          add(x, y, grain)
        }
      }
      for (let y = 0; y < yStart; y++) {
        for (let x = xStart; x < bw; x++) {
          let grain = round2(sample(lut, offsets, ssX, ssY, 0, 1, x, y) * weights[y][0]
            + sample(lut, offsets, ssX, ssY, 0, 0, x, y) * weights[y][1], 5)
          add(x, y, clamp(grain, grainMin, grainMax))
        }
        for (let x = 0; x < xStart; x++) {
          let top = round2(sample(lut, offsets, ssX, ssY, 1, 1, x, y) * weights[x][0]
            + sample(lut, offsets, ssX, ssY, 0, 1, x, y) * weights[x][1], 5)
          let grain = round2(sample(lut, offsets, ssX, ssY, 1, 0, x, y) * weights[x][0]
            + sample(lut, offsets, ssX, ssY, 0, 0, x, y) * weights[x][1], 5)
          top = clamp(top, grainMin, grainMax)
          grain = clamp(grain, grainMin, grainMax)
          grain = round2(top * weights[y][0] + grain * weights[y][1], 5)
          add(x, y, clamp(grain, grainMin, grainMax))
        }
      }
    }
  }
}

/** Apply display-only grain to a copy of the fully filtered/upscaled frame. */
export function applyFilmGrain(
  source: FrameBuffers,
  seq: SequenceHeader,
  data: FilmGrainParams,
  width: number,
  height: number,
): FrameBuffers {
  const out = FrameBuffers.forDimensions(width, height, seq.subsamplingX, seq.subsamplingY, seq.monochrome, seq.bitDepth)
  out.y.set(source.y)
  out.u.set(source.u)
  out.v.set(source.v)
  const lumaLut = generateLumaGrain(data, seq.bitDepth)
  if (data.yPoints.length) {
    applyPlane(out.y, source.y, source.yStride, width, height, generateScaling(seq.bitDepth, data.yPoints),
      lumaLut, data, seq.bitDepth, 0, 0, null, 0, 0, false)
  }
  if (!seq.monochrome) {
    const cw = (width + seq.subsamplingX) >> seq.subsamplingX
    const ch = (height + seq.subsamplingY) >> seq.subsamplingY
    for (let plane = 0 as 0 | 1; plane < 2; plane++) {
      if (!data.uvPoints[plane].length && !data.chromaScalingFromLuma) continue
      const scaling = generateScaling(seq.bitDepth,
        data.chromaScalingFromLuma ? data.yPoints : data.uvPoints[plane])
      const lut = generateChromaGrain(data, lumaLut, plane, seq.subsamplingX, seq.subsamplingY, seq.bitDepth)
      applyPlane(plane ? out.v : out.u, plane ? source.v : source.u, source.uvStride, cw, ch,
        scaling, lut, data, seq.bitDepth, seq.subsamplingX, seq.subsamplingY,
        source.y, source.yStride, plane, seq.matrixCoefficients === 0)
    }
  }
  return out
}

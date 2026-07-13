/**
 * Intra prediction: edge preparation and all prediction kernels, ported from
 * dav1d's ipred_prepare_tmpl.c / ipred_tmpl.c (BSD-2-Clause, (c) VideoLAN and
 * dav1d authors), 8-bit only.
 *
 * The `edge` buffer mirrors dav1d's t->scratch.edge: the top-left sample sits
 * at `edgeOff`, the top row grows upward from edgeOff+1, and the left column
 * grows downward from edgeOff-1.
 */
import { clamp } from './bits'
import { IntraPredMode } from './consts'
import type { PixelPlane } from './pixels'
import { bitDepthMax, createPixelPlane, midSample } from './pixels'
import { DR_INTRA_DERIVATIVE, FILTER_INTRA_TAPS, SM_WEIGHTS } from './tables'

export const ANGLE_SMOOTH_EDGE_FLAG = 512
export const ANGLE_INTRA_EDGE_FILTER_FLAG = 1 << 10

const MODE_TO_ANGLE = [90, 180, 45, 135, 113, 157, 203, 67]

interface EdgeNeeds {
  left: boolean
  top: boolean
  topleft: boolean
  topright: boolean
  bottomleft: boolean
}

function needs(left = false, top = false, topleft = false, topright = false, bottomleft = false): EdgeNeeds {
  return { left, top, topleft, topright, bottomleft }
}

// indexed by implicit IntraPredMode (after mode conversion)
const EDGE_NEEDS: EdgeNeeds[] = [
  needs(true, true), // DC
  needs(false, true), // VERT
  needs(true), // HOR
  needs(true), // LEFT_DC
  needs(false, true), // TOP_DC
  needs(), // DC_128
  needs(false, true, true, true), // Z1
  needs(true, true, true), // Z2
  needs(true, false, true, false, true), // Z3
  needs(true, true), // SMOOTH
  needs(true, true), // SMOOTH_V
  needs(true, true), // SMOOTH_H
  needs(true, true, true), // PAETH
  needs(true, true, true), // FILTER
]

/**
 * Fill the edge buffer for one tx block and resolve the effective prediction
 * mode. Returns the implicit mode and (for directional modes) the updated
 * angle. x/y/w/h are in 4px block units of the current plane.
 */
export function prepareIntraEdges(
  x: number,
  haveLeft: boolean,
  y: number,
  haveTop: boolean,
  w: number,
  h: number,
  edgeFlags: number,
  plane: PixelPlane,
  dstOff: number,
  stride: number,
  mode: number,
  angleIn: number,
  tw: number,
  th: number,
  filterEdge: number,
  edge: PixelPlane,
  edgeOff: number,
  bitDepth = 8,
): { mode: number, angle: number } {
  let angle = angleIn
  const mid = midSample(bitDepth)

  if (mode >= IntraPredMode.VERT_PRED && mode <= IntraPredMode.VERT_LEFT_PRED) {
    angle = MODE_TO_ANGLE[mode - IntraPredMode.VERT_PRED] + 3 * angle
    if (angle <= 90)
      mode = angle < 90 && haveTop ? IntraPredMode.Z1_PRED : IntraPredMode.VERT_PRED
    else if (angle < 180)
      mode = IntraPredMode.Z2_PRED
    else
      mode = angle > 180 && haveLeft ? IntraPredMode.Z3_PRED : IntraPredMode.HOR_PRED
  }
  else if (mode === IntraPredMode.DC_PRED) {
    mode = haveLeft
      ? (haveTop ? IntraPredMode.DC_PRED : IntraPredMode.LEFT_DC_PRED)
      : (haveTop ? IntraPredMode.TOP_DC_PRED : IntraPredMode.DC_128_PRED)
  }
  else if (mode === IntraPredMode.PAETH_PRED) {
    mode = haveLeft
      ? (haveTop ? IntraPredMode.PAETH_PRED : IntraPredMode.HOR_PRED)
      : (haveTop ? IntraPredMode.VERT_PRED : IntraPredMode.DC_128_PRED)
  }

  const need = EDGE_NEEDS[mode]
  // position of the row above the block within the plane
  const topRow = dstOff - stride

  if (need.left) {
    const sz = th << 2
    const leftBase = edgeOff - sz
    if (haveLeft) {
      const pxHave = Math.min(sz, (h - y) << 2)
      for (let i = 0; i < pxHave; i++)
        edge[leftBase + sz - 1 - i] = plane[dstOff + stride * i - 1]
      if (pxHave < sz)
        edge.fill(edge[leftBase + sz - pxHave], leftBase, leftBase + sz - pxHave)
    }
    else {
      edge.fill(haveTop ? plane[topRow] : mid + 1, leftBase, leftBase + sz)
    }

    if (need.bottomleft) {
      const haveBottomLeft = (!haveLeft || y + th >= h)
        ? 0
        : (edgeFlags & 0x08 /* EDGE_I444_LEFT_HAS_BOTTOM */)
      if (haveBottomLeft) {
        const pxHave = Math.min(sz, (h - y - th) << 2)
        for (let i = 0; i < pxHave; i++)
          edge[leftBase - (i + 1)] = plane[dstOff + (sz + i) * stride - 1]
        if (pxHave < sz)
          edge.fill(edge[leftBase - pxHave], leftBase - sz, leftBase - pxHave)
      }
      else {
        edge.fill(edge[leftBase], leftBase - sz, leftBase)
      }
    }
  }

  if (need.top) {
    const sz = tw << 2
    const topBase = edgeOff + 1
    if (haveTop) {
      const pxHave = Math.min(sz, (w - x) << 2)
      for (let i = 0; i < pxHave; i++)
        edge[topBase + i] = plane[topRow + i]
      if (pxHave < sz)
        edge.fill(edge[topBase + pxHave - 1], topBase + pxHave, topBase + sz)
    }
    else {
      edge.fill(haveLeft ? plane[dstOff - 1] : mid - 1, topBase, topBase + sz)
    }

    if (need.topright) {
      const haveTopRight = (!haveTop || x + tw >= w)
        ? 0
        : (edgeFlags & 0x01 /* EDGE_I444_TOP_HAS_RIGHT */)
      if (haveTopRight) {
        const pxHave = Math.min(sz, (w - x - tw) << 2)
        for (let i = 0; i < pxHave; i++)
          edge[topBase + sz + i] = plane[topRow + sz + i]
        if (pxHave < sz)
          edge.fill(edge[topBase + sz + pxHave - 1], topBase + sz + pxHave, topBase + 2 * sz)
      }
      else {
        edge.fill(edge[topBase + sz - 1], topBase + sz, topBase + 2 * sz)
      }
    }
  }

  if (need.topleft) {
    if (haveLeft)
      edge[edgeOff] = haveTop ? plane[topRow - 1] : plane[dstOff - 1]
    else
      edge[edgeOff] = haveTop ? plane[topRow] : mid

    if (mode === IntraPredMode.Z2_PRED && tw + th >= 6 && filterEdge) {
      edge[edgeOff] = ((edge[edgeOff - 1] + edge[edgeOff + 1]) * 5
        + edge[edgeOff] * 6 + 8) >> 4
    }
  }

  return { mode, angle }
}

function clipPixel(v: number, max = 255): number {
  return v < 0 ? 0 : v > max ? max : v
}

function splatDc(dst: PixelPlane, off: number, stride: number, width: number, height: number, dc: number): void {
  for (let y = 0; y < height; y++)
    dst.fill(dc, off + y * stride, off + y * stride + width)
}

function ctz(v: number): number {
  return 31 - Math.clz32(v & -v)
}

function dcGenTop(edge: PixelPlane, o: number, width: number): number {
  let dc = width >> 1
  for (let i = 0; i < width; i++)
    dc += edge[o + 1 + i]
  return dc >> ctz(width)
}

function dcGenLeft(edge: PixelPlane, o: number, height: number): number {
  let dc = height >> 1
  for (let i = 0; i < height; i++)
    dc += edge[o - (1 + i)]
  return dc >> ctz(height)
}

function dcGen(edge: PixelPlane, o: number, width: number, height: number): number {
  let dc = (width + height) >> 1
  for (let i = 0; i < width; i++)
    dc += edge[o + i + 1]
  for (let i = 0; i < height; i++)
    dc += edge[o - (i + 1)]
  dc >>= ctz(width + height)
  if (width !== height) {
    dc *= (width > height * 2 || height > width * 2) ? 0x3334 : 0x5556
    dc >>= 16
  }
  return dc
}

function ipredPaeth(dst: PixelPlane, off: number, stride: number, edge: PixelPlane, o: number, width: number, height: number): void {
  const topleft = edge[o]
  for (let y = 0; y < height; y++) {
    const left = edge[o - (y + 1)]
    for (let x = 0; x < width; x++) {
      const top = edge[o + 1 + x]
      const base = left + top - topleft
      const ldiff = Math.abs(left - base)
      const tdiff = Math.abs(top - base)
      const tldiff = Math.abs(topleft - base)
      dst[off + y * stride + x] = ldiff <= tdiff && ldiff <= tldiff
        ? left
        : tdiff <= tldiff ? top : topleft
    }
  }
}

function ipredSmooth(dst: PixelPlane, off: number, stride: number, edge: PixelPlane, o: number, width: number, height: number): void {
  const right = edge[o + width]
  const bottom = edge[o - height]
  for (let y = 0; y < height; y++) {
    const wv = SM_WEIGHTS[height + y]
    for (let x = 0; x < width; x++) {
      const wh = SM_WEIGHTS[width + x]
      const pred = wv * edge[o + 1 + x] + (256 - wv) * bottom
        + wh * edge[o - (1 + y)] + (256 - wh) * right
      dst[off + y * stride + x] = (pred + 256) >> 9
    }
  }
}

function ipredSmoothV(dst: PixelPlane, off: number, stride: number, edge: PixelPlane, o: number, width: number, height: number): void {
  const bottom = edge[o - height]
  for (let y = 0; y < height; y++) {
    const wv = SM_WEIGHTS[height + y]
    for (let x = 0; x < width; x++) {
      const pred = wv * edge[o + 1 + x] + (256 - wv) * bottom
      dst[off + y * stride + x] = (pred + 128) >> 8
    }
  }
}

function ipredSmoothH(dst: PixelPlane, off: number, stride: number, edge: PixelPlane, o: number, width: number, height: number): void {
  const right = edge[o + width]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const wh = SM_WEIGHTS[width + x]
      const pred = wh * edge[o - (y + 1)] + (256 - wh) * right
      dst[off + y * stride + x] = (pred + 128) >> 8
    }
  }
}

function getFilterStrength(wh: number, angle: number, isSm: number): number {
  if (isSm) {
    if (wh <= 8) {
      if (angle >= 64)
        return 2
      if (angle >= 40)
        return 1
    }
    else if (wh <= 16) {
      if (angle >= 48)
        return 2
      if (angle >= 20)
        return 1
    }
    else if (wh <= 24) {
      if (angle >= 4)
        return 3
    }
    else {
      return 3
    }
  }
  else {
    if (wh <= 8) {
      if (angle >= 56)
        return 1
    }
    else if (wh <= 16) {
      if (angle >= 40)
        return 1
    }
    else if (wh <= 24) {
      if (angle >= 32)
        return 3
      if (angle >= 16)
        return 2
      if (angle >= 8)
        return 1
    }
    else if (wh <= 32) {
      if (angle >= 32)
        return 3
      if (angle >= 4)
        return 2
      return 1
    }
    else {
      return 3
    }
  }
  return 0
}

const EDGE_KERNELS = [
  [0, 4, 8, 4, 0],
  [0, 5, 6, 5, 0],
  [2, 4, 4, 4, 2],
]

/**
 * `inp` is accessed at signed indices [from, to); out gets sz samples.
 * Index helpers take (buffer, baseOffset) with signed relative indices.
 */
function filterEdgeFn(
  out: PixelPlane,
  outOff: number,
  sz: number,
  limFrom: number,
  limTo: number,
  inp: PixelPlane,
  inpOff: number,
  from: number,
  to: number,
  strength: number,
): void {
  const kernel = EDGE_KERNELS[strength - 1]
  let i = 0
  for (; i < Math.min(sz, limFrom); i++)
    out[outOff + i] = inp[inpOff + clamp(i, from, to - 1)]
  for (; i < Math.min(limTo, sz); i++) {
    let s = 0
    for (let j = 0; j < 5; j++)
      s += inp[inpOff + clamp(i - 2 + j, from, to - 1)] * kernel[j]
    out[outOff + i] = (s + 8) >> 4
  }
  for (; i < sz; i++)
    out[outOff + i] = inp[inpOff + clamp(i, from, to - 1)]
}

function getUpsample(wh: number, angle: number, isSm: number): number {
  return angle < 40 && wh <= (16 >> isSm) ? 1 : 0
}

const UPSAMPLE_KERNEL = [-1, 9, 9, -1]

function upsampleEdge(
  out: PixelPlane,
  outOff: number,
  hsz: number,
  inp: PixelPlane,
  inpOff: number,
  from: number,
  to: number,
  max: number,
): void {
  let i = 0
  for (; i < hsz - 1; i++) {
    out[outOff + i * 2] = inp[inpOff + clamp(i, from, to - 1)]
    let s = 0
    for (let j = 0; j < 4; j++)
      s += inp[inpOff + clamp(i + j - 1, from, to - 1)] * UPSAMPLE_KERNEL[j]
    out[outOff + i * 2 + 1] = clipPixel((s + 8) >> 4, max)
  }
  out[outOff + i * 2] = inp[inpOff + clamp(i, from, to - 1)]
}

function ipredZ1(dst: PixelPlane, off: number, stride: number, edge: PixelPlane, o: number, width: number, height: number, angleFl: number, max: number): void {
  const isSm = (angleFl >> 9) & 1
  const enableFilter = angleFl >> 10
  const angle = angleFl & 511
  let dx = DR_INTRA_DERIVATIVE[angle >> 1]
  const topOut = createPixelPlane(64 + 64, max > 255 ? 16 : 8)
  let top: PixelPlane
  let topOff: number
  let maxBaseX: number
  const upsampleAbove = enableFilter ? getUpsample(width + height, 90 - angle, isSm) : 0
  if (upsampleAbove) {
    upsampleEdge(topOut, 0, width + height, edge, o + 1, -1, width + Math.min(width, height), max)
    top = topOut
    topOff = 0
    maxBaseX = 2 * (width + height) - 2
    dx <<= 1
  }
  else {
    const strength = enableFilter ? getFilterStrength(width + height, 90 - angle, isSm) : 0
    if (strength) {
      filterEdgeFn(topOut, 0, width + height, 0, width + height, edge, o + 1, -1, width + Math.min(width, height), strength)
      top = topOut
      topOff = 0
      maxBaseX = width + height - 1
    }
    else {
      top = edge
      topOff = o + 1
      maxBaseX = width + Math.min(width, height) - 1
    }
  }
  const baseInc = 1 + upsampleAbove
  for (let y = 0, xpos = dx; y < height; y++, xpos += dx) {
    const frac = xpos & 0x3E
    for (let x = 0, base = xpos >> 6; x < width; x++, base += baseInc) {
      if (base < maxBaseX) {
        const v = top[topOff + base] * (64 - frac) + top[topOff + base + 1] * frac
        dst[off + y * stride + x] = (v + 32) >> 6
      }
      else {
        dst.fill(top[topOff + maxBaseX], off + y * stride + x, off + y * stride + width)
        break
      }
    }
  }
}

function ipredZ2(
  dst: PixelPlane,
  off: number,
  stride: number,
  edge: PixelPlane,
  o: number,
  width: number,
  height: number,
  angleFl: number,
  maxWidth: number,
  maxHeight: number,
  max: number,
): void {
  const isSm = (angleFl >> 9) & 1
  const enableFilter = angleFl >> 10
  const angle = angleFl & 511
  let dy = DR_INTRA_DERIVATIVE[(angle - 90) >> 1]
  let dx = DR_INTRA_DERIVATIVE[(180 - angle) >> 1]
  const upsampleLeft = enableFilter ? getUpsample(width + height, 180 - angle, isSm) : 0
  const upsampleAbove = enableFilter ? getUpsample(width + height, angle - 90, isSm) : 0
  const edgeBuf = createPixelPlane(64 + 64 + 1, max > 255 ? 16 : 8)
  const tl = 64

  if (upsampleAbove) {
    upsampleEdge(edgeBuf, tl, width + 1, edge, o, 0, width + 1, max)
    dx <<= 1
  }
  else {
    const strength = enableFilter ? getFilterStrength(width + height, angle - 90, isSm) : 0
    if (strength) {
      filterEdgeFn(edgeBuf, tl + 1, width, 0, maxWidth, edge, o + 1, -1, width, strength)
    }
    else {
      for (let i = 0; i < width; i++)
        edgeBuf[tl + 1 + i] = edge[o + 1 + i]
    }
  }
  if (upsampleLeft) {
    upsampleEdge(edgeBuf, tl - height * 2, height + 1, edge, o - height, 0, height + 1, max)
    dy <<= 1
  }
  else {
    const strength = enableFilter ? getFilterStrength(width + height, 180 - angle, isSm) : 0
    if (strength) {
      filterEdgeFn(edgeBuf, tl - height, height, height - maxHeight, height, edge, o - height, 0, height + 1, strength)
    }
    else {
      for (let i = 0; i < height; i++)
        edgeBuf[tl - height + i] = edge[o - height + i]
    }
  }
  edgeBuf[tl] = edge[o]

  const baseIncX = 1 + upsampleAbove
  const left = tl - (1 + upsampleLeft)
  for (let y = 0, xpos = ((1 + upsampleAbove) << 6) - dx; y < height; y++, xpos -= dx) {
    let baseX = xpos >> 6
    const fracX = xpos & 0x3E
    for (let x = 0, ypos = (y << (6 + upsampleLeft)) - dy; x < width; x++, baseX += baseIncX, ypos -= dy) {
      let v: number
      if (baseX >= 0) {
        v = edgeBuf[tl + baseX] * (64 - fracX) + edgeBuf[tl + baseX + 1] * fracX
      }
      else {
        const baseY = ypos >> 6
        const fracY = ypos & 0x3E
        v = edgeBuf[left - baseY] * (64 - fracY) + edgeBuf[left - (baseY + 1)] * fracY
      }
      dst[off + y * stride + x] = (v + 32) >> 6
    }
  }
}

function ipredZ3(dst: PixelPlane, off: number, stride: number, edge: PixelPlane, o: number, width: number, height: number, angleFl: number, max: number): void {
  const isSm = (angleFl >> 9) & 1
  const enableFilter = angleFl >> 10
  const angle = angleFl & 511
  let dy = DR_INTRA_DERIVATIVE[(270 - angle) >> 1]
  const leftOut = createPixelPlane(64 + 64, max > 255 ? 16 : 8)
  let left: PixelPlane
  let leftOff: number
  let maxBaseY: number
  const upsampleLeft = enableFilter ? getUpsample(width + height, angle - 180, isSm) : 0
  if (upsampleLeft) {
    upsampleEdge(leftOut, 0, width + height, edge, o - (width + height), Math.max(width - height, 0), width + height + 1, max)
    left = leftOut
    leftOff = 2 * (width + height) - 2
    maxBaseY = 2 * (width + height) - 2
    dy <<= 1
  }
  else {
    const strength = enableFilter ? getFilterStrength(width + height, angle - 180, isSm) : 0
    if (strength) {
      filterEdgeFn(leftOut, 0, width + height, 0, width + height, edge, o - (width + height), Math.max(width - height, 0), width + height + 1, strength)
      left = leftOut
      leftOff = width + height - 1
      maxBaseY = width + height - 1
    }
    else {
      left = edge
      leftOff = o - 1
      maxBaseY = height + Math.min(width, height) - 1
    }
  }
  const baseInc = 1 + upsampleLeft
  for (let x = 0, ypos = dy; x < width; x++, ypos += dy) {
    const frac = ypos & 0x3E
    for (let y = 0, base = ypos >> 6; y < height; y++, base += baseInc) {
      if (base < maxBaseY) {
        const v = left[leftOff - base] * (64 - frac) + left[leftOff - (base + 1)] * frac
        dst[off + y * stride + x] = (v + 32) >> 6
      }
      else {
        for (; y < height; y++)
          dst[off + y * stride + x] = left[leftOff - maxBaseY]
        break
      }
    }
  }
}

/** FILTER_PRED, up to 32x32; filt_idx in the low bits of the angle arg. */
function ipredFilter(dst: PixelPlane, off: number, stride: number, edge: PixelPlane, o: number, width: number, height: number, filtIdxFl: number, max: number): void {
  const filtIdx = filtIdxFl & 511
  const fBase = filtIdx * 64
  let topBuf: PixelPlane = edge
  let topOff = o + 1
  let dstRow = off
  for (let y = 0; y < height; y += 2) {
    let topleftBuf: PixelPlane = edge
    let topleftOff = o - y
    let leftBuf: PixelPlane = topleftBuf
    let leftOff = topleftOff - 1
    let leftStride = -1
    let top = topOff
    for (let x = 0; x < width; x += 4) {
      const p0 = topleftBuf[topleftOff]
      const p1 = topBuf[top]
      const p2 = topBuf[top + 1]
      const p3 = topBuf[top + 2]
      const p4 = topBuf[top + 3]
      const p5 = leftBuf[leftOff]
      const p6 = leftBuf[leftOff + leftStride]
      let ptr = dstRow + x
      let flt = fBase
      for (let yy = 0; yy < 2; yy++) {
        for (let xx = 0; xx < 4; xx++, flt++) {
          const acc = FILTER_INTRA_TAPS[flt] * p0
            + FILTER_INTRA_TAPS[flt + 8] * p1
            + FILTER_INTRA_TAPS[flt + 16] * p2
            + FILTER_INTRA_TAPS[flt + 24] * p3
            + FILTER_INTRA_TAPS[flt + 32] * p4
            + FILTER_INTRA_TAPS[flt + 40] * p5
            + FILTER_INTRA_TAPS[flt + 48] * p6
          dst[ptr + xx] = clipPixel((acc + 8) >> 4, max)
        }
        ptr += stride
      }
      leftBuf = dst
      leftOff = dstRow + x + 4 - 1
      leftStride = stride
      top += 4
      topleftBuf = topBuf
      topleftOff = top - 1
    }
    topBuf = dst
    topOff = dstRow + stride
    dstRow += stride * 2
  }
}

/**
 * Dispatch one intra prediction. `mode` is the implicit mode returned by
 * prepareIntraEdges; angleFl carries the angle plus smoothness/filter flags.
 */
export function intraPred(
  mode: number,
  dst: PixelPlane,
  off: number,
  stride: number,
  edge: PixelPlane,
  o: number,
  width: number,
  height: number,
  angleFl: number,
  maxWidth: number,
  maxHeight: number,
  bitDepth = 8,
): void {
  const max = bitDepthMax(bitDepth)
  switch (mode) {
    case IntraPredMode.DC_PRED:
      splatDc(dst, off, stride, width, height, dcGen(edge, o, width, height))
      break
    case IntraPredMode.DC_128_PRED:
      splatDc(dst, off, stride, width, height, midSample(bitDepth))
      break
    case IntraPredMode.TOP_DC_PRED:
      splatDc(dst, off, stride, width, height, dcGenTop(edge, o, width))
      break
    case IntraPredMode.LEFT_DC_PRED:
      splatDc(dst, off, stride, width, height, dcGenLeft(edge, o, height))
      break
    case IntraPredMode.HOR_PRED:
      for (let y = 0; y < height; y++)
        dst.fill(edge[o - (1 + y)], off + y * stride, off + y * stride + width)
      break
    case IntraPredMode.VERT_PRED:
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++)
          dst[off + y * stride + x] = edge[o + 1 + x]
      }
      break
    case IntraPredMode.PAETH_PRED:
      ipredPaeth(dst, off, stride, edge, o, width, height)
      break
    case IntraPredMode.SMOOTH_PRED:
      ipredSmooth(dst, off, stride, edge, o, width, height)
      break
    case IntraPredMode.SMOOTH_V_PRED:
      ipredSmoothV(dst, off, stride, edge, o, width, height)
      break
    case IntraPredMode.SMOOTH_H_PRED:
      ipredSmoothH(dst, off, stride, edge, o, width, height)
      break
    case IntraPredMode.Z1_PRED:
      ipredZ1(dst, off, stride, edge, o, width, height, angleFl, max)
      break
    case IntraPredMode.Z2_PRED:
      ipredZ2(dst, off, stride, edge, o, width, height, angleFl, maxWidth, maxHeight, max)
      break
    case IntraPredMode.Z3_PRED:
      ipredZ3(dst, off, stride, edge, o, width, height, angleFl, max)
      break
    case IntraPredMode.FILTER_PRED:
      ipredFilter(dst, off, stride, edge, o, width, height, angleFl, max)
      break
    default:
      throw new Error(`ts-avif: unknown intra prediction mode ${mode}`)
  }
}

/** Chroma-from-luma AC buffer: subsampled, DC-subtracted luma (cfl_ac_c). */
export function cflAc(
  ac: Int16Array,
  yPlane: PixelPlane,
  yOff: number,
  stride: number,
  wPad: number,
  hPad: number,
  width: number,
  height: number,
  ssHor: number,
  ssVer: number,
): void {
  let pos = 0
  let src = yOff
  let y = 0
  for (y = 0; y < height - 4 * hPad; y++) {
    for (let x = 0; x < width - 4 * wPad; x++) {
      let sum = yPlane[src + (x << ssHor)]
      if (ssHor)
        sum += yPlane[src + x * 2 + 1]
      if (ssVer) {
        sum += yPlane[src + (x << ssHor) + stride]
        if (ssHor)
          sum += yPlane[src + x * 2 + 1 + stride]
      }
      ac[pos + x] = sum << (1 + (ssVer ? 0 : 1) + (ssHor ? 0 : 1))
    }
    for (let x = width - 4 * wPad; x < width; x++)
      ac[pos + x] = ac[pos + x - 1]
    pos += width
    src += stride << ssVer
  }
  for (; y < height; y++) {
    for (let x = 0; x < width; x++)
      ac[pos + x] = ac[pos + x - width]
    pos += width
  }

  const log2sz = ctz(width) + ctz(height)
  let sum = (1 << log2sz) >> 1
  for (let i = 0; i < width * height; i++)
    sum += ac[i]
  sum >>= log2sz
  for (let i = 0; i < width * height; i++)
    ac[i] -= sum
}

/** CFL prediction: DC prediction modulated by the AC buffer (cfl_pred). */
export function cflPred(
  mode: number,
  dst: PixelPlane,
  off: number,
  stride: number,
  edge: PixelPlane,
  o: number,
  width: number,
  height: number,
  ac: Int16Array,
  alpha: number,
  bitDepth = 8,
): void {
  let dc: number
  switch (mode) {
    case IntraPredMode.DC_PRED:
      dc = dcGen(edge, o, width, height)
      break
    case IntraPredMode.DC_128_PRED:
      dc = midSample(bitDepth)
      break
    case IntraPredMode.TOP_DC_PRED:
      dc = dcGenTop(edge, o, width)
      break
    case IntraPredMode.LEFT_DC_PRED:
      dc = dcGenLeft(edge, o, height)
      break
    default:
      throw new Error(`ts-avif: invalid CFL prediction mode ${mode}`)
  }
  let acPos = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const diff = alpha * ac[acPos + x]
      const adj = (Math.abs(diff) + 32) >> 6
      dst[off + y * stride + x] = clipPixel(dc + (diff < 0 ? -adj : adj), bitDepthMax(bitDepth))
    }
    acPos += width
  }
}

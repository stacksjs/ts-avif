/**
 * AV1 uncompressed frame header parsing (spec 5.9), for the intra/still-image
 * path. Inter frames are rejected with a clear error - AVIF stills are always
 * KEY_FRAME or INTRA_ONLY_FRAME.
 */
import type { SequenceHeader } from './sequence'
import { BitReader, clamp } from './bits'
import { SELECT_INTEGER_MV, SELECT_SCREEN_CONTENT_TOOLS } from './sequence'

export const FrameType = {
  KEY: 0,
  INTER: 1,
  INTRA_ONLY: 2,
  SWITCH: 3,
} as const

const PRIMARY_REF_NONE = 7
const MAX_TILE_WIDTH = 4096
const MAX_TILE_AREA = 4096 * 2304
const MAX_TILE_COLS = 64
const MAX_TILE_ROWS = 64
const MAX_SEGMENTS = 8
export const SEG_LVL_ALT_Q = 0
export const SEG_LVL_MAX = 8

const SEGMENTATION_FEATURE_BITS = [8, 6, 6, 6, 6, 3, 0, 0]
const SEGMENTATION_FEATURE_SIGNED = [1, 1, 1, 1, 1, 0, 0, 0]
const SEGMENTATION_FEATURE_MAX = [255, 63, 63, 63, 63, 7, 0, 0]

export const TxModes = {
  ONLY_4X4: 0,
  LARGEST: 1,
  SELECT: 2,
} as const

export const RestorationType = {
  NONE: 0,
  WIENER: 1,
  SGRPROJ: 2,
  SWITCHABLE: 3,
} as const

export interface TileInfo {
  tileColsLog2: number
  tileRowsLog2: number
  tileCols: number
  tileRows: number
  /** Mi column boundaries, length tileCols + 1. */
  miColStarts: number[]
  /** Mi row boundaries, length tileRows + 1. */
  miRowStarts: number[]
  contextUpdateTileId: number
  tileSizeBytes: number
}

export interface QuantizationParams {
  baseQIdx: number
  deltaQYDc: number
  deltaQUDc: number
  deltaQUAc: number
  deltaQVDc: number
  deltaQVAc: number
  usingQMatrix: boolean
  qmY: number
  qmU: number
  qmV: number
}

export interface SegmentationParams {
  enabled: boolean
  updateMap: boolean
  temporalUpdate: boolean
  updateData: boolean
  /** [segment][feature] */
  featureEnabled: boolean[][]
  featureData: number[][]
  segIdPreSkip: boolean
  lastActiveSegId: number
}

export interface LoopFilterParams {
  levels: [number, number, number, number]
  sharpness: number
  deltaEnabled: boolean
  refDeltas: number[]
  modeDeltas: number[]
}

export interface CdefParams {
  damping: number
  bits: number
  yPriStrength: number[]
  ySecStrength: number[]
  uvPriStrength: number[]
  uvSecStrength: number[]
}

export interface LrParams {
  /** Per-plane restoration type. */
  frameRestorationType: number[]
  usesLr: boolean
  usesChromaLr: boolean
  /** Loop restoration unit size per plane (in pixels). */
  loopRestorationSize: number[]
}

export interface FilmGrainParams {
  seed: number
  yPoints: [number, number][]
  chromaScalingFromLuma: boolean
  uvPoints: [[number, number][], [number, number][]]
  scalingShift: number
  arCoeffLag: number
  arCoeffsY: number[]
  arCoeffsUv: [number[], number[]]
  arCoeffShift: number
  grainScaleShift: number
  uvMult: [number, number]
  uvLumaMult: [number, number]
  uvOffset: [number, number]
  overlap: boolean
  clipToRestrictedRange: boolean
}

export interface GlobalMotionParams {
  /** 0 identity, 1 translation, 2 rotzoom, 3 affine. */
  type: number
  /** AV1 warped-model parameters at 16-bit model precision. */
  matrix: [number, number, number, number, number, number]
}

export interface FrameHeader {
  showExistingFrame: boolean
  existingFrameIdx: number
  frameType: number
  showFrame: boolean
  showableFrame: boolean
  errorResilientMode: boolean
  disableCdfUpdate: boolean
  allowScreenContentTools: boolean
  forceIntegerMv: boolean
  frameSizeOverride: boolean
  orderHint: number
  primaryRefFrame: number
  refreshFrameFlags: number
  frameWidth: number
  frameHeight: number
  upscaledWidth: number
  superresDenom: number
  renderWidth: number
  renderHeight: number
  miCols: number
  miRows: number
  allowIntrabc: boolean
  disableFrameEndUpdateCdf: boolean
  tileInfo: TileInfo
  quantization: QuantizationParams
  segmentation: SegmentationParams
  deltaQPresent: boolean
  deltaQRes: number
  deltaLfPresent: boolean
  deltaLfRes: number
  deltaLfMulti: boolean
  codedLossless: boolean
  allLossless: boolean
  /** Per-segment lossless flag. */
  losslessArray: boolean[]
  /** Per-segment effective base qindex. */
  segQIndex: number[]
  loopFilter: LoopFilterParams
  cdef: CdefParams
  lr: LrParams
  txMode: number
  reducedTxSet: boolean
  filmGrain: FilmGrainParams | null
  refFrameIdx: number[]
  allowHighPrecisionMv: boolean
  interpolationFilter: number
  isMotionModeSwitchable: boolean
  useRefFrameMvs: boolean
  referenceSelect: boolean
  skipModePresent: boolean
  skipModeRefs: [number, number]
  allowWarpedMotion: boolean
  globalMotion: GlobalMotionParams[]
}

export interface FrameHeaderState {
  refs: Array<FrameHeader | null>
}

function tileLog2(blkSize: number, target: number): number {
  let k = 0
  while ((blkSize << k) < target)
    k++
  return k
}

/** get_qindex for a segment at frame level (no delta-q lookup). */
export function getQIndex(seg: SegmentationParams, baseQIdx: number, segmentId: number): number {
  if (seg.enabled && seg.featureEnabled[segmentId][SEG_LVL_ALT_Q]) {
    const data = seg.featureData[segmentId][SEG_LVL_ALT_Q]
    return clamp(baseQIdx + data, 0, 255)
  }
  return baseQIdx
}

function readDeltaQ(r: BitReader): number {
  return r.readBit() === 1 ? r.su(7) : 0
}

/**
 * Parse the uncompressed header from `r`. The reader is left positioned just
 * after the header bits (call `byteAlign()` before reading tile group data
 * when parsing a FRAME OBU).
 */
export function parseFrameHeader(r: BitReader, seq: SequenceHeader, state?: FrameHeaderState): FrameHeader {
  let frameType: number = FrameType.KEY
  let showFrame = true
  let showableFrame = false
  let errorResilientMode = false

  const idLen = seq.frameIdNumbersPresent
    ? seq.additionalFrameIdLength + seq.deltaFrameIdLength
    : 0

  let showExistingFrame = false
  let existingFrameIdx = -1
  if (!seq.reducedStillPictureHeader) {
    showExistingFrame = r.readBit() === 1
    if (showExistingFrame) {
      existingFrameIdx = r.readBits(3)
      if (seq.decoderModelInfoPresent && !seq.equalPictureInterval)
        r.readBits(seq.framePresentationTimeLength)
      if (seq.frameIdNumbersPresent) r.readBits(idLen)
      const reference = state?.refs[existingFrameIdx]
      if (!reference)
        throw new Error(`ts-avif: show_existing_frame references unavailable slot ${existingFrameIdx}`)
      return { ...reference, showExistingFrame: true, existingFrameIdx }
    }
    frameType = r.readBits(2)
    showFrame = r.readBit() === 1
    if (showFrame && seq.decoderModelInfoPresent && !seq.equalPictureInterval)
      r.readBits(seq.framePresentationTimeLength) // frame_presentation_time
    if (showFrame)
      showableFrame = frameType !== FrameType.KEY
    else
      showableFrame = r.readBit() === 1
    if (frameType === FrameType.SWITCH || (frameType === FrameType.KEY && showFrame))
      errorResilientMode = true
    else
      errorResilientMode = r.readBit() === 1
  }

  const frameIsIntra = frameType === FrameType.KEY || frameType === FrameType.INTRA_ONLY
  const disableCdfUpdate = r.readBit() === 1

  const allowScreenContentTools = seq.seqForceScreenContentTools === SELECT_SCREEN_CONTENT_TOOLS
    ? r.readBit() === 1
    : seq.seqForceScreenContentTools === 1
  let forceIntegerMv = false
  if (allowScreenContentTools)
    forceIntegerMv = seq.seqForceIntegerMv === SELECT_INTEGER_MV ? r.readBit() === 1 : seq.seqForceIntegerMv === 1
  if (frameIsIntra) forceIntegerMv = true

  if (seq.frameIdNumbersPresent)
    r.readBits(idLen) // current_frame_id

  let frameSizeOverride = false
  if (frameType === FrameType.SWITCH)
    frameSizeOverride = true
  else if (!seq.reducedStillPictureHeader)
    frameSizeOverride = r.readBit() === 1

  const orderHint = r.readBits(seq.orderHintBits)
  const primaryRefFrame = !frameIsIntra && !errorResilientMode ? r.readBits(3) : PRIMARY_REF_NONE

  if (seq.decoderModelInfoPresent) {
    const bufferRemovalTimePresent = r.readBit() === 1
    if (bufferRemovalTimePresent) {
      for (const op of seq.operatingPoints) {
        if (op.decoderModelPresent)
          r.readBits(seq.bufferRemovalTimeLength) // buffer_removal_time
      }
    }
  }

  const refreshFrameFlags = frameType === FrameType.SWITCH || (frameType === FrameType.KEY && showFrame)
    ? 0xFF
    : r.readBits(8)

  if (refreshFrameFlags !== 0xFF && errorResilientMode && seq.enableOrderHint) {
    for (let i = 0; i < 8; i++)
      r.readBits(seq.orderHintBits) // ref_order_hint
  }

  const refFrameIdx: number[] = []
  if (!frameIsIntra) {
    const shortSignaling = seq.enableOrderHint && r.readBit() === 1
    if (shortSignaling) {
      const lastFrameIdx = r.readBits(3)
      const goldFrameIdx = r.readBits(3)
      refFrameIdx.push(...setFrameRefs(state, orderHint, seq.orderHintBits, lastFrameIdx, goldFrameIdx))
    }
    for (let i = 0; i < 7; i++) {
      if (!shortSignaling) refFrameIdx.push(r.readBits(3))
      if (seq.frameIdNumbersPresent) r.readBits(seq.deltaFrameIdLength)
      if (!state?.refs[refFrameIdx[i]])
        throw new Error(`ts-avif: inter frame references unavailable slot ${refFrameIdx[i]}`)
    }
  }

  // frame_size() / frame_size_with_refs() + render_size()
  let frameWidth: number
  let frameHeight: number
  let inherited: FrameHeader | null = null
  if (!frameIsIntra && !errorResilientMode && frameSizeOverride) {
    for (let i = 0; i < 7; i++) {
      if (r.readBit() === 1) {
        inherited = state!.refs[refFrameIdx[i]]
        break
      }
    }
  }
  if (inherited) {
    frameWidth = inherited.upscaledWidth
    frameHeight = inherited.frameHeight
  }
  else if (frameSizeOverride) {
    frameWidth = r.readBits(seq.frameWidthBits) + 1
    frameHeight = r.readBits(seq.frameHeightBits) + 1
  }
  else {
    frameWidth = seq.maxFrameWidth
    frameHeight = seq.maxFrameHeight
  }

  // superres_params()
  let superresDenom = 8
  if (seq.enableSuperres && r.readBit() === 1)
    superresDenom = r.readBits(3) + 9
  const upscaledWidth = frameWidth
  frameWidth = Math.floor((upscaledWidth * 8 + Math.floor(superresDenom / 2)) / superresDenom)

  // compute_image_size()
  const miCols = 2 * ((frameWidth + 7) >> 3)
  const miRows = 2 * ((frameHeight + 7) >> 3)

  // render_size() is inherited together with dimensions.
  let renderWidth = inherited?.renderWidth ?? upscaledWidth
  let renderHeight = inherited?.renderHeight ?? frameHeight
  if (!inherited && r.readBit() === 1) {
    renderWidth = r.readBits(16) + 1
    renderHeight = r.readBits(16) + 1
  }

  let allowIntrabc = false
  if (frameIsIntra && allowScreenContentTools && upscaledWidth === frameWidth)
    allowIntrabc = r.readBit() === 1

  let allowHighPrecisionMv = false
  let interpolationFilter = 4 // SWITCHABLE
  let isMotionModeSwitchable = false
  let useRefFrameMvs = false
  if (!frameIsIntra) {
    if (!forceIntegerMv) allowHighPrecisionMv = r.readBit() === 1
    interpolationFilter = r.readBit() === 1 ? 4 : r.readBits(2)
    isMotionModeSwitchable = r.readBit() === 1
    if (!errorResilientMode && seq.enableRefFrameMvs && seq.enableOrderHint)
      useRefFrameMvs = r.readBit() === 1
  }

  const disableFrameEndUpdateCdf
    = seq.reducedStillPictureHeader || disableCdfUpdate ? true : r.readBit() === 1

  const tileInfo = parseTileInfo(r, seq, miCols, miRows)
  const quantization = parseQuantizationParams(r, seq)
  const segmentation = parseSegmentationParams(r)

  // delta_q_params()
  let deltaQPresent = false
  let deltaQRes = 0
  if (quantization.baseQIdx > 0)
    deltaQPresent = r.readBit() === 1
  if (deltaQPresent)
    deltaQRes = r.readBits(2)

  // delta_lf_params()
  let deltaLfPresent = false
  let deltaLfRes = 0
  let deltaLfMulti = false
  if (deltaQPresent) {
    if (!allowIntrabc)
      deltaLfPresent = r.readBit() === 1
    if (deltaLfPresent) {
      deltaLfRes = r.readBits(2)
      deltaLfMulti = r.readBit() === 1
    }
  }

  // Lossless derivation
  const losslessArray: boolean[] = []
  const segQIndex: number[] = []
  let codedLossless = true
  for (let segmentId = 0; segmentId < MAX_SEGMENTS; segmentId++) {
    const qindex = getQIndex(segmentation, quantization.baseQIdx, segmentId)
    segQIndex.push(qindex)
    const lossless = qindex === 0
      && quantization.deltaQYDc === 0
      && quantization.deltaQUAc === 0 && quantization.deltaQUDc === 0
      && quantization.deltaQVAc === 0 && quantization.deltaQVDc === 0
    losslessArray.push(lossless)
    if (!lossless)
      codedLossless = false
  }
  const allLossless = codedLossless && frameWidth === upscaledWidth

  const loopFilter = parseLoopFilterParams(r, seq, codedLossless, allowIntrabc)
  const cdef = parseCdefParams(r, seq, codedLossless, allowIntrabc)
  const lr = parseLrParams(r, seq, allLossless, allowIntrabc)

  // read_tx_mode()
  let txMode: number = TxModes.ONLY_4X4
  if (!codedLossless)
    txMode = r.readBit() === 1 ? TxModes.SELECT : TxModes.LARGEST

  const referenceSelect = !frameIsIntra && r.readBit() === 1
  const skipModeRefs: [number, number] = [-1, -1]
  let skipModePresent = false
  if (!frameIsIntra && seq.enableOrderHint) {
    const candidates = refFrameIdx.map((slot, index) => ({
      index,
      distance: relativeDistance(state!.refs[slot]!.orderHint, orderHint, seq.orderHintBits),
    }))
    const forward = candidates.filter(item => item.distance < 0).sort((a, b) => b.distance - a.distance)
    const backward = candidates.filter(item => item.distance > 0).sort((a, b) => a.distance - b.distance)
    if (forward.length && backward.length) {
      skipModeRefs[0] = Math.min(forward[0].index, backward[0].index)
      skipModeRefs[1] = Math.max(forward[0].index, backward[0].index)
    }
    else if (forward.length > 1) {
      // Aliases of the same reference slot/order hint do not count as the
      // second forward reference required to enable skip mode.
      const second = forward.find(item => item.distance < forward[0].distance)
      if (second) {
        skipModeRefs[0] = Math.min(forward[0].index, second.index)
        skipModeRefs[1] = Math.max(forward[0].index, second.index)
      }
    }
    if (skipModeRefs[0] >= 0) skipModePresent = r.readBit() === 1
  }
  const allowWarpedMotion = !frameIsIntra && !errorResilientMode && seq.enableWarpedMotion
    ? r.readBit() === 1
    : false

  const reducedTxSet = r.readBit() === 1

  const identityMotion = (): GlobalMotionParams => ({
    type: 0,
    matrix: [0, 0, 65536, 0, 0, 65536],
  })
  const primaryHeader = primaryRefFrame < 7
    ? state?.refs[refFrameIdx[primaryRefFrame]]
    : null
  const globalMotion: GlobalMotionParams[] = []
  if (!frameIsIntra) {
    for (let ref = 0; ref < 7; ref++)
      globalMotion.push(readGlobalMotion(r, primaryHeader?.globalMotion[ref] ?? identityMotion(), allowHighPrecisionMv))
  }
  else {
    for (let ref = 0; ref < 7; ref++) globalMotion.push(identityMotion())
  }
  // film_grain_params(); intra frames always carry a fresh parameter set.
  let filmGrain: FilmGrainParams | null = null
  if (seq.filmGrainParamsPresent && (showFrame || showableFrame)) {
    const applyGrain = r.readBit() === 1
    if (applyGrain) {
      const seed = r.readBits(16)
      const yPoints = readGrainPoints(r, 14)
      const chromaScalingFromLuma = !seq.monochrome && r.readBit() === 1
      const uvPoints: [[number, number][], [number, number][]] = [[], []]
      const omitUvPoints = seq.monochrome || chromaScalingFromLuma
        || (seq.subsamplingX === 1 && seq.subsamplingY === 1 && yPoints.length === 0)
      if (!omitUvPoints) {
        uvPoints[0] = readGrainPoints(r, 10)
        uvPoints[1] = readGrainPoints(r, 10)
      }
      if (seq.subsamplingX === 1 && seq.subsamplingY === 1
        && (uvPoints[0].length === 0) !== (uvPoints[1].length === 0)) {
        throw new Error('ts-avif: invalid 4:2:0 film-grain chroma point sets')
      }
      const scalingShift = r.readBits(2) + 8
      const arCoeffLag = r.readBits(2)
      const numYPos = 2 * arCoeffLag * (arCoeffLag + 1)
      const arCoeffsY = yPoints.length ? readSignedGrainCoeffs(r, numYPos) : []
      const arCoeffsUv: [number[], number[]] = [[], []]
      for (let plane = 0; plane < 2; plane++) {
        if (uvPoints[plane].length || chromaScalingFromLuma)
          arCoeffsUv[plane] = readSignedGrainCoeffs(r, numYPos + (yPoints.length ? 1 : 0))
      }
      const arCoeffShift = r.readBits(2) + 6
      const grainScaleShift = r.readBits(2)
      const uvMult: [number, number] = [0, 0]
      const uvLumaMult: [number, number] = [0, 0]
      const uvOffset: [number, number] = [0, 0]
      for (let plane = 0; plane < 2; plane++) {
        if (uvPoints[plane].length) {
          uvMult[plane] = r.readBits(8) - 128
          uvLumaMult[plane] = r.readBits(8) - 128
          uvOffset[plane] = r.readBits(9) - 256
        }
      }
      filmGrain = {
        seed,
        yPoints,
        chromaScalingFromLuma,
        uvPoints,
        scalingShift,
        arCoeffLag,
        arCoeffsY,
        arCoeffsUv,
        arCoeffShift,
        grainScaleShift,
        uvMult,
        uvLumaMult,
        uvOffset,
        overlap: r.readBit() === 1,
        clipToRestrictedRange: r.readBit() === 1,
      }
    }
  }

  return {
    showExistingFrame,
    existingFrameIdx,
    frameType,
    showFrame,
    showableFrame,
    errorResilientMode,
    disableCdfUpdate,
    allowScreenContentTools,
    forceIntegerMv,
    frameSizeOverride,
    orderHint,
    primaryRefFrame,
    refreshFrameFlags,
    frameWidth,
    frameHeight,
    upscaledWidth,
    superresDenom,
    renderWidth,
    renderHeight,
    miCols,
    miRows,
    allowIntrabc,
    disableFrameEndUpdateCdf,
    tileInfo,
    quantization,
    segmentation,
    deltaQPresent,
    deltaQRes,
    deltaLfPresent,
    deltaLfRes,
    deltaLfMulti,
    codedLossless,
    allLossless,
    losslessArray,
    segQIndex,
    loopFilter,
    cdef,
    lr,
    txMode,
    reducedTxSet,
    filmGrain,
    refFrameIdx,
    allowHighPrecisionMv,
    interpolationFilter,
    isMotionModeSwitchable,
    useRefFrameMvs,
    referenceSelect,
    skipModePresent,
    skipModeRefs,
    allowWarpedMotion,
    globalMotion,
  }
}

function relativeDistance(a: number, b: number, bits: number): number {
  if (!bits) return 0
  const modulus = 1 << bits
  const diff = (a - b) & (modulus - 1)
  return diff & (modulus >> 1) ? diff - modulus : diff
}

function setFrameRefs(
  state: FrameHeaderState | undefined,
  orderHint: number,
  orderHintBits: number,
  lastFrameIdx: number,
  goldFrameIdx: number,
): number[] {
  if (!state) throw new Error('ts-avif: short reference signaling requires reference state')
  const center = 1 << (orderHintBits - 1)
  const info = state.refs.map((header, mapIdx) => ({
    mapIdx,
    sortIdx: header ? center + relativeDistance(header.orderHint, orderHint, orderHintBits) : -1,
  })).sort((a, b) => a.sortIdx - b.sortIdx || a.mapIdx - b.mapIdx)
  const refs = new Array<number>(7).fill(-1)
  const used = new Array<boolean>(7).fill(false)
  const fwdStart = info.findIndex(item => item.sortIdx >= 0)
  if (fwdStart < 0) throw new Error('ts-avif: short reference signaling has no valid references')
  let fwdEnd = info.findIndex(item => item.sortIdx >= center) - 1
  if (fwdEnd < fwdStart - 1) fwdEnd = info.length - 1
  let bwdStart = fwdEnd + 1
  let bwdEnd = info.length - 1

  const assign = (type: number, item: { mapIdx: number }): void => {
    refs[type] = item.mapIdx
    used[type] = true
  }
  if (bwdStart <= bwdEnd) assign(6, info[bwdEnd--])
  if (bwdStart <= bwdEnd) assign(4, info[bwdStart++])
  if (bwdStart <= bwdEnd) assign(5, info[bwdStart])

  for (let i = fwdStart; i <= fwdEnd; i++) {
    if (info[i].mapIdx === lastFrameIdx) assign(0, info[i])
    if (info[i].mapIdx === goldFrameIdx) assign(3, info[i])
  }
  if (!used[0] || !used[3])
    throw new Error('ts-avif: short reference signaling names a non-forward LAST or GOLDEN frame')

  const fillTypes = [1, 2, 4, 5, 6]
  let fill = 0
  for (; fill < fillTypes.length; fill++) {
    const type = fillTypes[fill]
    if (used[type]) continue
    while (fwdStart <= fwdEnd && (info[fwdEnd].mapIdx === lastFrameIdx || info[fwdEnd].mapIdx === goldFrameIdx))
      fwdEnd--
    if (fwdStart > fwdEnd) break
    assign(type, info[fwdEnd--])
  }
  for (; fill < fillTypes.length; fill++) {
    const type = fillTypes[fill]
    if (!used[type]) assign(type, info[fwdStart])
  }
  return refs
}

function readGlobalMotion(r: BitReader, previous: GlobalMotionParams, allowHighPrecisionMv: boolean): GlobalMotionParams {
  let type = r.readBit()
  if (type) type = r.readBit() ? 2 : r.readBit() ? 1 : 3
  const matrix: GlobalMotionParams['matrix'] = [0, 0, 65536, 0, 0, 65536]
  const prev = previous.matrix
  if (type >= 2) {
    matrix[2] = readSignedSubexpWithRef(r, 4097, 3, (prev[2] >> 1) - 32768) * 2 + 65536
    matrix[3] = readSignedSubexpWithRef(r, 4097, 3, prev[3] >> 1) * 2
  }
  if (type === 3) {
    matrix[4] = readSignedSubexpWithRef(r, 4097, 3, prev[4] >> 1) * 2
    matrix[5] = readSignedSubexpWithRef(r, 4097, 3, (prev[5] >> 1) - 32768) * 2 + 65536
  }
  else if (type === 2) {
    matrix[4] = -matrix[3]
    matrix[5] = matrix[2]
  }
  if (type >= 1) {
    const translationOnly = type === 1
    const bits = translationOnly ? 9 - (allowHighPrecisionMv ? 0 : 1) : 12
    const precision = translationOnly ? 13 + (allowHighPrecisionMv ? 0 : 1) : 10
    matrix[0] = readSignedSubexpWithRef(r, (1 << bits) + 1, 3, prev[0] >> precision) * (1 << precision)
    matrix[1] = readSignedSubexpWithRef(r, (1 << bits) + 1, 3, prev[1] >> precision) * (1 << precision)
  }
  return { type, matrix }
}

function readSignedSubexpWithRef(r: BitReader, n: number, k: number, ref: number): number {
  const scaledN = n * 2 - 1
  return inverseRecenterFinite(scaledN, ref + n - 1, readSubexp(r, scaledN, k)) - n + 1
}

function readSubexp(r: BitReader, n: number, k: number): number {
  let i = 0
  let mk = 0
  while (true) {
    const b = i ? k + i - 1 : k
    const a = 1 << b
    if (n <= mk + 3 * a) return r.ns(n - mk) + mk
    if (!r.readBit()) return r.readBits(b) + mk
    i++
    mk += a
  }
}

function inverseRecenterFinite(n: number, ref: number, value: number): number {
  if (ref * 2 <= n) return inverseRecenter(ref, value)
  return n - 1 - inverseRecenter(n - 1 - ref, value)
}

function inverseRecenter(ref: number, value: number): number {
  if (value > ref * 2) return value
  return value & 1 ? ref - ((value + 1) >> 1) : ref + (value >> 1)
}

function readGrainPoints(r: BitReader, maxPoints: number): [number, number][] {
  const count = r.readBits(4)
  if (count > maxPoints)
    throw new Error(`ts-avif: invalid film-grain point count ${count}`)
  const points: [number, number][] = []
  for (let i = 0; i < count; i++) {
    const x = r.readBits(8)
    const y = r.readBits(8)
    if (i && x <= points[i - 1][0])
      throw new Error('ts-avif: film-grain scaling points are not increasing')
    points.push([x, y])
  }
  return points
}

function readSignedGrainCoeffs(r: BitReader, count: number): number[] {
  return Array.from({ length: count }, () => r.readBits(8) - 128)
}

function parseTileInfo(r: BitReader, seq: SequenceHeader, miCols: number, miRows: number): TileInfo {
  const sbCols = seq.use128x128Superblock ? ((miCols + 31) >> 5) : ((miCols + 15) >> 4)
  const sbRows = seq.use128x128Superblock ? ((miRows + 31) >> 5) : ((miRows + 15) >> 4)
  const sbShift = seq.use128x128Superblock ? 5 : 4
  const sbSize = sbShift + 2
  const maxTileWidthSb = MAX_TILE_WIDTH >> sbSize
  let maxTileAreaSb = MAX_TILE_AREA >> (2 * sbSize)
  const minLog2TileCols = tileLog2(maxTileWidthSb, sbCols)
  const maxLog2TileCols = tileLog2(1, Math.min(sbCols, MAX_TILE_COLS))
  const maxLog2TileRows = tileLog2(1, Math.min(sbRows, MAX_TILE_ROWS))
  const minLog2Tiles = Math.max(minLog2TileCols, tileLog2(maxTileAreaSb, sbRows * sbCols))

  let tileColsLog2: number
  let tileRowsLog2: number
  const miColStarts: number[] = []
  const miRowStarts: number[] = []
  let tileCols: number
  let tileRows: number

  const uniformTileSpacing = r.readBit() === 1
  if (uniformTileSpacing) {
    tileColsLog2 = minLog2TileCols
    while (tileColsLog2 < maxLog2TileCols) {
      if (r.readBit() === 1)
        tileColsLog2++
      else
        break
    }
    const tileWidthSb = (sbCols + (1 << tileColsLog2) - 1) >> tileColsLog2
    let i = 0
    for (let startSb = 0; startSb < sbCols; startSb += tileWidthSb) {
      miColStarts.push(startSb << sbShift)
      i++
    }
    miColStarts.push(miCols)
    tileCols = i

    const minLog2TileRows = Math.max(minLog2Tiles - tileColsLog2, 0)
    tileRowsLog2 = minLog2TileRows
    while (tileRowsLog2 < maxLog2TileRows) {
      if (r.readBit() === 1)
        tileRowsLog2++
      else
        break
    }
    const tileHeightSb = (sbRows + (1 << tileRowsLog2) - 1) >> tileRowsLog2
    i = 0
    for (let startSb = 0; startSb < sbRows; startSb += tileHeightSb) {
      miRowStarts.push(startSb << sbShift)
      i++
    }
    miRowStarts.push(miRows)
    tileRows = i
  }
  else {
    let widestTileSb = 0
    let startSb = 0
    let i = 0
    for (; startSb < sbCols; i++) {
      miColStarts.push(startSb << sbShift)
      const maxWidth = Math.min(sbCols - startSb, maxTileWidthSb)
      const widthInSbs = r.ns(maxWidth) + 1
      widestTileSb = Math.max(widthInSbs, widestTileSb)
      startSb += widthInSbs
    }
    miColStarts.push(miCols)
    tileCols = i
    tileColsLog2 = tileLog2(1, tileCols)

    if (minLog2Tiles > 0)
      maxTileAreaSb = (sbRows * sbCols) >> (minLog2Tiles + 1)
    else
      maxTileAreaSb = sbRows * sbCols
    const maxTileHeightSb = Math.max(Math.floor(maxTileAreaSb / widestTileSb), 1)

    startSb = 0
    i = 0
    for (; startSb < sbRows; i++) {
      miRowStarts.push(startSb << sbShift)
      const maxHeight = Math.min(sbRows - startSb, maxTileHeightSb)
      const heightInSbs = r.ns(maxHeight) + 1
      startSb += heightInSbs
    }
    miRowStarts.push(miRows)
    tileRows = i
    tileRowsLog2 = tileLog2(1, tileRows)
  }

  let contextUpdateTileId = 0
  let tileSizeBytes = 1
  if (tileColsLog2 > 0 || tileRowsLog2 > 0) {
    contextUpdateTileId = r.readBits(tileRowsLog2 + tileColsLog2)
    tileSizeBytes = r.readBits(2) + 1
  }

  return {
    tileColsLog2,
    tileRowsLog2,
    tileCols,
    tileRows,
    miColStarts,
    miRowStarts,
    contextUpdateTileId,
    tileSizeBytes,
  }
}

function parseQuantizationParams(r: BitReader, seq: SequenceHeader): QuantizationParams {
  const baseQIdx = r.readBits(8)
  const deltaQYDc = readDeltaQ(r)
  let deltaQUDc = 0
  let deltaQUAc = 0
  let deltaQVDc = 0
  let deltaQVAc = 0
  if (seq.numPlanes > 1) {
    const diffUvDelta = seq.separateUvDeltaQ ? r.readBit() === 1 : false
    deltaQUDc = readDeltaQ(r)
    deltaQUAc = readDeltaQ(r)
    if (diffUvDelta) {
      deltaQVDc = readDeltaQ(r)
      deltaQVAc = readDeltaQ(r)
    }
    else {
      deltaQVDc = deltaQUDc
      deltaQVAc = deltaQUAc
    }
  }
  const usingQMatrix = r.readBit() === 1
  let qmY = 0
  let qmU = 0
  let qmV = 0
  if (usingQMatrix) {
    qmY = r.readBits(4)
    qmU = r.readBits(4)
    qmV = !seq.separateUvDeltaQ ? qmU : r.readBits(4)
  }
  return { baseQIdx, deltaQYDc, deltaQUDc, deltaQUAc, deltaQVDc, deltaQVAc, usingQMatrix, qmY, qmU, qmV }
}

function parseSegmentationParams(r: BitReader): SegmentationParams {
  const featureEnabled: boolean[][] = []
  const featureData: number[][] = []
  for (let i = 0; i < MAX_SEGMENTS; i++) {
    featureEnabled.push(Array.from({ length: SEG_LVL_MAX }, () => false))
    featureData.push(Array.from({ length: SEG_LVL_MAX }, () => 0))
  }

  const enabled = r.readBit() === 1
  // Intra key frames always have primary_ref_frame == PRIMARY_REF_NONE:
  // segmentation_update_map = 1, temporal_update = 0, update_data = 1.
  const updateMap = enabled
  const temporalUpdate = false
  const updateData = enabled

  if (enabled) {
    for (let i = 0; i < MAX_SEGMENTS; i++) {
      for (let j = 0; j < SEG_LVL_MAX; j++) {
        if (r.readBit() === 1) { // feature_enabled
          featureEnabled[i][j] = true
          const bitsToRead = SEGMENTATION_FEATURE_BITS[j]
          const limit = SEGMENTATION_FEATURE_MAX[j]
          if (SEGMENTATION_FEATURE_SIGNED[j] === 1)
            featureData[i][j] = clamp(r.su(1 + bitsToRead), -limit, limit)
          else
            featureData[i][j] = clamp(bitsToRead > 0 ? r.readBits(bitsToRead) : 0, 0, limit)
        }
      }
    }
  }

  let segIdPreSkip = false
  let lastActiveSegId = 0
  for (let i = 0; i < MAX_SEGMENTS; i++) {
    for (let j = 0; j < SEG_LVL_MAX; j++) {
      if (featureEnabled[i][j]) {
        lastActiveSegId = i
        if (j >= 5) // SEG_LVL_REF_FRAME
          segIdPreSkip = true
      }
    }
  }

  return { enabled, updateMap, temporalUpdate, updateData, featureEnabled, featureData, segIdPreSkip, lastActiveSegId }
}

function parseLoopFilterParams(
  r: BitReader,
  seq: SequenceHeader,
  codedLossless: boolean,
  allowIntrabc: boolean,
): LoopFilterParams {
  if (codedLossless || allowIntrabc) {
    return {
      levels: [0, 0, 0, 0],
      sharpness: 0,
      deltaEnabled: false,
      refDeltas: [1, 0, 0, 0, -1, 0, -1, -1],
      modeDeltas: [0, 0],
    }
  }

  const levels: [number, number, number, number] = [r.readBits(6), r.readBits(6), 0, 0]
  if (seq.numPlanes > 1 && (levels[0] !== 0 || levels[1] !== 0)) {
    levels[2] = r.readBits(6)
    levels[3] = r.readBits(6)
  }
  const sharpness = r.readBits(3)
  const refDeltas = [1, 0, 0, 0, -1, 0, -1, -1]
  const modeDeltas = [0, 0]
  const deltaEnabled = r.readBit() === 1
  if (deltaEnabled && r.readBit() === 1) { // loop_filter_delta_update
    for (let i = 0; i < 8; i++) {
      if (r.readBit() === 1)
        refDeltas[i] = r.su(7)
    }
    for (let i = 0; i < 2; i++) {
      if (r.readBit() === 1)
        modeDeltas[i] = r.su(7)
    }
  }
  return { levels, sharpness, deltaEnabled, refDeltas, modeDeltas }
}

function parseCdefParams(
  r: BitReader,
  seq: SequenceHeader,
  codedLossless: boolean,
  allowIntrabc: boolean,
): CdefParams {
  if (codedLossless || allowIntrabc || !seq.enableCdef) {
    return {
      damping: 3,
      bits: 0,
      yPriStrength: [0],
      ySecStrength: [0],
      uvPriStrength: [0],
      uvSecStrength: [0],
    }
  }

  const damping = r.readBits(2) + 3
  const bits = r.readBits(2)
  const n = 1 << bits
  const yPriStrength: number[] = []
  const ySecStrength: number[] = []
  const uvPriStrength: number[] = []
  const uvSecStrength: number[] = []
  for (let i = 0; i < n; i++) {
    yPriStrength.push(r.readBits(4))
    let sec = r.readBits(2)
    if (sec === 3)
      sec += 1
    ySecStrength.push(sec)
    if (seq.numPlanes > 1) {
      uvPriStrength.push(r.readBits(4))
      sec = r.readBits(2)
      if (sec === 3)
        sec += 1
      uvSecStrength.push(sec)
    }
    else {
      uvPriStrength.push(0)
      uvSecStrength.push(0)
    }
  }
  return { damping, bits, yPriStrength, ySecStrength, uvPriStrength, uvSecStrength }
}

function parseLrParams(
  r: BitReader,
  seq: SequenceHeader,
  allLossless: boolean,
  allowIntrabc: boolean,
): LrParams {
  if (allLossless || allowIntrabc || !seq.enableRestoration) {
    return {
      frameRestorationType: [RestorationType.NONE, RestorationType.NONE, RestorationType.NONE],
      usesLr: false,
      usesChromaLr: false,
      loopRestorationSize: [256, 256, 256],
    }
  }

  const remapLrType = [
    RestorationType.NONE,
    RestorationType.SWITCHABLE,
    RestorationType.WIENER,
    RestorationType.SGRPROJ,
  ]
  const frameRestorationType: number[] = []
  let usesLr = false
  let usesChromaLr = false
  for (let i = 0; i < seq.numPlanes; i++) {
    const lrType = r.readBits(2)
    frameRestorationType.push(remapLrType[lrType])
    if (frameRestorationType[i] !== RestorationType.NONE) {
      usesLr = true
      if (i > 0)
        usesChromaLr = true
    }
  }

  let loopRestorationSize: number[] = [256, 256, 256]
  if (usesLr) {
    let lrUnitShift = 0
    if (seq.use128x128Superblock) {
      lrUnitShift = r.readBit() + 1
    }
    else {
      lrUnitShift = r.readBit()
      if (lrUnitShift)
        lrUnitShift += r.readBit()
    }
    const size0 = 256 >> (2 - lrUnitShift)
    let lrUvShift = 0
    if (seq.subsamplingX === 1 && seq.subsamplingY === 1 && usesChromaLr)
      lrUvShift = r.readBit()
    loopRestorationSize = [size0, size0 >> lrUvShift, size0 >> lrUvShift]
  }
  return { frameRestorationType, usesLr, usesChromaLr, loopRestorationSize }
}

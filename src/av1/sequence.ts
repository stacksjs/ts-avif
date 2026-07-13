/**
 * AV1 sequence_header_obu parsing, complete per spec section 5.5. The still
 * image path (reduced_still_picture_header) is the common AVIF case, but the
 * full header - timing info, decoder model, operating points - is parsed so
 * any conformant encoder output works.
 */
import { BitReader } from './bits'

/** Color primaries / transfer / matrix constants used during parsing. */
const CP_BT_709 = 1
const CP_UNSPECIFIED = 2
const TC_UNSPECIFIED = 2
const TC_SRGB = 13
const MC_IDENTITY = 0
const MC_UNSPECIFIED = 2

export const SELECT_SCREEN_CONTENT_TOOLS = 2
export const SELECT_INTEGER_MV = 2

export interface OperatingPoint {
  idc: number
  seqLevelIdx: number
  seqTier: number
  decoderModelPresent: boolean
  decoderBufferDelay: number
  encoderBufferDelay: number
  lowDelayModeFlag: boolean
  initialDisplayDelay: number
}

export interface SequenceHeader {
  seqProfile: number
  stillPicture: boolean
  reducedStillPictureHeader: boolean

  timingInfoPresent: boolean
  equalPictureInterval: boolean
  decoderModelInfoPresent: boolean
  bufferDelayLength: number
  bufferRemovalTimeLength: number
  framePresentationTimeLength: number
  initialDisplayDelayPresent: boolean
  operatingPoints: OperatingPoint[]

  frameWidthBits: number
  frameHeightBits: number
  maxFrameWidth: number
  maxFrameHeight: number

  frameIdNumbersPresent: boolean
  deltaFrameIdLength: number
  additionalFrameIdLength: number

  use128x128Superblock: boolean
  enableFilterIntra: boolean
  enableIntraEdgeFilter: boolean
  enableInterintraCompound: boolean
  enableMaskedCompound: boolean
  enableWarpedMotion: boolean
  enableDualFilter: boolean
  enableOrderHint: boolean
  enableJntComp: boolean
  enableRefFrameMvs: boolean
  seqForceScreenContentTools: number
  seqForceIntegerMv: number
  orderHintBits: number
  enableSuperres: boolean
  enableCdef: boolean
  enableRestoration: boolean

  // color_config
  bitDepth: number
  monochrome: boolean
  numPlanes: number
  colorPrimaries: number
  transferCharacteristics: number
  matrixCoefficients: number
  colorRange: boolean
  subsamplingX: number
  subsamplingY: number
  chromaSamplePosition: number
  separateUvDeltaQ: boolean

  filmGrainParamsPresent: boolean
}

export function parseSequenceHeader(data: Uint8Array): SequenceHeader {
  const r = new BitReader(data)

  const seqProfile = r.readBits(3)
  const stillPicture = r.readBit() === 1
  const reducedStillPictureHeader = r.readBit() === 1

  let timingInfoPresent = false
  let equalPictureInterval = false
  let decoderModelInfoPresent = false
  let bufferDelayLength = 0
  let bufferRemovalTimeLength = 0
  let framePresentationTimeLength = 0
  let initialDisplayDelayPresent = false
  const operatingPoints: OperatingPoint[] = []

  if (reducedStillPictureHeader) {
    operatingPoints.push({
      idc: 0,
      seqLevelIdx: r.readBits(5),
      seqTier: 0,
      decoderModelPresent: false,
      decoderBufferDelay: 0,
      encoderBufferDelay: 0,
      lowDelayModeFlag: false,
      initialDisplayDelay: 10,
    })
  }
  else {
    timingInfoPresent = r.readBit() === 1
    if (timingInfoPresent) {
      r.readBits(32) // num_units_in_display_tick
      r.readBits(32) // time_scale
      equalPictureInterval = r.readBit() === 1
      if (equalPictureInterval)
        r.uvlc() // num_ticks_per_picture_minus_1
      decoderModelInfoPresent = r.readBit() === 1
      if (decoderModelInfoPresent) {
        bufferDelayLength = r.readBits(5) + 1
        r.readBits(32) // num_units_in_decoding_tick
        bufferRemovalTimeLength = r.readBits(5) + 1
        framePresentationTimeLength = r.readBits(5) + 1
      }
    }
    initialDisplayDelayPresent = r.readBit() === 1
    const operatingPointsCntMinus1 = r.readBits(5)
    for (let i = 0; i <= operatingPointsCntMinus1; i++) {
      const idc = r.readBits(12)
      const seqLevelIdx = r.readBits(5)
      const seqTier = seqLevelIdx > 7 ? r.readBit() : 0
      let decoderModelPresent = false
      let decoderBufferDelay = 0
      let encoderBufferDelay = 0
      let lowDelayModeFlag = false
      if (decoderModelInfoPresent) {
        decoderModelPresent = r.readBit() === 1
        if (decoderModelPresent) {
          decoderBufferDelay = r.readBits(bufferDelayLength)
          encoderBufferDelay = r.readBits(bufferDelayLength)
          lowDelayModeFlag = r.readBit() === 1
        }
      }
      let initialDisplayDelay = 10
      if (initialDisplayDelayPresent && r.readBit() === 1)
        initialDisplayDelay = r.readBits(4) + 1
      operatingPoints.push({
        idc,
        seqLevelIdx,
        seqTier,
        decoderModelPresent,
        decoderBufferDelay,
        encoderBufferDelay,
        lowDelayModeFlag,
        initialDisplayDelay,
      })
    }
  }

  const frameWidthBits = r.readBits(4) + 1
  const frameHeightBits = r.readBits(4) + 1
  const maxFrameWidth = r.readBits(frameWidthBits) + 1
  const maxFrameHeight = r.readBits(frameHeightBits) + 1

  let frameIdNumbersPresent = false
  let deltaFrameIdLength = 0
  let additionalFrameIdLength = 0
  if (!reducedStillPictureHeader) {
    frameIdNumbersPresent = r.readBit() === 1
    if (frameIdNumbersPresent) {
      deltaFrameIdLength = r.readBits(4) + 2
      additionalFrameIdLength = r.readBits(3) + 1
    }
  }

  const use128x128Superblock = r.readBit() === 1
  const enableFilterIntra = r.readBit() === 1
  const enableIntraEdgeFilter = r.readBit() === 1

  let enableInterintraCompound = false
  let enableMaskedCompound = false
  let enableWarpedMotion = false
  let enableDualFilter = false
  let enableOrderHint = false
  let enableJntComp = false
  let enableRefFrameMvs = false
  let seqForceScreenContentTools = SELECT_SCREEN_CONTENT_TOOLS
  let seqForceIntegerMv = SELECT_INTEGER_MV
  let orderHintBits = 0

  if (!reducedStillPictureHeader) {
    enableInterintraCompound = r.readBit() === 1
    enableMaskedCompound = r.readBit() === 1
    enableWarpedMotion = r.readBit() === 1
    enableDualFilter = r.readBit() === 1
    enableOrderHint = r.readBit() === 1
    if (enableOrderHint) {
      enableJntComp = r.readBit() === 1
      enableRefFrameMvs = r.readBit() === 1
    }
    seqForceScreenContentTools = r.readBit() === 1
      ? SELECT_SCREEN_CONTENT_TOOLS
      : r.readBit()
    if (seqForceScreenContentTools > 0) {
      seqForceIntegerMv = r.readBit() === 1
        ? SELECT_INTEGER_MV
        : r.readBit()
    }
    else {
      seqForceIntegerMv = SELECT_INTEGER_MV
    }
    if (enableOrderHint)
      orderHintBits = r.readBits(3) + 1
  }

  const enableSuperres = r.readBit() === 1
  const enableCdef = r.readBit() === 1
  const enableRestoration = r.readBit() === 1

  // color_config()
  const highBitdepth = r.readBit() === 1
  let bitDepth: number
  if (seqProfile === 2 && highBitdepth)
    bitDepth = r.readBit() === 1 ? 12 : 10
  else
    bitDepth = highBitdepth ? 10 : 8

  const monochrome = seqProfile === 1 ? false : r.readBit() === 1
  const numPlanes = monochrome ? 1 : 3

  let colorPrimaries = CP_UNSPECIFIED
  let transferCharacteristics = TC_UNSPECIFIED
  let matrixCoefficients = MC_UNSPECIFIED
  if (r.readBit() === 1) { // color_description_present_flag
    colorPrimaries = r.readBits(8)
    transferCharacteristics = r.readBits(8)
    matrixCoefficients = r.readBits(8)
  }

  let colorRange = false
  let subsamplingX = 1
  let subsamplingY = 1
  let chromaSamplePosition = 0
  let separateUvDeltaQ = false

  if (monochrome) {
    colorRange = r.readBit() === 1
  }
  else if (
    colorPrimaries === CP_BT_709
    && transferCharacteristics === TC_SRGB
    && matrixCoefficients === MC_IDENTITY
  ) {
    colorRange = true
    subsamplingX = 0
    subsamplingY = 0
    separateUvDeltaQ = r.readBit() === 1
  }
  else {
    colorRange = r.readBit() === 1
    if (seqProfile === 0) {
      subsamplingX = 1
      subsamplingY = 1
    }
    else if (seqProfile === 1) {
      subsamplingX = 0
      subsamplingY = 0
    }
    else if (bitDepth === 12) {
      subsamplingX = r.readBit()
      subsamplingY = subsamplingX === 1 ? r.readBit() : 0
    }
    else {
      subsamplingX = 1
      subsamplingY = 0
    }
    if (subsamplingX === 1 && subsamplingY === 1)
      chromaSamplePosition = r.readBits(2)
    separateUvDeltaQ = r.readBit() === 1
  }

  const filmGrainParamsPresent = r.readBit() === 1

  return {
    seqProfile,
    stillPicture,
    reducedStillPictureHeader,
    timingInfoPresent,
    equalPictureInterval,
    decoderModelInfoPresent,
    bufferDelayLength,
    bufferRemovalTimeLength,
    framePresentationTimeLength,
    initialDisplayDelayPresent,
    operatingPoints,
    frameWidthBits,
    frameHeightBits,
    maxFrameWidth,
    maxFrameHeight,
    frameIdNumbersPresent,
    deltaFrameIdLength,
    additionalFrameIdLength,
    use128x128Superblock,
    enableFilterIntra,
    enableIntraEdgeFilter,
    enableInterintraCompound,
    enableMaskedCompound,
    enableWarpedMotion,
    enableDualFilter,
    enableOrderHint,
    enableJntComp,
    enableRefFrameMvs,
    seqForceScreenContentTools,
    seqForceIntegerMv,
    orderHintBits,
    enableSuperres,
    enableCdef,
    enableRestoration,
    bitDepth,
    monochrome,
    numPlanes,
    colorPrimaries,
    transferCharacteristics,
    matrixCoefficients,
    colorRange,
    subsamplingX,
    subsamplingY,
    chromaSamplePosition,
    separateUvDeltaQ,
    filmGrainParamsPresent,
  }
}

import type { AvifImageData } from '../types'
import { OBUType } from '../types'
import { parseOBUs } from './obu'

/**
 * Sequence header information
 */
interface SequenceHeader {
  seqProfile: number
  stillPicture: boolean
  reducedStillPictureHeader: boolean
  maxFrameWidth: number
  maxFrameHeight: number
  bitDepth: number
  monochrome: boolean
  colorSpace: number
  subX: number
  subY: number
  matrixCoefficients: number
  colorRange: boolean
}

/**
 * Decode AV1 bitstream to image data
 * This is a simplified implementation for still images
 */
export function decodeAV1(data: Uint8Array): AvifImageData {
  // Parse OBUs
  const obus = parseOBUs(data)

  // Find sequence header
  const seqHeaderOBU = obus.find(obu => obu.type === OBUType.SEQUENCE_HEADER)
  if (!seqHeaderOBU) {
    throw new Error('No sequence header found')
  }

  const seqHeader = parseSequenceHeader(seqHeaderOBU.data)

  // Find frame OBU
  const frameOBU = obus.find(obu => obu.type === OBUType.FRAME)
  if (!frameOBU) {
    throw new Error('No frame data found')
  }

  // Decode frame
  const pixels = decodeFrame(frameOBU.data, seqHeader)

  return {
    data: pixels,
    width: seqHeader.maxFrameWidth,
    height: seqHeader.maxFrameHeight,
    hasAlpha: false, // AV1 doesn't have native alpha
    bitDepth: seqHeader.bitDepth as 8 | 10 | 12,
  }
}

function parseSequenceHeader(data: Uint8Array): SequenceHeader {
  const reader = new BitReader(data)

  const seqProfile = reader.readBits(3)
  const stillPicture = reader.readBit() === 1
  const reducedStillPictureHeader = reader.readBit() === 1

  let maxFrameWidth = 0
  let maxFrameHeight = 0
  let bitDepth = 8

  if (reducedStillPictureHeader) {
    // Simplified header
    const seqLevelIdx = reader.readBits(5)
    const frameWidthBits = reader.readBits(4) + 1
    const frameHeightBits = reader.readBits(4) + 1
    maxFrameWidth = reader.readBits(frameWidthBits) + 1
    maxFrameHeight = reader.readBits(frameHeightBits) + 1
  }
  else {
    // Full sequence header parsing
    const timingInfoPresentFlag = reader.readBit()

    if (timingInfoPresentFlag) {
      // Skip timing info
      reader.readBits(32) // num_units_in_display_tick
      reader.readBits(32) // time_scale
      const equalPictureInterval = reader.readBit()
      if (equalPictureInterval) {
        readUvlc(reader) // num_ticks_per_picture_minus_1
      }
    }

    const decoderModelInfoPresentFlag = reader.readBit()
    if (decoderModelInfoPresentFlag) {
      // Skip decoder model info
      reader.readBits(5) // buffer_delay_length_minus_1
      reader.readBits(32) // num_units_in_decoding_tick
      reader.readBits(5) // buffer_removal_time_length_minus_1
      reader.readBits(5) // frame_presentation_time_length_minus_1
    }

    const initialDisplayDelayPresentFlag = reader.readBit()
    const operatingPointsCntMinus1 = reader.readBits(5)

    for (let i = 0; i <= operatingPointsCntMinus1; i++) {
      reader.readBits(12) // operating_point_idc
      const seqLevelIdx = reader.readBits(5)

      if (seqLevelIdx > 7) {
        reader.readBit() // seq_tier
      }

      if (decoderModelInfoPresentFlag) {
        const decoderModelPresentForThisOp = reader.readBit()
        if (decoderModelPresentForThisOp) {
          // Skip operating parameters info
          reader.readBits(5) // decoder_buffer_delay
          reader.readBits(5) // encoder_buffer_delay
          reader.readBit() // low_delay_mode_flag
        }
      }

      if (initialDisplayDelayPresentFlag) {
        const initialDisplayDelayPresentForThisOp = reader.readBit()
        if (initialDisplayDelayPresentForThisOp) {
          reader.readBits(4) // initial_display_delay_minus_1
        }
      }
    }

    const frameWidthBitsMinus1 = reader.readBits(4)
    const frameHeightBitsMinus1 = reader.readBits(4)
    maxFrameWidth = reader.readBits(frameWidthBitsMinus1 + 1) + 1
    maxFrameHeight = reader.readBits(frameHeightBitsMinus1 + 1) + 1
  }

  // Color config
  const highBitdepth = false
  const twelveBit = false
  const monochrome = false
  const colorSpace = 0
  const subX = 1
  const subY = 1
  const matrixCoefficients = 0
  const colorRange = false

  if (!reducedStillPictureHeader) {
    // Parse remaining sequence header for color info
    const frameIdNumbersPresentFlag = reader.readBit()
    if (frameIdNumbersPresentFlag) {
      reader.readBits(4) // delta_frame_id_length_minus_2
      reader.readBits(3) // additional_frame_id_length_minus_1
    }

    reader.readBit() // use_128x128_superblock
    reader.readBit() // enable_filter_intra
    reader.readBit() // enable_intra_edge_filter

    // ... more parsing would go here for a complete implementation
  }

  // Determine bit depth
  if (seqProfile === 2 && highBitdepth) {
    bitDepth = twelveBit ? 12 : 10
  }
  else if (seqProfile >= 2) {
    bitDepth = 10
  }
  else {
    bitDepth = highBitdepth ? 10 : 8
  }

  return {
    seqProfile,
    stillPicture,
    reducedStillPictureHeader,
    maxFrameWidth,
    maxFrameHeight,
    bitDepth,
    monochrome,
    colorSpace,
    subX,
    subY,
    matrixCoefficients,
    colorRange,
  }
}

function decodeFrame(data: Uint8Array, seqHeader: SequenceHeader): Uint8Array {
  const { maxFrameWidth: width, maxFrameHeight: height } = seqHeader

  // The AV1 entropy decoder (frame header, tile decode, transforms, intra
  // prediction, loop filters, CDEF, loop restoration, YUV→RGB) is not
  // implemented yet. Failing loudly beats the old behavior of silently
  // returning a gray placeholder that looked like a successful decode.
  throw new Error(
    `ts-avif: AV1 frame decoding is not implemented yet `
    + `(${width}x${height}, ${data.length} byte frame OBU parsed). `
    + `Container, OBU, and sequence-header layers are complete — the entropy `
    + `decoder is the remaining work. Use getAvifMetadata() for everything `
    + `knowable without decoding pixels.`,
  )
}

/**
 * Read unsigned variable length code
 */
function readUvlc(reader: BitReader): number {
  let leadingZeros = 0

  while (reader.readBit() === 0) {
    leadingZeros++
    if (leadingZeros >= 32) {
      return 0xFFFFFFFF
    }
  }

  if (leadingZeros >= 32) {
    return 0xFFFFFFFF
  }

  const value = reader.readBits(leadingZeros)
  return value + (1 << leadingZeros) - 1
}

/**
 * Simple bit reader for AV1 parsing
 */
class BitReader {
  private data: Uint8Array
  private pos: number = 0
  private bitPos: number = 0

  constructor(data: Uint8Array) {
    this.data = data
  }

  readBit(): number {
    if (this.pos >= this.data.length) {
      return 0
    }

    const bit = (this.data[this.pos] >> (7 - this.bitPos)) & 1
    this.bitPos++

    if (this.bitPos === 8) {
      this.bitPos = 0
      this.pos++
    }

    return bit
  }

  readBits(count: number): number {
    let value = 0

    for (let i = 0; i < count; i++) {
      value = (value << 1) | this.readBit()
    }

    return value
  }
}

import type { AvifEncodeOptions, AvifImageData } from './types'
import { OBUType } from './types'
import { createOBU, writeLeb128 } from './av1/obu'
import { createFtyp } from './container/heif'

/**
 * Encode RGBA pixel data to AVIF format
 * Note: This is a simplified implementation
 */
export function encode(
  imageData: AvifImageData,
  options: AvifEncodeOptions = {},
): Uint8Array {
  const { width, height, data } = imageData
  const { quality = 80, lossless = false } = options

  // Create AV1 bitstream
  const av1Data = encodeAV1(data, width, height, { quality, lossless })

  // Create AVIF container
  return createAvifContainer(av1Data, width, height, imageData.hasAlpha)
}

function encodeAV1(
  data: Uint8Array,
  width: number,
  height: number,
  _options: { quality: number, lossless: boolean },
): Uint8Array {
  // Create sequence header OBU
  const seqHeader = createSequenceHeader(width, height)
  const seqHeaderOBU = createOBU(OBUType.SEQUENCE_HEADER, seqHeader)

  // Create frame OBU (simplified - just placeholder for now)
  const frame = createSimpleFrame(data, width, height)
  const frameOBU = createOBU(OBUType.FRAME, frame)

  // Concatenate OBUs
  const totalLength = seqHeaderOBU.length + frameOBU.length
  const result = new Uint8Array(totalLength)
  result.set(seqHeaderOBU, 0)
  result.set(frameOBU, seqHeaderOBU.length)

  return result
}

function createSequenceHeader(width: number, height: number): Uint8Array {
  const buffer: number[] = []

  // For a complete implementation, this would properly encode:
  // - seq_profile
  // - still_picture
  // - reduced_still_picture_header
  // - timing_info
  // - decoder_model_info
  // - operating_points
  // - frame dimensions
  // - color_config

  // Simplified sequence header for still picture
  // seq_profile = 0, still_picture = 1, reduced_still_picture_header = 1
  buffer.push(0b00011000) // seq_profile (0) + still_picture (1) + reduced (1)

  // seq_level_idx (level 2.0 = 0)
  buffer.push(0x00)

  // Frame width bits - 1 (calculate how many bits needed)
  const widthBits = Math.ceil(Math.log2(width + 1))
  const heightBits = Math.ceil(Math.log2(height + 1))

  buffer.push(((widthBits - 1) << 4) | (heightBits - 1))

  // Frame width - 1
  const widthBytes = writeLeb128(width - 1)
  for (const b of widthBytes) {
    buffer.push(b)
  }

  // Frame height - 1
  const heightBytes = writeLeb128(height - 1)
  for (const b of heightBytes) {
    buffer.push(b)
  }

  return new Uint8Array(buffer)
}

function createSimpleFrame(
  _data: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  // For a complete implementation, this would:
  // 1. Convert RGB to YUV
  // 2. Apply prediction
  // 3. Apply transforms (DCT/ADST)
  // 4. Quantize coefficients
  // 5. Entropy encode

  // Placeholder: create minimal valid frame data
  const buffer: number[] = []

  // Frame header (simplified)
  buffer.push(0x00) // show_existing_frame = 0, frame_type = KEY_FRAME

  // Minimal frame data
  for (let i = 0; i < Math.min(100, width * height); i++) {
    buffer.push(0x00)
  }

  return new Uint8Array(buffer)
}

function createAvifContainer(
  av1Data: Uint8Array,
  width: number,
  height: number,
  _hasAlpha?: boolean,
): Uint8Array {
  // Create ftyp box
  const ftyp = createFtyp()

  // Create meta box
  const meta = createMetaBox(width, height, av1Data.length)

  // Create mdat box
  const mdat = createMdatBox(av1Data)

  // Concatenate all boxes
  const totalSize = ftyp.length + meta.length + mdat.length
  const result = new Uint8Array(totalSize)

  let offset = 0
  result.set(ftyp, offset)
  offset += ftyp.length

  result.set(meta, offset)
  offset += meta.length

  result.set(mdat, offset)

  return result
}

function createMetaBox(width: number, height: number, dataSize: number): Uint8Array {
  // Create hdlr box (handler)
  const hdlr = createHdlrBox()

  // Create pitm box (primary item)
  const pitm = createPitmBox(1)

  // Create iloc box (item location)
  const iloc = createIlocBox(1, dataSize)

  // Create iinf box (item info)
  const iinf = createIinfBox()

  // Create iprp box (item properties)
  const iprp = createIprpBox(width, height)

  // Calculate meta box size
  const childrenSize = hdlr.length + pitm.length + iloc.length + iinf.length + iprp.length
  const metaSize = 12 + childrenSize // 8 (box header) + 4 (version/flags)

  const meta = new Uint8Array(metaSize)
  const view = new DataView(meta.buffer)

  // Box header
  view.setUint32(0, metaSize)
  meta[4] = 0x6D // m
  meta[5] = 0x65 // e
  meta[6] = 0x74 // t
  meta[7] = 0x61 // a

  // Version and flags
  view.setUint32(8, 0)

  // Children
  let offset = 12
  meta.set(hdlr, offset)
  offset += hdlr.length

  meta.set(pitm, offset)
  offset += pitm.length

  meta.set(iloc, offset)
  offset += iloc.length

  meta.set(iinf, offset)
  offset += iinf.length

  meta.set(iprp, offset)

  return meta
}

function createHdlrBox(): Uint8Array {
  const size = 32
  const buffer = new Uint8Array(size)
  const view = new DataView(buffer.buffer)

  view.setUint32(0, size)
  buffer[4] = 0x68 // h
  buffer[5] = 0x64 // d
  buffer[6] = 0x6C // l
  buffer[7] = 0x72 // r

  // Version and flags
  view.setUint32(8, 0)

  // Pre-defined
  view.setUint32(12, 0)

  // Handler type: 'pict'
  buffer[16] = 0x70 // p
  buffer[17] = 0x69 // i
  buffer[18] = 0x63 // c
  buffer[19] = 0x74 // t

  // Reserved
  view.setUint32(20, 0)
  view.setUint32(24, 0)
  view.setUint32(28, 0)

  return buffer
}

function createPitmBox(primaryItemId: number): Uint8Array {
  const size = 14
  const buffer = new Uint8Array(size)
  const view = new DataView(buffer.buffer)

  view.setUint32(0, size)
  buffer[4] = 0x70 // p
  buffer[5] = 0x69 // i
  buffer[6] = 0x74 // t
  buffer[7] = 0x6D // m

  // Version and flags
  view.setUint32(8, 0)

  // Item ID
  view.setUint16(12, primaryItemId)

  return buffer
}

function createIlocBox(itemId: number, dataSize: number): Uint8Array {
  const size = 28
  const buffer = new Uint8Array(size)
  const view = new DataView(buffer.buffer)

  view.setUint32(0, size)
  buffer[4] = 0x69 // i
  buffer[5] = 0x6C // l
  buffer[6] = 0x6F // o
  buffer[7] = 0x63 // c

  // Version 0, flags 0
  view.setUint32(8, 0)

  // offset_size (4) << 4 | length_size (4)
  buffer[12] = 0x44

  // base_offset_size (0) << 4 | reserved (0)
  buffer[13] = 0x00

  // Item count
  view.setUint16(14, 1)

  // Item ID
  view.setUint16(16, itemId)

  // Data reference index
  view.setUint16(18, 0)

  // Extent count
  view.setUint16(20, 1)

  // Extent offset (will be set to mdat offset)
  view.setUint32(22, 0)

  // Extent length
  view.setUint32(26, dataSize)

  return buffer
}

function createIinfBox(): Uint8Array {
  // Create infe entry for av01 item
  const infe = createInfeBox(1, 'av01')

  const size = 14 + infe.length
  const buffer = new Uint8Array(size)
  const view = new DataView(buffer.buffer)

  view.setUint32(0, size)
  buffer[4] = 0x69 // i
  buffer[5] = 0x69 // i
  buffer[6] = 0x6E // n
  buffer[7] = 0x66 // f

  // Version 0, flags 0
  view.setUint32(8, 0)

  // Entry count
  view.setUint16(12, 1)

  // infe entry
  buffer.set(infe, 14)

  return buffer
}

function createInfeBox(itemId: number, itemType: string): Uint8Array {
  const size = 21
  const buffer = new Uint8Array(size)
  const view = new DataView(buffer.buffer)

  view.setUint32(0, size)
  buffer[4] = 0x69 // i
  buffer[5] = 0x6E // n
  buffer[6] = 0x66 // f
  buffer[7] = 0x65 // e

  // Version 2, flags 0
  view.setUint32(8, 0x02000000)

  // Item ID
  view.setUint16(12, itemId)

  // Item protection index
  view.setUint16(14, 0)

  // Item type
  for (let i = 0; i < 4; i++) {
    buffer[16 + i] = itemType.charCodeAt(i)
  }

  // Item name (null terminated)
  buffer[20] = 0

  return buffer
}

function createIprpBox(width: number, height: number): Uint8Array {
  // Create ipco (item property container)
  const ispe = createIspeBox(width, height)
  const av1c = createAv1CBox()

  const ipcoSize = 8 + ispe.length + av1c.length
  const ipco = new Uint8Array(ipcoSize)
  const ipcoView = new DataView(ipco.buffer)

  ipcoView.setUint32(0, ipcoSize)
  ipco[4] = 0x69 // i
  ipco[5] = 0x70 // p
  ipco[6] = 0x63 // c
  ipco[7] = 0x6F // o

  ipco.set(ispe, 8)
  ipco.set(av1c, 8 + ispe.length)

  // Create ipma (item property association)
  const ipma = createIpmaBox()

  // Create iprp box
  const size = 8 + ipco.length + ipma.length
  const buffer = new Uint8Array(size)
  const view = new DataView(buffer.buffer)

  view.setUint32(0, size)
  buffer[4] = 0x69 // i
  buffer[5] = 0x70 // p
  buffer[6] = 0x72 // r
  buffer[7] = 0x70 // p

  buffer.set(ipco, 8)
  buffer.set(ipma, 8 + ipco.length)

  return buffer
}

function createIspeBox(width: number, height: number): Uint8Array {
  const size = 20
  const buffer = new Uint8Array(size)
  const view = new DataView(buffer.buffer)

  view.setUint32(0, size)
  buffer[4] = 0x69 // i
  buffer[5] = 0x73 // s
  buffer[6] = 0x70 // p
  buffer[7] = 0x65 // e

  // Version and flags
  view.setUint32(8, 0)

  // Width
  view.setUint32(12, width)

  // Height
  view.setUint32(16, height)

  return buffer
}

function createAv1CBox(): Uint8Array {
  const size = 12
  const buffer = new Uint8Array(size)
  const view = new DataView(buffer.buffer)

  view.setUint32(0, size)
  buffer[4] = 0x61 // a
  buffer[5] = 0x76 // v
  buffer[6] = 0x31 // 1
  buffer[7] = 0x43 // C

  // AV1 codec configuration
  buffer[8] = 0x81 // marker (1) + version (1)
  buffer[9] = 0x00 // seq_profile (0) + seq_level_idx_0 (0)
  buffer[10] = 0x00 // seq_tier_0 (0) + high_bitdepth (0) + twelve_bit (0) + monochrome (0) + chroma_subsampling_x (0) + chroma_subsampling_y (0)
  buffer[11] = 0x00 // chroma_sample_position (0)

  return buffer
}

function createIpmaBox(): Uint8Array {
  const size = 17
  const buffer = new Uint8Array(size)
  const view = new DataView(buffer.buffer)

  view.setUint32(0, size)
  buffer[4] = 0x69 // i
  buffer[5] = 0x70 // p
  buffer[6] = 0x6D // m
  buffer[7] = 0x61 // a

  // Version 0, flags 0
  view.setUint32(8, 0)

  // Entry count
  view.setUint32(12, 1)

  // Item ID
  view.setUint16(16, 1)

  return buffer
}

function createMdatBox(data: Uint8Array): Uint8Array {
  const size = 8 + data.length
  const buffer = new Uint8Array(size)
  const view = new DataView(buffer.buffer)

  view.setUint32(0, size)
  buffer[4] = 0x6D // m
  buffer[5] = 0x64 // d
  buffer[6] = 0x61 // a
  buffer[7] = 0x74 // t

  buffer.set(data, 8)

  return buffer
}

import type { AV1OBU } from '../types'
import { OBUType } from '../types'

/**
 * Parse AV1 Open Bitstream Units (OBUs) from data
 */
export function parseOBUs(data: Uint8Array): AV1OBU[] {
  const obus: AV1OBU[] = []
  let offset = 0

  while (offset < data.length) {
    const obu = parseOBU(data, offset)
    if (!obu) {
      break
    }

    obus.push(obu)
    offset += obu.size
  }

  return obus
}

function parseOBU(data: Uint8Array, offset: number): AV1OBU | null {
  if (offset >= data.length) {
    return null
  }

  const header = data[offset]

  // obu_forbidden_bit must be 0
  if ((header & 0x80) !== 0) {
    throw new Error('Invalid OBU: forbidden bit is set')
  }

  const type = (header >> 3) & 0x0F
  const hasExtension = (header & 0x04) !== 0
  const hasSizeField = (header & 0x02) !== 0

  let headerSize = 1

  if (hasExtension) {
    headerSize++
  }

  let payloadSize: number

  if (hasSizeField) {
    const { value, bytes } = readLeb128(data, offset + headerSize)
    payloadSize = value
    headerSize += bytes
  }
  else {
    // Size extends to end of data
    payloadSize = data.length - offset - headerSize
  }

  const totalSize = headerSize + payloadSize

  return {
    type,
    size: totalSize,
    data: data.slice(offset + headerSize, offset + totalSize),
  }
}

/**
 * Read LEB128 encoded value
 */
function readLeb128(data: Uint8Array, offset: number): { value: number, bytes: number } {
  let value = 0
  let bytes = 0
  let byte: number

  do {
    if (offset + bytes >= data.length) {
      throw new Error('Unexpected end of data while reading LEB128')
    }

    byte = data[offset + bytes]
    value |= (byte & 0x7F) << (bytes * 7)
    bytes++

    if (bytes > 8) {
      throw new Error('LEB128 value too large')
    }
  } while (byte & 0x80)

  return { value, bytes }
}

/**
 * Write LEB128 encoded value
 */
export function writeLeb128(value: number): Uint8Array {
  const bytes: number[] = []

  do {
    let byte = value & 0x7F
    value >>= 7

    if (value !== 0) {
      byte |= 0x80
    }

    bytes.push(byte)
  } while (value !== 0)

  return new Uint8Array(bytes)
}

/**
 * Create OBU with header
 */
export function createOBU(
  type: OBUType,
  payload: Uint8Array,
  options: {
    hasExtension?: boolean
    temporalId?: number
    spatialId?: number
  } = {},
): Uint8Array {
  const { hasExtension = false, temporalId = 0, spatialId = 0 } = options

  // Calculate header
  let header = (type << 3) | 0x02 // has_size_field = 1

  if (hasExtension) {
    header |= 0x04
  }

  // Encode size
  const sizeBytes = writeLeb128(payload.length)

  // Calculate total size
  const headerSize = 1 + (hasExtension ? 1 : 0) + sizeBytes.length
  const buffer = new Uint8Array(headerSize + payload.length)

  // Write header
  buffer[0] = header

  let offset = 1

  if (hasExtension) {
    buffer[offset] = ((temporalId & 0x07) << 5) | ((spatialId & 0x03) << 3)
    offset++
  }

  // Write size
  buffer.set(sizeBytes, offset)
  offset += sizeBytes.length

  // Write payload
  buffer.set(payload, offset)

  return buffer
}

/**
 * Get OBU type name
 */
export function getOBUTypeName(type: number): string {
  switch (type) {
    case OBUType.SEQUENCE_HEADER: return 'SEQUENCE_HEADER'
    case OBUType.TEMPORAL_DELIMITER: return 'TEMPORAL_DELIMITER'
    case OBUType.FRAME_HEADER: return 'FRAME_HEADER'
    case OBUType.TILE_GROUP: return 'TILE_GROUP'
    case OBUType.METADATA: return 'METADATA'
    case OBUType.FRAME: return 'FRAME'
    case OBUType.REDUNDANT_FRAME_HEADER: return 'REDUNDANT_FRAME_HEADER'
    case OBUType.TILE_LIST: return 'TILE_LIST'
    case OBUType.PADDING: return 'PADDING'
    default: return `UNKNOWN(${type})`
  }
}

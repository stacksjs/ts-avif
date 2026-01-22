import type {
  AV1CodecConfig,
  AvifInfo,
  ImageSpatialExtent,
  ISOBMFFBox,
  ItemInfo,
  ItemLocation,
  PixelInformation,
} from '../types'

/**
 * Parse ISOBMFF (ISO Base Media File Format) boxes
 */
export function parseISOBMFF(buffer: Uint8Array): ISOBMFFBox[] {
  const boxes: ISOBMFFBox[] = []
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  let offset = 0

  while (offset < buffer.length - 8) {
    const size = view.getUint32(offset)
    const type = String.fromCharCode(
      buffer[offset + 4],
      buffer[offset + 5],
      buffer[offset + 6],
      buffer[offset + 7],
    )

    let boxSize = size
    let headerSize = 8

    if (size === 1) {
      // 64-bit size
      const highSize = view.getUint32(offset + 8)
      const lowSize = view.getUint32(offset + 12)
      boxSize = highSize * 0x100000000 + lowSize
      headerSize = 16
    }
    else if (size === 0) {
      // Box extends to end of file
      boxSize = buffer.length - offset
    }

    const data = buffer.slice(offset + headerSize, offset + boxSize)

    const box: ISOBMFFBox = {
      type,
      size: boxSize,
      offset,
      data,
    }

    // Parse container boxes
    if (isContainerBox(type)) {
      box.children = parseISOBMFF(data)
    }

    boxes.push(box)
    offset += boxSize
  }

  return boxes
}

function isContainerBox(type: string): boolean {
  const containerTypes = [
    'moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf',
    'meta', 'iprp', 'ipco', 'iref', 'grpl',
  ]
  return containerTypes.includes(type)
}

/**
 * Find a box by type
 */
export function findBox(boxes: ISOBMFFBox[], type: string): ISOBMFFBox | undefined {
  for (const box of boxes) {
    if (box.type === type) {
      return box
    }
    if (box.children) {
      const found = findBox(box.children, type)
      if (found) {
        return found
      }
    }
  }
  return undefined
}

/**
 * Find all boxes of a type
 */
export function findAllBoxes(boxes: ISOBMFFBox[], type: string): ISOBMFFBox[] {
  const result: ISOBMFFBox[] = []

  for (const box of boxes) {
    if (box.type === type) {
      result.push(box)
    }
    if (box.children) {
      result.push(...findAllBoxes(box.children, type))
    }
  }

  return result
}

/**
 * Validate AVIF file type
 */
export function validateFtyp(buffer: Uint8Array): boolean {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  // Read box header
  const size = view.getUint32(0)
  const type = String.fromCharCode(buffer[4], buffer[5], buffer[6], buffer[7])

  if (type !== 'ftyp') {
    return false
  }

  // Read major brand
  const majorBrand = String.fromCharCode(buffer[8], buffer[9], buffer[10], buffer[11])

  // Valid AVIF brands
  const validBrands = ['avif', 'avis', 'mif1', 'miaf']

  if (validBrands.includes(majorBrand)) {
    return true
  }

  // Check compatible brands
  const numBrands = (size - 16) / 4

  for (let i = 0; i < numBrands; i++) {
    const offset = 16 + i * 4
    const brand = String.fromCharCode(
      buffer[offset],
      buffer[offset + 1],
      buffer[offset + 2],
      buffer[offset + 3],
    )
    if (validBrands.includes(brand)) {
      return true
    }
  }

  return false
}

/**
 * Parse item location box (iloc)
 */
export function parseIloc(data: Uint8Array): ItemLocation[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  const version = data[0]
  const flags = (data[1] << 16) | (data[2] << 8) | data[3]

  const offsetSize = (data[4] >> 4) & 0x0F
  const lengthSize = data[4] & 0x0F
  const baseOffsetSize = (data[5] >> 4) & 0x0F
  const indexSize = version === 1 || version === 2 ? (data[5] & 0x0F) : 0

  let offset = 6
  let itemCount: number

  if (version < 2) {
    itemCount = view.getUint16(offset)
    offset += 2
  }
  else {
    itemCount = view.getUint32(offset)
    offset += 4
  }

  const items: ItemLocation[] = []

  for (let i = 0; i < itemCount; i++) {
    let itemId: number

    if (version < 2) {
      itemId = view.getUint16(offset)
      offset += 2
    }
    else {
      itemId = view.getUint32(offset)
      offset += 4
    }

    let constructionMethod = 0
    if (version === 1 || version === 2) {
      constructionMethod = view.getUint16(offset) & 0x0F
      offset += 2
    }

    const dataReferenceIndex = view.getUint16(offset)
    offset += 2

    let baseOffset = 0
    if (baseOffsetSize === 4) {
      baseOffset = view.getUint32(offset)
      offset += 4
    }
    else if (baseOffsetSize === 8) {
      baseOffset = view.getUint32(offset) * 0x100000000 + view.getUint32(offset + 4)
      offset += 8
    }

    const extentCount = view.getUint16(offset)
    offset += 2

    const extents: Array<{ extentOffset: number, extentLength: number }> = []

    for (let j = 0; j < extentCount; j++) {
      if (indexSize > 0) {
        offset += indexSize // Skip extent index
      }

      let extentOffset = 0
      if (offsetSize === 4) {
        extentOffset = view.getUint32(offset)
        offset += 4
      }
      else if (offsetSize === 8) {
        extentOffset = view.getUint32(offset) * 0x100000000 + view.getUint32(offset + 4)
        offset += 8
      }

      let extentLength = 0
      if (lengthSize === 4) {
        extentLength = view.getUint32(offset)
        offset += 4
      }
      else if (lengthSize === 8) {
        extentLength = view.getUint32(offset) * 0x100000000 + view.getUint32(offset + 4)
        offset += 8
      }

      extents.push({ extentOffset, extentLength })
    }

    items.push({
      itemId,
      constructionMethod,
      dataReferenceIndex,
      baseOffset,
      extents,
    })
  }

  return items
}

/**
 * Parse item info box (iinf)
 */
export function parseIinf(data: Uint8Array): ItemInfo[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  const version = data[0]

  let offset = 4
  let entryCount: number

  if (version === 0) {
    entryCount = view.getUint16(offset)
    offset += 2
  }
  else {
    entryCount = view.getUint32(offset)
    offset += 4
  }

  const items: ItemInfo[] = []

  for (let i = 0; i < entryCount; i++) {
    const entrySize = view.getUint32(offset)
    const entryType = String.fromCharCode(
      data[offset + 4],
      data[offset + 5],
      data[offset + 6],
      data[offset + 7],
    )

    if (entryType === 'infe') {
      const infeData = data.slice(offset + 8, offset + entrySize)
      const itemInfo = parseInfe(infeData)
      items.push(itemInfo)
    }

    offset += entrySize
  }

  return items
}

function parseInfe(data: Uint8Array): ItemInfo {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  const version = data[0]

  let offset = 4
  let itemId: number
  let itemProtectionIndex: number

  if (version < 2) {
    itemId = view.getUint16(offset)
    offset += 2
    itemProtectionIndex = view.getUint16(offset)
    offset += 2
  }
  else if (version === 2) {
    itemId = view.getUint16(offset)
    offset += 2
    itemProtectionIndex = view.getUint16(offset)
    offset += 2
  }
  else {
    itemId = view.getUint32(offset)
    offset += 4
    itemProtectionIndex = view.getUint16(offset)
    offset += 2
  }

  const itemType = String.fromCharCode(
    data[offset],
    data[offset + 1],
    data[offset + 2],
    data[offset + 3],
  )
  offset += 4

  // Read null-terminated item name
  let itemName = ''
  while (offset < data.length && data[offset] !== 0) {
    itemName += String.fromCharCode(data[offset])
    offset++
  }

  return {
    itemId,
    itemProtectionIndex,
    itemType,
    itemName,
  }
}

/**
 * Parse image spatial extent (ispe)
 */
export function parseIspe(data: Uint8Array): ImageSpatialExtent {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  // Skip version and flags
  const width = view.getUint32(4)
  const height = view.getUint32(8)

  return { width, height }
}

/**
 * Parse pixel information (pixi)
 */
export function parsePixi(data: Uint8Array): PixelInformation {
  // Skip version and flags
  const numChannels = data[4]
  const bitsPerChannel: number[] = []

  for (let i = 0; i < numChannels; i++) {
    bitsPerChannel.push(data[5 + i])
  }

  return { bitsPerChannel }
}

/**
 * Parse AV1 codec configuration (av1C)
 */
export function parseAv1C(data: Uint8Array): AV1CodecConfig {
  const marker = data[0] >> 7
  const version = data[0] & 0x7F

  if (marker !== 1 || version !== 1) {
    throw new Error('Invalid AV1 codec configuration')
  }

  return {
    seqProfile: (data[1] >> 5) & 0x07,
    seqLevelIdx0: data[1] & 0x1F,
    seqTier0: (data[2] >> 7) & 0x01,
    highBitdepth: (data[2] >> 6) & 0x01,
    twelveBit: (data[2] >> 5) & 0x01,
    monochrome: (data[2] >> 4) & 0x01,
    chromaSubsamplingX: (data[2] >> 3) & 0x01,
    chromaSubsamplingY: (data[2] >> 2) & 0x01,
    chromaSamplePosition: data[2] & 0x03,
  }
}

/**
 * Get AVIF info from parsed boxes
 */
export function getAvifInfo(boxes: ISOBMFFBox[]): AvifInfo {
  // Find meta box
  const metaBox = findBox(boxes, 'meta')
  if (!metaBox || !metaBox.children) {
    throw new Error('No meta box found')
  }

  // Find item properties
  const iprpBox = findBox(metaBox.children, 'iprp')
  if (!iprpBox || !iprpBox.children) {
    throw new Error('No item properties box found')
  }

  const ipcoBox = findBox(iprpBox.children, 'ipco')
  if (!ipcoBox || !ipcoBox.children) {
    throw new Error('No item property container found')
  }

  // Get dimensions from ispe
  const ispeBox = findBox(ipcoBox.children, 'ispe')
  let width = 0
  let height = 0

  if (ispeBox) {
    const extent = parseIspe(ispeBox.data)
    width = extent.width
    height = extent.height
  }

  // Get bit depth from pixi
  const pixiBox = findBox(ipcoBox.children, 'pixi')
  let bitDepth = 8

  if (pixiBox) {
    const pixelInfo = parsePixi(pixiBox.data)
    if (pixelInfo.bitsPerChannel.length > 0) {
      bitDepth = pixelInfo.bitsPerChannel[0]
    }
  }

  // Get codec config from av1C
  const av1cBox = findBox(ipcoBox.children, 'av1C')
  let colorSpace = 'srgb'

  if (av1cBox) {
    const config = parseAv1C(av1cBox.data)
    if (config.highBitdepth) {
      bitDepth = config.twelveBit ? 12 : 10
    }
  }

  // Check for alpha
  const iinfBox = findBox(metaBox.children, 'iinf')
  let hasAlpha = false

  if (iinfBox) {
    const items = parseIinf(iinfBox.data)
    hasAlpha = items.some(item => item.itemType === 'auxl' || item.itemName.includes('Alpha'))
  }

  // Check for sequence
  const isSequence = boxes.some(box => box.type === 'moov')

  return {
    width,
    height,
    hasAlpha,
    bitDepth,
    colorSpace,
    isSequence,
  }
}

/**
 * Get image item data
 */
export function getImageData(
  buffer: Uint8Array,
  boxes: ISOBMFFBox[],
  itemId: number,
): Uint8Array | null {
  // Find meta box
  const metaBox = findBox(boxes, 'meta')
  if (!metaBox || !metaBox.children) {
    return null
  }

  // Find iloc box
  const ilocBox = findBox(metaBox.children, 'iloc')
  if (!ilocBox) {
    return null
  }

  const locations = parseIloc(ilocBox.data)
  const location = locations.find(loc => loc.itemId === itemId)

  if (!location) {
    return null
  }

  // Find mdat box for data offset
  const mdatBox = findBox(boxes, 'mdat')
  const mdatOffset = mdatBox ? mdatBox.offset + 8 : 0

  // Collect all extents
  const parts: Uint8Array[] = []

  for (const extent of location.extents) {
    const offset = location.baseOffset + extent.extentOffset + mdatOffset
    const data = buffer.slice(offset, offset + extent.extentLength)
    parts.push(data)
  }

  // Concatenate parts
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0

  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }

  return result
}

/**
 * Create ftyp box for AVIF
 */
export function createFtyp(): Uint8Array {
  const brands = ['avif', 'mif1', 'miaf', 'MA1A']
  const size = 8 + 4 + 4 + brands.length * 4

  const buffer = new Uint8Array(size)
  const view = new DataView(buffer.buffer)

  // Size
  view.setUint32(0, size)

  // Type 'ftyp'
  buffer[4] = 0x66 // f
  buffer[5] = 0x74 // t
  buffer[6] = 0x79 // y
  buffer[7] = 0x70 // p

  // Major brand 'avif'
  buffer[8] = 0x61 // a
  buffer[9] = 0x76 // v
  buffer[10] = 0x69 // i
  buffer[11] = 0x66 // f

  // Minor version
  view.setUint32(12, 0)

  // Compatible brands
  let offset = 16
  for (const brand of brands) {
    for (let i = 0; i < 4; i++) {
      buffer[offset + i] = brand.charCodeAt(i)
    }
    offset += 4
  }

  return buffer
}

import type { AvifAnimation, AvifDecodeOptions, AvifImageData } from './types'
import type { AvifItemInfo } from './container/avif'
import { decodeAV1, decodeAV1Sequence } from './av1/decoder'
import { getAvifItemInfo, getItemPayload } from './container/avif'
import {
  findBox,
  getAvifInfo,
  parseISOBMFF,
  parseIinf,
  validateFtyp,
} from './container/heif'
import { getAvifTrack } from './container/sequence'


/**
 * Parse everything knowable without entropy-decoding pixels: dimensions,
 * grid layout, rotation/mirror, bit depth, and the av1C configuration.
 * Property lookups are per-item (ipma-based), so grid images report the
 * full output size instead of a tile's.
 */
export function getAvifMetadata(buffer: Uint8Array | ArrayBuffer): AvifItemInfo {
  const data = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer
  if (!validateFtyp(data))
    throw new Error('ts-avif: not a valid AVIF/HEIF file')
  const boxes = parseISOBMFF(data)
  return getAvifItemInfo(data, boxes)
}

/**
 * Decode an AVIF image buffer to RGBA pixel data
 */
export function decode(
  buffer: Uint8Array | ArrayBuffer,
  options: AvifDecodeOptions = {},
): AvifImageData {
  const data = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer

  // Validate file type
  if (!validateFtyp(data)) {
    throw new Error('Invalid AVIF file: not a valid AVIF or HEIF file')
  }

  // Parse ISOBMFF boxes
  const boxes = parseISOBMFF(data)

  // Get file info
  const info = getAvifInfo(boxes)

  // Find the primary item
  const primaryItemId = getPrimaryItemId(boxes)
  if (primaryItemId === null) {
    throw new Error('No primary item found')
  }

  // Get image data for primary item
  const av1Data = getItemPayload(data, boxes, primaryItemId)
  if (!av1Data) {
    throw new Error('Could not locate image data')
  }

  // Decode AV1 bitstream
  const imageData = decodeAV1(av1Data)

  // Handle alpha if present and not ignored
  if (info.hasAlpha && !options.ignoreAlpha) {
    const alphaItemId = getAlphaItemId(boxes)
    if (alphaItemId !== null) {
      const alphaData = getItemPayload(data, boxes, alphaItemId)
      if (alphaData) {
        const alphaImage = decodeAV1(alphaData)
        applyAlphaChannel(imageData, alphaImage)
      }
    }
  }

  // Convert to RGB if requested
  if (options.format === 'rgb') {
    imageData.data = rgbaToRgb(imageData.data)
  }

  return imageData
}

/** Decode every presentation sample in an animated AVIF sequence. */
export function decodeSequence(
  buffer: Uint8Array | ArrayBuffer,
  options: AvifDecodeOptions = {},
): AvifAnimation {
  const data = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer
  if (!validateFtyp(data)) throw new Error('Invalid AVIF file: not a valid AVIF or HEIF file')
  const boxes = parseISOBMFF(data)
  const track = getAvifTrack(data, boxes)
  const decoded = decodeAV1Sequence(track.samples.map(sample => sample.data))
  let timestamp = 0
  const frames = decoded.map((image, index) => {
    const duration = track.samples[index].duration
    if (options.format === 'rgb') image.data = rgbaToRgb(image.data)
    const frame = { ...image, duration, timestamp }
    timestamp += duration
    return frame
  })
  return { frames, timescale: track.timescale, duration: track.duration }
}

function getPrimaryItemId(boxes: any[]): number | null {
  // Find meta box
  const metaBox = findBox(boxes, 'meta')
  if (!metaBox || !metaBox.children) {
    return null
  }

  // Find pitm (primary item) box
  const pitmBox = findBox(metaBox.children, 'pitm')
  if (!pitmBox) {
    // Default to item 1 if no pitm box
    return 1
  }

  const view = new DataView(
    pitmBox.data.buffer,
    pitmBox.data.byteOffset,
    pitmBox.data.byteLength,
  )

  const version = pitmBox.data[0]

  if (version === 0) {
    return view.getUint16(4)
  }
  else {
    return view.getUint32(4)
  }
}

function getAlphaItemId(boxes: any[]): number | null {
  // Find meta box
  const metaBox = findBox(boxes, 'meta')
  if (!metaBox || !metaBox.children) {
    return null
  }

  // Find iinf box
  const iinfBox = findBox(metaBox.children, 'iinf')
  if (!iinfBox) {
    return null
  }

  const items = parseIinf(iinfBox.data)

  // Look for auxiliary image (alpha)
  for (const item of items) {
    if (item.itemType === 'auxl' || item.itemName.toLowerCase().includes('alpha')) {
      return item.itemId
    }
  }

  return null
}

function applyAlphaChannel(imageData: AvifImageData, alphaImage: AvifImageData): void {
  const { data, width, height } = imageData

  if (alphaImage.width !== width || alphaImage.height !== height) {
    throw new Error('Alpha image dimensions do not match')
  }

  // Apply alpha from the gray channel of the alpha image
  for (let i = 0; i < width * height; i++) {
    data[i * 4 + 3] = alphaImage.data[i * 4] // Use R channel as alpha
  }

  imageData.hasAlpha = true
}

function rgbaToRgb(rgba: Uint8Array): Uint8Array {
  const numPixels = rgba.length / 4
  const rgb = new Uint8Array(numPixels * 3)

  for (let i = 0; i < numPixels; i++) {
    rgb[i * 3] = rgba[i * 4]
    rgb[i * 3 + 1] = rgba[i * 4 + 1]
    rgb[i * 3 + 2] = rgba[i * 4 + 2]
  }

  return rgb
}

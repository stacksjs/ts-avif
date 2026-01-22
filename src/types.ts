/**
 * AVIF image data
 */
export interface AvifImageData {
  /** Pixel data in RGBA format (4 bytes per pixel) */
  data: Uint8Array
  /** Image width in pixels */
  width: number
  /** Image height in pixels */
  height: number
  /** Whether the image has an alpha channel */
  hasAlpha?: boolean
  /** Color depth (8, 10, or 12 bits) */
  bitDepth?: 8 | 10 | 12
}

/**
 * AVIF encoding options
 */
export interface AvifEncodeOptions {
  /** Quality (0-100, default: 80) */
  quality?: number
  /** Use lossless encoding */
  lossless?: boolean
  /** Speed/effort trade-off (0-10, default: 6) */
  effort?: number
  /** Enable alpha channel */
  alpha?: boolean
  /** Chroma subsampling (default: '4:2:0') */
  chromaSubsampling?: '4:2:0' | '4:2:2' | '4:4:4'
}

/**
 * AVIF decoding options
 */
export interface AvifDecodeOptions {
  /** Output format */
  format?: 'rgba' | 'rgb'
  /** Ignore alpha channel */
  ignoreAlpha?: boolean
}

/**
 * ISOBMFF box structure
 */
export interface ISOBMFFBox {
  type: string
  size: number
  offset: number
  data: Uint8Array
  children?: ISOBMFFBox[]
}

/**
 * AVIF file info
 */
export interface AvifInfo {
  width: number
  height: number
  hasAlpha: boolean
  bitDepth: number
  colorSpace: string
  isSequence: boolean
}

/**
 * Item location entry
 */
export interface ItemLocation {
  itemId: number
  constructionMethod: number
  dataReferenceIndex: number
  baseOffset: number
  extents: Array<{
    extentOffset: number
    extentLength: number
  }>
}

/**
 * Item info entry
 */
export interface ItemInfo {
  itemId: number
  itemProtectionIndex: number
  itemType: string
  itemName: string
  contentType?: string
  contentEncoding?: string
}

/**
 * Image spatial extent
 */
export interface ImageSpatialExtent {
  width: number
  height: number
}

/**
 * Pixel information
 */
export interface PixelInformation {
  bitsPerChannel: number[]
}

/**
 * AV1 codec configuration
 */
export interface AV1CodecConfig {
  seqProfile: number
  seqLevelIdx0: number
  seqTier0: number
  highBitdepth: number
  twelveBit: number
  monochrome: number
  chromaSubsamplingX: number
  chromaSubsamplingY: number
  chromaSamplePosition: number
}

/**
 * AV1 OBU (Open Bitstream Unit)
 */
export interface AV1OBU {
  type: number
  size: number
  data: Uint8Array
}

/**
 * AV1 OBU types
 */
export enum OBUType {
  SEQUENCE_HEADER = 1,
  TEMPORAL_DELIMITER = 2,
  FRAME_HEADER = 3,
  TILE_GROUP = 4,
  METADATA = 5,
  FRAME = 6,
  REDUNDANT_FRAME_HEADER = 7,
  TILE_LIST = 8,
  PADDING = 15,
}

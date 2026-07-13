import type { AvifEncodeOptions, AvifImageData } from './types'
import { OBUType } from './types'
import { encodeFrameHeader, encodeSequenceHeader } from './av1/encode-headers'
import { encodeIntraTile, rgbaToYuv420 } from './av1/encode-tile'
import { createOBU } from './av1/obu'
import { writeAvif } from './container/writer'

/** Encode opaque 8-bit RGBA pixels with the bundled TypeScript AV1 encoder. */
export function encode(
  imageData: AvifImageData,
  options: AvifEncodeOptions = {},
): Uint8Array {
  validateOptions(imageData, options)
  const av1 = encodeAV1(imageData.data, imageData.width, imageData.height, options)
  return writeAvif(av1, imageData.width, imageData.height)
}

/** Promise-returning form retained for callers with an asynchronous pipeline. */
export async function encodeAsync(
  imageData: AvifImageData,
  options: AvifEncodeOptions = {},
): Promise<Uint8Array> {
  return encode(imageData, options)
}

/** Encode an AV1 low-overhead OBU stream without the AVIF container. */
export function encodeAV1(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: AvifEncodeOptions = {},
): Uint8Array {
  validateCodecOptions(options)
  const q = qualityToQIndex(options.quality ?? 80)
  const sequence = createOBU(OBUType.SEQUENCE_HEADER, encodeSequenceHeader(width, height))
  const frameHeader = encodeFrameHeader(width, height, q)
  const tile = encodeIntraTile(rgbaToYuv420(rgba, width, height), q)
  const framePayload = concat([frameHeader, tile])
  const frame = createOBU(OBUType.FRAME, framePayload)
  return concat([sequence, frame])
}

/** Map the public quality scale to AV1's inverse 8-bit base quantizer. */
export function qualityToQIndex(quality: number): number {
  if (!Number.isFinite(quality) || quality < 0 || quality > 100)
    throw new RangeError('ts-avif: quality must be between 0 and 100')
  return Math.max(1, Math.min(255, Math.round((100 - quality) * 2.55)))
}

function validateOptions(imageData: AvifImageData, options: AvifEncodeOptions): void {
  const { width, height, data } = imageData
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new RangeError('ts-avif: width and height must be positive integers')
  if (width > 4096 || height > 2304)
    throw new RangeError('ts-avif: pure TypeScript encoder currently supports frames up to 4096x2304')
  if (data.byteLength !== width * height * 4)
    throw new Error('ts-avif: imageData.data must be RGBA (width × height × 4 bytes)')
  if (imageData.bitDepth !== undefined && imageData.bitDepth !== 8)
    throw new Error('ts-avif: pure TypeScript encoder currently supports only 8-bit input')
  if (options.alpha || imageData.hasAlpha)
    throw new Error('ts-avif: alpha encoding is not implemented yet')
  validateCodecOptions(options)
}

function validateCodecOptions(options: AvifEncodeOptions): void {
  if (options.lossless)
    throw new Error('ts-avif: lossless AV1 encoding is not implemented yet')
  if (options.chromaSubsampling && options.chromaSubsampling !== '4:2:0')
    throw new Error('ts-avif: pure TypeScript encoder currently supports only 4:2:0 chroma')
  qualityToQIndex(options.quality ?? 80)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

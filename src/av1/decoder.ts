import type { AvifImageData } from '../types'
import type { SequenceHeader } from './sequence'
import { OBUType } from '../types'
import { parseOBUs } from './obu'
import { parseSequenceHeader } from './sequence'

/**
 * Decode an AV1 still-image bitstream (sequence header + intra frame) to
 * RGBA pixels.
 */
export function decodeAV1(data: Uint8Array): AvifImageData {
  const obus = parseOBUs(data)

  const seqHeaderOBU = obus.find(obu => obu.type === OBUType.SEQUENCE_HEADER)
  if (!seqHeaderOBU)
    throw new Error('No sequence header found')

  const seqHeader = parseSequenceHeader(seqHeaderOBU.data)

  const frameOBU = obus.find(obu => obu.type === OBUType.FRAME)
  if (!frameOBU)
    throw new Error('No frame data found')

  const pixels = decodeFrame(frameOBU.data, seqHeader)

  return {
    data: pixels,
    width: seqHeader.maxFrameWidth,
    height: seqHeader.maxFrameHeight,
    hasAlpha: false, // alpha rides in a separate auxiliary item
    bitDepth: seqHeader.bitDepth as 8 | 10 | 12,
  }
}

function decodeFrame(data: Uint8Array, seqHeader: SequenceHeader): Uint8Array {
  const { maxFrameWidth: width, maxFrameHeight: height } = seqHeader

  // The AV1 tile decoder (entropy decode, intra prediction, transforms,
  // reconstruction) is not wired up yet. Failing loudly beats the old
  // behavior of silently returning a gray placeholder that looked like a
  // successful decode.
  throw new Error(
    `ts-avif: AV1 frame decoding is not implemented yet `
    + `(${width}x${height}, ${data.length} byte frame OBU parsed). `
    + `Container, OBU, and sequence-header layers are complete — the entropy `
    + `decoder is the remaining work. Use getAvifMetadata() for everything `
    + `knowable without decoding pixels.`,
  )
}

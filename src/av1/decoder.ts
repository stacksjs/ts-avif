import type { AvifImageData } from '../types'
import { OBUType } from '../types'
import { decodeFrame, yuvToRgba } from './frame-decoder'
import { parseOBUs } from './obu'
import { parseSequenceHeader } from './sequence'
import { parseFrameOBU } from './tile-group'

/**
 * Decode an AV1 still-image bitstream (sequence header + intra frame) to
 * RGBA pixels.
 */
export function decodeAV1(data: Uint8Array): AvifImageData {
  const obus = parseOBUs(data)

  const seqHeaderOBU = obus.find(obu => obu.type === OBUType.SEQUENCE_HEADER)
  if (!seqHeaderOBU)
    throw new Error('No sequence header found')

  const seq = parseSequenceHeader(seqHeaderOBU.data)

  const frameOBU = obus.find(obu => obu.type === OBUType.FRAME)
  if (!frameOBU)
    throw new Error('No frame data found')

  const { header, tiles } = parseFrameOBU(frameOBU.data, seq)
  const frame = decodeFrame(seq, header, tiles)
  const pixels = yuvToRgba(frame, seq)

  return {
    data: pixels,
    width: frame.width,
    height: frame.height,
    hasAlpha: false, // alpha rides in a separate auxiliary item
    bitDepth: seq.bitDepth as 8 | 10 | 12,
  }
}

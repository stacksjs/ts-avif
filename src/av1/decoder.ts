import type { AvifImageData } from '../types'
import { OBUType } from '../types'
import { BitReader } from './bits'
import { decodeFrame, yuvToRgba } from './frame-decoder'
import { parseFrameHeader } from './frame-header'
import { parseOBUs } from './obu'
import { parseSequenceHeader } from './sequence'
import { parseFrameOBU } from './tile-group'
import { parseTileGroup } from './tile-group'

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

/** Decode a sequence of all-intra AV1 samples while carrying the sequence header. */
export function decodeAV1Sequence(samples: Uint8Array[]): AvifImageData[] {
  let seq: ReturnType<typeof parseSequenceHeader> | null = null
  const frames: AvifImageData[] = []
  for (const sample of samples) {
    const obus = parseOBUs(sample)
    const sequence = obus.find(obu => obu.type === OBUType.SEQUENCE_HEADER)
    if (sequence) seq = parseSequenceHeader(sequence.data)
    if (!seq) throw new Error('ts-avif: AV1 sequence sample has no sequence header')

    const frameObu = obus.find(obu => obu.type === OBUType.FRAME)
    let parsed
    if (frameObu) {
      parsed = parseFrameOBU(frameObu.data, seq)
    }
    else {
      const headerObu = obus.find(obu => obu.type === OBUType.FRAME_HEADER)
      if (!headerObu) continue
      const header = parseFrameHeader(new BitReader(headerObu.data), seq)
      const tiles = obus
        .filter(obu => obu.type === OBUType.TILE_GROUP)
        .flatMap(obu => parseTileGroup(obu.data, header))
      parsed = { header, tiles }
    }
    const frame = decodeFrame(seq, parsed.header, parsed.tiles)
    frames.push({
      data: yuvToRgba(frame, seq),
      width: frame.width,
      height: frame.height,
      hasAlpha: false,
      bitDepth: seq.bitDepth as 8 | 10 | 12,
    })
  }
  return frames
}

import type { AvifImageData } from '../types'
import { OBUType } from '../types'
import { BitReader } from './bits'
import { decodeFrame, yuvToRgba } from './frame-decoder'
import type { FrameHeader, FrameHeaderState } from './frame-header'
import type { FrameBuffers } from './recon'
import type { CdfContext } from './cdf'
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

/** Decode display frames from AV1 samples while maintaining all eight reference slots. */
export function decodeAV1Sequence(samples: Uint8Array[]): AvifImageData[] {
  let seq: ReturnType<typeof parseSequenceHeader> | null = null
  const headerState: FrameHeaderState = { refs: new Array<FrameHeader | null>(8).fill(null) }
  const referenceBuffers = new Array<FrameBuffers | null>(8).fill(null)
  const displayed = new Array<AvifImageData | null>(8).fill(null)
  const referenceCdfs = new Array<CdfContext | null>(8).fill(null)
  const frames: AvifImageData[] = []
  for (const sample of samples) {
    const obus = parseOBUs(sample)
    const sequence = obus.find(obu => obu.type === OBUType.SEQUENCE_HEADER)
    if (sequence) seq = parseSequenceHeader(sequence.data)
    if (!seq) throw new Error('ts-avif: AV1 sequence sample has no sequence header')

    const frameObu = obus.find(obu => obu.type === OBUType.FRAME)
    let parsed
    if (frameObu) {
      parsed = parseFrameOBU(frameObu.data, seq, headerState)
    }
    else {
      const headerObu = obus.find(obu => obu.type === OBUType.FRAME_HEADER)
      if (!headerObu) continue
      const header = parseFrameHeader(new BitReader(headerObu.data), seq, headerState)
      const tiles = obus
        .filter(obu => obu.type === OBUType.TILE_GROUP)
        .flatMap(obu => parseTileGroup(obu.data, header))
      parsed = { header, tiles }
    }
    if (parsed.header.showExistingFrame) {
      const existing = displayed[parsed.header.existingFrameIdx]
      if (!existing)
        throw new Error(`ts-avif: show_existing_frame references unavailable pixels in slot ${parsed.header.existingFrameIdx}`)
      frames.push(existing)
      continue
    }

    const refs = parsed.header.refFrameIdx.map(slot => referenceBuffers[slot] ?? null)
    const primarySlot = parsed.header.primaryRefFrame < 7
      ? parsed.header.refFrameIdx[parsed.header.primaryRefFrame]
      : -1
    const inheritedCdf = primarySlot >= 0 ? referenceCdfs[primarySlot] : null
    const frame = decodeFrame(seq, parsed.header, parsed.tiles, refs, inheritedCdf)
    const image: AvifImageData = {
      data: yuvToRgba(frame, seq),
      width: frame.width,
      height: frame.height,
      hasAlpha: false,
      bitDepth: seq.bitDepth as 8 | 10 | 12,
    }
    for (let slot = 0; slot < 8; slot++) {
      if (parsed.header.refreshFrameFlags & (1 << slot)) {
        headerState.refs[slot] = parsed.header
        referenceBuffers[slot] = frame.referenceBuf
        displayed[slot] = image
        referenceCdfs[slot] = frame.cdf
      }
    }
    if (parsed.header.showFrame)
      frames.push(image)
  }
  return frames
}

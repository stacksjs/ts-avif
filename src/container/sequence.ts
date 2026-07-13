import type { ISOBMFFBox } from '../types'
import { findBox } from './heif'

export interface AvifTrackSample {
  data: Uint8Array
  duration: number
  sync: boolean
}

export interface AvifTrack {
  timescale: number
  duration: number
  samples: AvifTrackSample[]
}

function view(box: ISOBMFFBox): DataView {
  return new DataView(box.data.buffer, box.data.byteOffset, box.data.byteLength)
}

function parseTimescale(mdia: ISOBMFFBox): number {
  const box = findBox(mdia.children ?? [], 'mdhd')
  if (!box) throw new Error('ts-avif: sequence track has no mdhd box')
  const v = view(box)
  return v.getUint32(box.data[0] === 1 ? 20 : 12)
}

function parseSizes(box: ISOBMFFBox): number[] {
  const v = view(box)
  const fixed = v.getUint32(4)
  const count = v.getUint32(8)
  if (fixed) return Array.from({ length: count }, () => fixed)
  if (12 + count * 4 > box.data.length)
    throw new Error('ts-avif: truncated stsz sample table')
  return Array.from({ length: count }, (_, i) => v.getUint32(12 + i * 4))
}

function parseDurations(box: ISOBMFFBox, sampleCount: number): number[] {
  const v = view(box)
  const entries = v.getUint32(4)
  const durations: number[] = []
  for (let i = 0; i < entries; i++) {
    const count = v.getUint32(8 + i * 8)
    const delta = v.getUint32(12 + i * 8)
    for (let n = 0; n < count; n++) durations.push(delta)
  }
  if (durations.length !== sampleCount)
    throw new Error('ts-avif: stts and stsz sample counts disagree')
  return durations
}

function parseChunkOffsets(box: ISOBMFFBox): number[] {
  const v = view(box)
  const count = v.getUint32(4)
  if (box.type === 'stco')
    return Array.from({ length: count }, (_, i) => v.getUint32(8 + i * 4))
  return Array.from({ length: count }, (_, i) => {
    const high = v.getUint32(8 + i * 8)
    return high * 0x100000000 + v.getUint32(12 + i * 8)
  })
}

function parseSampleToChunk(box: ISOBMFFBox): { first: number, count: number }[] {
  const v = view(box)
  const entries = v.getUint32(4)
  return Array.from({ length: entries }, (_, i) => ({
    first: v.getUint32(8 + i * 12),
    count: v.getUint32(12 + i * 12),
  }))
}

/** Extract the timed AV1 samples from the first visual track in an AVIF sequence. */
export function getAvifTrack(data: Uint8Array, boxes: ISOBMFFBox[]): AvifTrack {
  const moov = boxes.find(box => box.type === 'moov')
  if (!moov)
    throw new Error('ts-avif: AVIF file has no sequence track')
  const tracks = (moov.children ?? []).filter(box => box.type === 'trak')
  const trak = tracks.find((candidate) => {
    const hdlr = findBox(candidate.children ?? [], 'hdlr')
    return hdlr && String.fromCharCode(...hdlr.data.subarray(8, 12)) === 'vide'
  }) ?? tracks[0]
  if (!trak)
    throw new Error('ts-avif: AVIF sequence has no track')
  const mdia = findBox(trak.children ?? [], 'mdia')!
  const stbl = findBox(trak.children ?? [], 'stbl')
  if (!mdia || !stbl?.children)
    throw new Error('ts-avif: incomplete AVIF sample table')
  const child = (type: string): ISOBMFFBox => {
    const box = stbl.children!.find(entry => entry.type === type)
    if (!box) throw new Error(`ts-avif: sequence sample table has no ${type}`)
    return box
  }
  const sizes = parseSizes(child('stsz'))
  const durations = parseDurations(child('stts'), sizes.length)
  const offsetsBox = stbl.children.find(box => box.type === 'stco' || box.type === 'co64')
  if (!offsetsBox) throw new Error('ts-avif: sequence sample table has no chunk offsets')
  const chunkOffsets = parseChunkOffsets(offsetsBox)
  const mapping = parseSampleToChunk(child('stsc'))
  const syncBox = stbl.children.find(box => box.type === 'stss')
  const sync = new Set<number>()
  if (syncBox) {
    const v = view(syncBox)
    for (let i = 0; i < v.getUint32(4); i++) sync.add(v.getUint32(8 + i * 4))
  }

  const samples: AvifTrackSample[] = []
  let sample = 0
  for (let chunk = 1; chunk <= chunkOffsets.length; chunk++) {
    let entry = mapping[0]
    for (const candidate of mapping) {
      if (candidate.first > chunk) break
      entry = candidate
    }
    let offset = chunkOffsets[chunk - 1]
    for (let i = 0; i < entry.count && sample < sizes.length; i++, sample++) {
      const end = offset + sizes[sample]
      if (offset < 0 || end > data.length)
        throw new Error(`ts-avif: sample ${sample + 1} extends past the file`)
      samples.push({
        data: data.subarray(offset, end),
        duration: durations[sample],
        sync: syncBox ? sync.has(sample + 1) : true,
      })
      offset = end
    }
  }
  if (sample !== sizes.length)
    throw new Error('ts-avif: chunk map does not cover every sample')
  const timescale = parseTimescale(mdia)
  return { timescale, duration: durations.reduce((sum, value) => sum + value, 0), samples }
}

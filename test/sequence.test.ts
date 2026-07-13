import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'bun:test'
import { decodeSequence } from '../src/decoder'

const STREAM = 'EgAKCgAAAAIn/m18wCAyDhAAj4AAAgAAAAA+/WBgEgAKCgAAAAIn/m18wCAyFRAAj4AAAgAAAAA8daFQhoVmlbCqMA=='

function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4)
  const view = new DataView(out.buffer)
  values.forEach((value, index) => view.setUint32(index * 4, value))
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}

function box(type: string, payload: Uint8Array): Uint8Array {
  return concat(u32(payload.length + 8), new TextEncoder().encode(type), payload)
}

function buildSequence(): Uint8Array {
  const stream = new Uint8Array(Buffer.from(STREAM, 'base64'))
  const samples = [stream.subarray(0, 30), stream.subarray(30)]
  const ftyp = box('ftyp', concat(new TextEncoder().encode('avis'), u32(0), new TextEncoder().encode('avisavif')))
  const makeMoov = (chunkOffset: number): Uint8Array => {
    const mdhd = box('mdhd', concat(u32(0, 0, 0, 1000, 200), u32(0)))
    const hdlrPayload = new Uint8Array(20)
    hdlrPayload.set(new TextEncoder().encode('vide'), 8)
    const hdlr = box('hdlr', hdlrPayload)
    const stts = box('stts', concat(u32(0, 1, 2, 100)))
    const stsc = box('stsc', concat(u32(0, 1, 1, 2, 1)))
    const stsz = box('stsz', concat(u32(0, 0, 2, samples[0].length, samples[1].length)))
    const stco = box('stco', concat(u32(0, 1, chunkOffset)))
    const stbl = box('stbl', concat(stts, stsc, stsz, stco))
    return box('moov', box('trak', box('mdia', concat(mdhd, hdlr, box('minf', stbl)))))
  }
  const placeholder = makeMoov(0)
  const moov = makeMoov(ftyp.length + placeholder.length + 8)
  return concat(ftyp, moov, box('mdat', concat(...samples)))
}

describe('animated AVIF sequences', () => {
  it('extracts timing and decodes every all-intra track sample', () => {
    const animation = decodeSequence(buildSequence())
    expect(animation.timescale).toBe(1000)
    expect(animation.duration).toBe(200)
    expect(animation.frames).toHaveLength(2)
    expect(animation.frames.map(frame => frame.timestamp)).toEqual([0, 100])
    expect(animation.frames.map(frame => frame.duration)).toEqual([100, 100])
    expect(animation.frames[0].data[0]).toBe(19)
    expect(animation.frames[1].data.slice(0, 3)).toEqual(new Uint8Array([255, 226, 161]))
  })
})

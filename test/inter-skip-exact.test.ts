import { describe, expect, test } from 'bun:test'
import { decodeAV1Sequence } from '../src/av1/decoder'

// libaom two-frame stream: the second image is a single-reference INTER_FRAME
// using a zero-motion NEARESTMV predictor from the keyframe.
const STREAM = Uint8Array.fromBase64(
  'EgAKCgAAAAIn/m18wCAyDhAAj4AAAgAAAAA+/WBgEgAyEjADwIAAAEazgAACQAAAgACMcA==',
)

function splitTemporalUnits(data: Uint8Array): Uint8Array[] {
  // This fixture uses one-byte OBU headers and one-byte LEB128 sizes. Split at
  // the second temporal delimiter while retaining the sequence header in TU 0.
  const secondDelimiter = data.indexOf(0x12, 2)
  return [data.subarray(0, secondDelimiter), data.subarray(secondDelimiter)]
}

describe('inter frame decoding', () => {
  test('reconstructs an identical inter frame bit-exactly', () => {
    const frames = decodeAV1Sequence(splitTemporalUnits(STREAM))
    expect(frames).toHaveLength(2)
    expect(frames[1].width).toBe(32)
    expect(frames[1].height).toBe(32)
    expect(frames[1].data).toEqual(frames[0].data)
  })
})

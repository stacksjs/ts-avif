import type { PixelPlane } from '../src/av1/pixels'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'bun:test'
import { decodeFrame } from '../src/av1/frame-decoder'
import { parseOBUs } from '../src/av1/obu'
import { parseSequenceHeader } from '../src/av1/sequence'
import { parseFrameOBU } from '../src/av1/tile-group'
import { OBUType } from '../src/types'

/** Lossless libaom screen-content output using luma and chroma palettes. */
const OBU = 'EgAKBhgZv/9kAjK4CEQAANuhga43L31h8s9gxLLwQkSe/1lnsbe/9PRMgUhEe/JtT6IQKxXC2xOx9To9Q5GV8fPH9pAmZBnsjgPLdDN4wFWvd8mKhM5RfR9b6J0fy0jlOh5Q0pPS0C8tR+ScK+DrBnQMk9sx9VrIQKPTi+yFxR1t2c8sF337zPRLrLbhSJlb/OE1QokOTGroCScaYRmBmdqbGDXRQ9/SzHOZR6MTD6uTLQKoEjTv0H5cRiQ6DetxaFs1vl8hAwLTU6dqpWZWFEwWvfVPoSfUsRk6FrtVuetI0DCw1eV1QakcQAI9iSK5XXJLFdpuJRzSk1/lumqvpYk22ZNjyTvHh2VPaJGr05Qy6oZ+GC2Yhs/EWMOnMJ8lDV5i8QbZwL1C3JOogFOo4HMr54BmI//OGKEBtsu07/hx+KwhpPp3qvr7HqX3gyEgNHSIIyTvs9AFHdqq35jk3HqKUZ3yIqj6k3EJ8PA7GUeqxGjBDVlu36G75V4yH2oKHpzEaCvXd8IR6KVEx1cYpRUED3NoyequL4ax/ThbLLUEiPv6qSy/HvtPelY+6kB6E/EOAozHqkUE61lg3BWTTHZbHvm0oGRiS+VUiVZpcTFHs1p45lNvGjopO472pA+2V+m0FVINwEJnEOmC1Nq9oKyrp7GsgGSLPzHatjlpHHQPys2CGeTrhklMl7OiyHawKVh9DOcOULWw6lQxdU5p6vH3uTbedcZvPxYXcrTuzdJ3X646dEjFRyEyKhhuPEsO9Rr/xtl+eyiiTMBlkSYjfzzKxOKRlEQbO4gNrXQ2V2dbfnZWmcX8Ee6VJyQVqGQiAG5AFViOpnCMsSR0nAlVNJATQRlvB/Zj06EFe73dq5P0en57BLQra3wKGDEJTQ0yHpIJpc8vuSSGL0cbewKypX264cvK/FuAPe0plWEfUVtqM+Dt3h5eNuK2MSmo0KBrSfjlHZgx4z1AqMWzQ6P2E6OGBrZp69EwSEO8FPuMITHLgoWwZj1SKCdbviWYHJE3czAUmeMulsyni0a7mQpif2Bi1e6CtEb7RMB5f9Hf0QTxygG0klITHuyGqqqAEovc5JkwpTNPzQk8ZmcSSfvk9U69jCD96WyFHujmYLJnINrtM0bDl/TF5Wh3Q7ubAHzE/Fqym8Wifa4JsTL2sVHImC0b8p3t6ZdLZlPLO8CCdGVFaFn/l/ArcGSsAdUT/vQzlxRD5VN3FNY8SPLe5Kt30Ibus75pFtjMNFffHzfFv6s9jYSG4nPfpyaZ+9lHpvVJTPbdfmUemTFu2RqfI42KfKOEEHogLJ/k0LaPtBxxWHK+97Tam6adafkDfBtkfozMVEIw2mfJL7IM5VqpOYONoVFd+TArduJFGVHnl212VJIUseBSLcDk6sniIutCPC1EmUcnKSZpBjhKZ52ECelTKsx+iZ/xG5Azpcv2ipQPHH64lp++gA=='

function fnv(plane: PixelPlane): string {
  const prime = 0x100000001B3n
  const mask = 0xFFFFFFFFFFFFFFFFn
  let hash = 1469598103934665603n
  for (const sample of plane) {
    hash ^= BigInt(sample)
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

describe('palette mode vs libaom', () => {
  it('matches lossless luma/chroma palette reconstruction bit-exactly', () => {
    const obus = parseOBUs(new Uint8Array(Buffer.from(OBU, 'base64')))
    const seq = parseSequenceHeader(obus.find(o => o.type === OBUType.SEQUENCE_HEADER)!.data)
    const { header, tiles } = parseFrameOBU(obus.find(o => o.type === OBUType.FRAME)!.data, seq)
    const frame = decodeFrame(seq, header, tiles)

    expect(header.allowScreenContentTools).toBe(true)
    expect(header.codedLossless).toBe(true)
    expect(fnv(frame.buf.y)).toBe('6de83851d7780383')
    expect(fnv(frame.buf.u)).toBe('075e3785c2e70383')
    expect(fnv(frame.buf.v)).toBe('39c4f2536cfbc383')
  })
})


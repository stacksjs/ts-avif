import type { PixelPlane } from '../src/av1/pixels'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'bun:test'
import { decodeFrame } from '../src/av1/frame-decoder'
import { parseOBUs } from '../src/av1/obu'
import { parseSequenceHeader } from '../src/av1/sequence'
import { parseFrameOBU } from '../src/av1/tile-group'
import { OBUType } from '../src/types'

/** 10-bit libaom film-grain preset 15: overlap plus chroma scaling from luma. */
const OBU = 'EgAKBhgZv/9mBjLbCkRQAAAEBbCvEAYPQri7NsA6Q1nPPbpcQUE0PcDAt1K/QDjTnUFBtD2/wDdTP0A406Sk23EclnRqJaTx4A2Y/W5GbBrfCNHJvdxLKs6XWtrhen6llv17qUe6co4++NVwTDgRk4kGjQjkh7N5yeCVP6RXxjJ9u70MCsCWzFWQKYQI+qFc8UpREd53tfMzLr/iMk//nTSfnz4Sls+iTg9RxeNxi0SuB5Wz+VUU9DaepBl2qBAdd1B5O2BNNNkVoE+jI/kAyfhbG2dkkDynTQW0GYhDeRms/PEnmNlAQ3RgTowN9WL8ukYtxi/BwmrYqB8rYm14NIGcHxbBynpl8P5AUXIFZuf39MCOLv3vMG7wSs3FRSJzduBkedwmVtETiSTcIJQDa1A7Xv6AtM97RXgPxgQeacGewzb/rGLzXGoyEgKDVchcL0oBNVT568h+VtCCGbDlHLlWdAVuHk+INdiFr+ZQ0bCjxgX7bxlGB1XT/5nrhZfJcY4vJnsacyGFeJL6tlxpn2VTQIPd14mP7ifvlRTaTs/Vgute80j9XSBi4gyh75qYYG2qXWGbqg68A8+QvD7rcZB7JVq7cjgTHbIOl/dSF1AKAZCAIyTUpw7fOsyBgb6sX5dm7Bx8yeanpJQeT9Ey6205hmbSsI1gLb4TbP2ed5IaieDukEcacdFJF9pX06NK70ee/wVx6+FoxLrleu9cxvRJuZblHV21N+a38JdjYr8p5XMC8IYHMWzcgU4ptVU4NGi2XGXeIrANGBTi/LrLiWi2tWtyZHKAYI7/14fM/hCiqt9q0JtyuzVqYc8esbB7z6fi1cFLVRbVZuqcj/7FCmjkTZzh5Tb3EwIvZQrddvipefTDEv4XIQ580jy4bjAshJ0p/Vn3NsiuxW+GnfSSyj6kAh3RR5lG6R39sxZ459wDXHSjhwqjPL3Y1CBsY1FxBKAsksd0eCzJQmrXQwNZIo/e8kZKgzSBK8ujhXj8y9Yxk/Dku7j3NPq8VHa36W6vEn+Zha2IVGYpKwb+I3CE25l5okXJA4BOnQsgsj9nZhrhl2zpnAHCIVKxqOMCT5U062cM82E5WF2oD+auADpGlBRpsMCtCu4V0EJdSDoD/I2n5QZVqai1QisS1VqVOmxza2Ogb2erXCZs5HC484bgNhAfNpQluhk0RrlX2cSbpmJVXmBfkwLe0tEvLEbQHYXbq3tprJCNRZQY7BJyKnWCxgfwwA1bWb4fhuMQPwO6unqaoPcLk2WHZR5nTYbYlQzcueFcHY5WUGBLdOiWFPWxTvCjbC51QlPrZhKCGBOeWyHZ4t/9FbnGkCV58NUo3LT6KnMg7c+ddkCzdrylU7oVSiympxvf2Ihstj4ZjtON9tOFpxhFQPRGBmHMtpqubTPLIOZCB7ltavbPTgcNuMCL2UK3WXVrmsxM7WNdE8juc8E6JbJuaZKT7cq6hjAVC5m1Jd6eb4EyTVqQ7SWzVWQiecMojGulVNeYtfswKP9YkHfnFCpzokuOz8n+eaN+ECaspgZp2MEeLn1kzdbZ6GPd3X93n8KatiJrtTbTa/k/wzKZpwEM7iNGQFfpBtcZNbWwobl+XZyTagIFiXCRZmB2taEY5s8aii3cJowo7Gx/A7dDAmu/WbeoYMbnFYwzye+UtYS2ciZIoJkbyGK7LMNHRYKiwzrcjCIfuHnjrb8NUnZR07SzObzmp7YBDAl+tSfJ64vXMfu7ZCCUk7UaohzArAlsxVVtl0ySS9aAbx9MA1DJTraKY/b0wHzQf7uoGlCfcd8F+eHVaPzN6rEIIZlg3bnMZlyVxNfMD5fVH3Dh9nX3WVqjLPTQdw=='

function fnv(plane: PixelPlane): string {
  let hash = 1469598103934665603n
  for (const sample of plane) {
    hash ^= BigInt(sample)
    hash = BigInt.asUintN(64, hash * 0x100000001B3n)
  }
  return hash.toString(16).padStart(16, '0')
}

describe('film grain synthesis vs libaom', () => {
  it('matches 10-bit overlap and chroma-from-luma grain bit-exactly', () => {
    const obus = parseOBUs(new Uint8Array(Buffer.from(OBU, 'base64')))
    const seq = parseSequenceHeader(obus.find(o => o.type === OBUType.SEQUENCE_HEADER)!.data)
    const { header, tiles } = parseFrameOBU(obus.find(o => o.type === OBUType.FRAME)!.data, seq)
    const frame = decodeFrame(seq, header, tiles)

    expect(seq.bitDepth).toBe(10)
    expect(header.filmGrain?.overlap).toBe(true)
    expect(header.filmGrain?.chromaScalingFromLuma).toBe(true)
    expect(fnv(frame.buf.y)).toBe('3b25ad9b3a4eed9b')
    expect(fnv(frame.buf.u)).toBe('f6f93beeb8758e97')
    expect(fnv(frame.buf.v)).toBe('0100b5372037fb66')
  })
})

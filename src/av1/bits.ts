/**
 * MSB-first bit reader for AV1 uncompressed headers (OBU payloads).
 * Mirrors the BitReader conventions used in ts-heic's hevc/nal.ts, plus the
 * AV1-specific descriptors from spec section 4: f(n), uvlc(), le(n), leb128(),
 * su(n), ns(n).
 */
export class BitReader {
  private pos = 0
  constructor(private data: Uint8Array) {}

  get bitPosition(): number {
    return this.pos
  }

  get bitsRemaining(): number {
    return this.data.length * 8 - this.pos
  }

  readBit(): number {
    if (this.pos >= this.data.length * 8)
      throw new Error('BitReader: read past end of data')
    const byte = this.data[this.pos >> 3]
    const bit = (byte >> (7 - (this.pos & 7))) & 1
    this.pos++
    return bit
  }

  /** f(n): unsigned integer from n bits, MSB first. Safe up to 32 bits. */
  readBits(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++)
      v = ((v << 1) | this.readBit()) >>> 0
    return v
  }

  /** uvlc(): variable length unsigned integer (spec 4.10.3). */
  uvlc(): number {
    let leadingZeros = 0
    while (this.readBit() === 0) {
      leadingZeros++
      if (leadingZeros >= 32)
        return 2 ** 32 - 1
    }
    return this.readBits(leadingZeros) + 2 ** leadingZeros - 1
  }

  /** le(n): n-byte little-endian unsigned integer, byte aligned (spec 4.10.4). */
  le(n: number): number {
    if ((this.pos & 7) !== 0)
      throw new Error('BitReader: le() requires byte alignment')
    let v = 0
    for (let i = 0; i < n; i++)
      v += this.readBits(8) * 2 ** (8 * i)
    return v
  }

  /** leb128(): variable-length unsigned integer, byte aligned (spec 4.10.5). */
  leb128(): number {
    let value = 0
    for (let i = 0; i < 8; i++) {
      const byte = this.readBits(8)
      value += (byte & 0x7F) * 2 ** (i * 7)
      if ((byte & 0x80) === 0)
        break
    }
    return value
  }

  /** su(1+n): signed integer, sign bit first at MSB (spec 4.10.6). */
  su(n: number): number {
    let value = this.readBits(n)
    const signMask = 1 << (n - 1)
    if (value & signMask)
      value = value - 2 * signMask
    return value
  }

  /** ns(n): non-symmetric unsigned encoding for values in [0, n) (spec 4.10.7). */
  ns(n: number): number {
    const w = floorLog2(n) + 1
    const m = (1 << w) - n
    const v = this.readBits(w - 1)
    if (v < m)
      return v
    const extraBit = this.readBit()
    return (v << 1) - m + extraBit
  }

  byteAlign(): void {
    while ((this.pos & 7) !== 0)
      this.pos++
  }
}

/** FloorLog2 per spec 4.7: position of the most significant set bit. */
export function floorLog2(x: number): number {
  let s = 0
  while (x !== 1) {
    x >>= 1
    s++
  }
  return s
}

/** CeilLog2 per spec: smallest n such that (1 << n) >= x, 0 for x < 2. */
export function ceilLog2(x: number): number {
  if (x < 2)
    return 0
  let i = 1
  let p = 2
  while (p < x) {
    i++
    p = p << 1
  }
  return i
}

export function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

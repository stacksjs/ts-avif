/**
 * AV1 multi-symbol adaptive arithmetic decoder (spec 8.2, "msac").
 *
 * CDF convention matches dav1d/libaom storage: for an N-symbol alphabet the
 * table holds N entries - N-1 inverse cumulative probabilities in Q15
 * (value k = 32768 * P(symbol > k)) followed by an adaptation counter.
 * EC_PROB_SHIFT = 6, EC_MIN_PROB = 4.
 *
 * The window is kept as the top 16 bits of the (bit-inverted) stream, with
 * renormalization pulling further inverted bits MSB-first; past the end of
 * the buffer reads continue with 1s, exactly like the spec's padded init.
 */
import { floorLog2 } from './bits'

const EC_PROB_SHIFT = 6
const EC_MIN_PROB = 4

/** AV1 multi-symbol arithmetic encoder, the inverse of `SymbolDecoder`. */
export class SymbolEncoder {
  private rng = 0x8000
  private cnt = -9
  private low = 0
  private precarry: number[] = []
  readonly allowUpdateCdf: boolean

  constructor(disableCdfUpdate: boolean) {
    this.allowUpdateCdf = !disableCdfUpdate
  }

  private store(fl: number, fh: number, nms: number): void {
    const r = this.rng
    let u = (((r >>> 8) * (fl >>> EC_PROB_SHIFT)) >>> (7 - EC_PROB_SHIFT))
      + EC_MIN_PROB * nms
    if (fl >= 32768)
      u = r
    const v = (((r >>> 8) * (fh >>> EC_PROB_SHIFT)) >>> (7 - EC_PROB_SHIFT))
      + EC_MIN_PROB * (nms - 1)
    const nextRng = u - v

    let low = (this.low + r - u) >>> 0
    let c = this.cnt
    const d = Math.clz32(nextRng) - 16
    let s = c + d
    if (s >= 0) {
      c += 16
      let mask = 2 ** c - 1
      if (s >= 8) {
        this.precarry.push(low >>> c)
        low = (low & mask) >>> 0
        c -= 8
        mask = Math.floor(mask / 256)
      }
      this.precarry.push(low >>> c)
      s = c + d - 24
      low = (low & mask) >>> 0
    }

    this.low = (low << d) >>> 0
    this.rng = nextRng << d
    this.cnt = s
  }

  /** Encode a symbol from an N-symbol inverse CDF (N-1 values + count). */
  encodeSymbol(cdf: Uint16Array, off: number, nSymbolsMinus1: number, symbol: number): void {
    if (symbol < 0 || symbol > nSymbolsMinus1)
      throw new RangeError(`symbol ${symbol} outside 0..${nSymbolsMinus1}`)
    const fl = symbol > 0 ? cdf[off + symbol - 1] : 32768
    const fh = symbol < nSymbolsMinus1 ? cdf[off + symbol] : 0
    this.store(fl, fh, nSymbolsMinus1 + 1 - symbol)
    if (this.allowUpdateCdf)
      updateCdf(cdf, off, nSymbolsMinus1, symbol)
  }

  /** Encode a fixed-probability boolean (`f` is Q15 P(bit == 1)). */
  encodeBool(bit: number, f: number): void {
    if (bit !== 0 && bit !== 1)
      throw new RangeError(`boolean symbol must be 0 or 1, got ${bit}`)
    if (f <= 0 || f >= 32768)
      throw new RangeError(`boolean probability must be in 1..32767, got ${f}`)
    if (bit)
      this.store(f, 0, 1)
    else
      this.store(32768, f, 2)
  }

  encodeBoolAdapt(cdf: Uint16Array, off: number, bit: number): void {
    this.encodeBool(bit, cdf[off])
    if (this.allowUpdateCdf)
      updateCdf(cdf, off, 1, bit)
  }

  encodeBoolEqui(bit: number): void {
    this.encodeBool(bit, 16384)
  }

  writeLiteral(value: number, bits: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** bits)
      throw new RangeError(`literal ${value} does not fit in ${bits} bits`)
    for (let bit = bits - 1; bit >= 0; bit--)
      this.encodeBoolEqui(Math.floor(value / 2 ** bit) & 1)
  }

  writeGolomb(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError(`invalid Golomb value ${value}`)
    const x = value + 1
    const length = Math.floor(Math.log2(x)) + 1
    for (let i = 1; i < length; i++)
      this.encodeBoolEqui(0)
    this.writeLiteral(x, length)
  }

  /** Finish the arithmetic code and return the minimum unambiguous byte stream. */
  finish(): Uint8Array {
    let c = this.cnt
    let s = 10 + c
    const mask = 0x3FFF
    let e = (((this.low + mask) & ~mask) | (mask + 1)) >>> 0

    if (s > 0) {
      let n = 2 ** (c + 16) - 1
      do {
        this.precarry.push(e >>> (c + 16))
        e = (e & n) >>> 0
        s -= 8
        c -= 8
        n = Math.floor(n / 256)
      } while (s > 0)
    }

    const out = new Uint8Array(this.precarry.length)
    let carry = 0
    for (let i = this.precarry.length - 1; i >= 0; i--) {
      carry += this.precarry[i]
      out[i] = carry & 0xFF
      carry >>>= 8
    }
    return out
  }
}

function updateCdf(cdf: Uint16Array, off: number, nSymbolsMinus1: number, symbol: number): void {
  const count = cdf[off + nSymbolsMinus1]
  const rate = 4 + (count >> 4) + (nSymbolsMinus1 > 2 ? 1 : 0)
  let i = 0
  for (; i < symbol; i++)
    cdf[off + i] += (32768 - cdf[off + i]) >> rate
  for (; i < nSymbolsMinus1; i++)
    cdf[off + i] -= cdf[off + i] >> rate
  cdf[off + nSymbolsMinus1] = count + (count < 32 ? 1 : 0)
}

export class SymbolDecoder {
  /** Range, always in [0x8000, 0xFFFF] between symbols. */
  private rng = 0x8000
  /** Top 16 bits of the inverted-bit window; invariant val < rng. */
  private val = 0
  /** Next bit position in the tile data. */
  private bitPos = 0
  private totalBits: number
  readonly allowUpdateCdf: boolean

  constructor(private data: Uint8Array, disableCdfUpdate: boolean) {
    this.totalBits = data.length * 8
    this.allowUpdateCdf = !disableCdfUpdate
    // Initial window: 15 inverted bits under an implicit leading 0.
    this.val = this.nextInvertedBits(15)
  }

  /** Read `n` bit-inverted stream bits MSB-first (1s past the end). */
  private nextInvertedBits(n: number): number {
    let acc = 0
    for (let i = 0; i < n; i++) {
      let bit = 1
      if (this.bitPos < this.totalBits) {
        const byte = this.data[this.bitPos >> 3]
        bit = 1 - ((byte >> (7 - (this.bitPos & 7))) & 1)
      }
      this.bitPos++
      acc = (acc << 1) | bit
    }
    return acc
  }

  private renorm(rng: number): void {
    const d = 15 - floorLog2(rng)
    this.rng = rng << d
    if (d > 0)
      this.val = (this.val << d) | this.nextInvertedBits(d)
  }

  /**
   * Decode one symbol from an N-symbol alphabet; `cdf` has N entries
   * (N-1 inverse cumulative probabilities + adaptation counter) and is
   * adapted in place when CDF updates are enabled.
   */
  decodeSymbol(cdf: Uint16Array, off: number, nSymbolsMinus1: number): number {
    const c = this.val
    const r = this.rng >> 8
    let u = this.rng
    let v = this.rng
    let symbol = -1
    do {
      symbol++
      u = v
      v = ((r * (cdf[off + symbol] >> EC_PROB_SHIFT)) >> (7 - EC_PROB_SHIFT))
        + EC_MIN_PROB * (nSymbolsMinus1 - symbol)
    } while (c < v)

    this.val = c - v
    this.renorm(u - v)

    if (this.allowUpdateCdf) {
      const count = cdf[off + nSymbolsMinus1]
      const rate = 4 + (count >> 4) + (nSymbolsMinus1 > 2 ? 1 : 0)
      let i = 0
      for (; i < symbol; i++)
        cdf[off + i] += (32768 - cdf[off + i]) >> rate
      for (; i < nSymbolsMinus1; i++)
        cdf[off + i] -= cdf[off + i] >> rate
      cdf[off + nSymbolsMinus1] = count + (count < 32 ? 1 : 0)
    }

    return symbol
  }

  /** Decode one bool with fixed probability `f` = 32768 * P(bit == 1), Q15. */
  decodeBool(f: number): number {
    const c = this.val
    const r = this.rng
    const v = (((r >> 8) * (f >> EC_PROB_SHIFT)) >> (7 - EC_PROB_SHIFT)) + EC_MIN_PROB
    if (c < v) {
      this.renorm(v)
      return 1
    }
    this.val = c - v
    this.renorm(r - v)
    return 0
  }

  /** Decode one adaptive bool; `cdf` = [prob, counter]. */
  decodeBoolAdapt(cdf: Uint16Array, off: number): number {
    const bit = this.decodeBool(cdf[off])
    if (this.allowUpdateCdf) {
      const count = cdf[off + 1]
      const rate = 4 + (count >> 4)
      if (bit)
        cdf[off] += (32768 - cdf[off]) >> rate
      else
        cdf[off] -= cdf[off] >> rate
      cdf[off + 1] = count + (count < 32 ? 1 : 0)
    }
    return bit
  }

  /** Decode one equiprobable bool (spec read_bit / L(1)). */
  decodeBoolEqui(): number {
    const c = this.val
    const r = this.rng
    const v = ((r >> 8) << 7) + EC_MIN_PROB
    if (c < v) {
      this.renorm(v)
      return 1
    }
    this.val = c - v
    this.renorm(r - v)
    return 0
  }

  /** Read an n-bit literal MSB-first from equiprobable bools (spec L(n)). */
  readLiteral(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++)
      v = (v << 1) | this.decodeBoolEqui()
    return v
  }

  /** Decode a uniformly distributed integer in [0, n). */
  decodeUniform(n: number): number {
    if (n <= 1)
      return 0
    const l = floorLog2(n) + 1
    const m = (1 << l) - n
    const v = this.readLiteral(l - 1)
    return v < m ? v : (v << 1) - m + this.decodeBoolEqui()
  }

  /** Exp-Golomb style code used for coefficient levels (spec read_golomb). */
  readGolomb(): number {
    let numLeadingZeros = 0
    while (numLeadingZeros < 32 && this.decodeBoolEqui() === 0)
      numLeadingZeros++
    let x = 1
    for (let i = 0; i < numLeadingZeros; i++)
      x = (x << 1) | this.decodeBoolEqui()
    return x - 1
  }

  /** Number of stream bits consumed so far (including the 15-bit preload). */
  get bitsConsumed(): number {
    return this.bitPos
  }
}

function invRecenter(r: number, v: number): number {
  if (v > 2 * r)
    return v
  if (v & 1)
    return r - ((v + 1) >> 1)
  return r + (v >> 1)
}

/** decode_subexp + inv_recenter, used by delta-q/lf and restoration filters. */
export function decodeSubexp(s: SymbolDecoder, ref: number, n: number, k: number): number {
  let a = 0
  if (s.decodeBoolEqui()) {
    if (s.decodeBoolEqui())
      k += s.decodeBoolEqui() + 1
    a = 1 << k
  }
  const v = s.readLiteral(k) + a
  return ref * 2 <= n
    ? invRecenter(ref, v)
    : n - 1 - invRecenter(n - 1 - ref, v)
}

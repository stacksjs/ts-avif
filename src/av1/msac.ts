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

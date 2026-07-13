/**
 * Per-frame CDF context: one flat Uint16Array holding the mode/mv/kf-y-mode
 * block followed by the coefficient block, initialized from the default
 * tables (see cdf-tables.ts, generated from dav1d). Offsets index into the
 * flat array; SymbolDecoder adapts entries in place.
 */
import {
  COEF_OFFSETS,
  COEF_SIZE,
  DEFAULT_COEF_B64,
  DEFAULT_MODE_B64,
  MODE_OFFSETS,
  MODE_SIZE,
} from './cdf-tables'

function decodeU16(b64: string, expected: number): Uint16Array {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  if (bytes.length !== expected * 2)
    throw new Error(`cdf table size mismatch: ${bytes.length} bytes for ${expected} u16`)
  const out = new Uint16Array(expected)
  for (let i = 0; i < expected; i++)
    out[i] = bytes[2 * i] | (bytes[2 * i + 1] << 8)
  return out
}

const DEFAULT_MODE = decodeU16(DEFAULT_MODE_B64, MODE_SIZE)
const DEFAULT_COEF = DEFAULT_COEF_B64.map(b64 => decodeU16(b64, COEF_SIZE))

type OffsetTable = Record<string, readonly number[]>

function buildStrides(table: OffsetTable, base: number): Record<string, { off: number, strides: number[] }> {
  const out: Record<string, { off: number, strides: number[] }> = {}
  for (const [name, spec] of Object.entries(table)) {
    const off = base + spec[0]
    const dims = spec.slice(1)
    // stride of dimension i = product of dims after it
    const strides: number[] = []
    for (let i = 0; i < dims.length; i++) {
      let s = 1
      for (let j = i + 1; j < dims.length; j++)
        s *= dims[j]
      strides.push(s)
    }
    out[name] = { off, strides }
  }
  return out
}

const MODE_ACCESS = buildStrides(MODE_OFFSETS as unknown as OffsetTable, 0)
const COEF_ACCESS = buildStrides(COEF_OFFSETS as unknown as OffsetTable, MODE_SIZE)
const ACCESS = { ...MODE_ACCESS, ...COEF_ACCESS }

export type CdfTableName = keyof typeof MODE_OFFSETS | keyof typeof COEF_OFFSETS

export class CdfContext {
  readonly data: Uint16Array

  constructor(baseQIdx: number) {
    this.data = new Uint16Array(MODE_SIZE + COEF_SIZE)
    this.data.set(DEFAULT_MODE, 0)
    const qcat = (baseQIdx > 20 ? 1 : 0) + (baseQIdx > 60 ? 1 : 0) + (baseQIdx > 120 ? 1 : 0)
    this.data.set(DEFAULT_COEF[qcat], MODE_SIZE)
  }

  /**
   * Offset of a CDF within `data`. Pass one index per dimension except the
   * last (the CDF itself, whose tail holds padding and the adaptation
   * counter).
   */
  offset(name: CdfTableName, ...idx: number[]): number {
    const a = ACCESS[name]
    let off = a.off
    for (let i = 0; i < idx.length; i++)
      off += idx[i] * a.strides[i]
    return off
  }
}

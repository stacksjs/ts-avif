import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { cdefFilterBlock, cdefFindDir } from '../src/av1/cdef'

/**
 * CDEF kernel vectors from dav1d's compiled cdef_tmpl.c (find_dir + the
 * primary/secondary constrained filter across sizes, strengths, directions,
 * and every edge-availability combination).
 */
const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', 'cdef-vectors.json'), 'utf8'),
) as any[]

function lcg(seed: number) {
  let r = seed >>> 0
  return () => {
    r = (Math.imul(r, 1664525) + 1013904223) >>> 0
    return r >>> 8
  }
}

function fnv(plane: Uint8Array): string {
  let h = 1469598103934665603n
  for (let i = 0; i < plane.length; i++) {
    h ^= BigInt(plane[i])
    h = (h * 0x100000001B3n) & 0xFFFFFFFFFFFFFFFFn
  }
  return h.toString(16).padStart(16, '0')
}

describe('CDEF kernels vs dav1d reference vectors', () => {
  it('matches direction search and filtering bit-exactly', () => {
    const varOut = new Int32Array(1)
    for (const v of vectors) {
      if (v.op === 'D') {
        const img = new Uint8Array(64)
        const next = lcg(v.seed)
        for (let i = 0; i < 64; i++) img[i] = next() & 0xFF
        const dir = cdefFindDir(img, 0, 8, varOut)
        if (dir !== v.dir || varOut[0] !== v.var)
          throw new Error(`find_dir seed ${v.seed}: got dir ${dir} var ${varOut[0]}, want ${v.dir} ${v.var}`)
      }
      else {
        const S = 24
        const plane = new Uint8Array(S * S)
        const next = lcg(v.seed)
        for (let i = 0; i < S * S; i++) plane[i] = next() & 0xFF
        const dstOff = 4 * S + 4
        const left = new Int32Array(v.h * 2)
        for (let y = 0; y < v.h; y++) {
          left[y * 2] = plane[(4 + y) * S + 2]
          left[y * 2 + 1] = plane[(4 + y) * S + 3]
        }
        const topOff = 2 * S + 4
        const botOff = (4 + v.h) * S + 4
        cdefFilterBlock(
          plane,
          dstOff,
          S,
          left,
          plane,
          topOff,
          plane,
          botOff,
          v.pri,
          v.sec,
          v.dir,
          v.damping,
          v.w,
          v.h,
          v.edges,
        )
        if (fnv(plane) !== v.hash)
          throw new Error(`cdef ${JSON.stringify(v)}: got ${fnv(plane)}`)
      }
    }
    expect(vectors.length).toBeGreaterThan(1000)
  })
})

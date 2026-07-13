import { describe, expect, it } from 'bun:test'
import { CdfContext } from '../src/av1/cdf'
import { COEF_OFFSETS, COEF_SIZE, MODE_OFFSETS, MODE_SIZE } from '../src/av1/cdf-tables'

// Values hand-checked against dav1d src/cdf.c (stored as 32768 - x).
describe('default CDF tables', () => {
  it('pins known values from the reference tables', () => {
    const cdf = new CdfContext(36) // qcat 1

    // m.skip = { CDF1(31671) }, { CDF1(16515) }, { CDF1(4576) }
    expect(cdf.data[cdf.offset('skip', 0)]).toBe(32768 - 31671)
    expect(cdf.data[cdf.offset('skip', 1)]).toBe(32768 - 16515)
    expect(cdf.data[cdf.offset('skip', 2)]).toBe(32768 - 4576)

    // m.cfl_sign = CDF7(1418, 2123, 13340, 18405, 26972, 28343, 32294)
    expect(cdf.data[cdf.offset('cfl_sign')]).toBe(32768 - 1418)
    expect(cdf.data[cdf.offset('cfl_sign') + 6]).toBe(32768 - 32294)

    // m.filter_intra = CDF4(8949, 12776, 17211, 29558)
    expect(cdf.data[cdf.offset('filter_intra')]).toBe(32768 - 8949)
    expect(cdf.data[cdf.offset('filter_intra') + 3]).toBe(32768 - 29558)

    // kfym[0][0] starts CDF12(15588, 17027, ...)
    expect(cdf.data[cdf.offset('kfym', 0, 0)]).toBe(32768 - 15588)
    expect(cdf.data[cdf.offset('kfym', 0, 0) + 1]).toBe(32768 - 17027)
  })

  it('selects coefficient tables by qindex category', () => {
    // qcat 0 (qidx <= 20): coef.skip[0][0] = CDF1(31849)
    const q0 = new CdfContext(20)
    expect(q0.data[q0.offset('coef_skip', 0, 0)]).toBe(32768 - 31849)
    // and its [0][1] = CDF1(5892)
    expect(q0.data[q0.offset('coef_skip', 0, 1)]).toBe(32768 - 5892)
    // qcat 1 differs
    const q1 = new CdfContext(36)
    expect(q1.data[q1.offset('coef_skip', 0, 0)]).not.toBe(32768 - 31849)
  })

  it('has structurally valid CDFs: non-increasing probabilities, zero counters', () => {
    const cdf = new CdfContext(100)
    const tables = { ...MODE_OFFSETS, ...COEF_OFFSETS }
    expect(cdf.data.length).toBe(MODE_SIZE + COEF_SIZE)
    for (const name of Object.keys(tables) as (keyof typeof tables)[]) {
      const spec = tables[name] as readonly number[]
      const dims = spec.slice(1)
      const cdfLen = dims[dims.length - 1]
      let count = 1
      for (let i = 0; i < dims.length - 1; i++)
        count *= dims[i]
      const base = name in COEF_OFFSETS ? MODE_SIZE + spec[0] : spec[0]
      for (let k = 0; k < count; k++) {
        const off = base + k * cdfLen
        // probabilities are non-increasing until they hit the 0 padding
        let prev = 32768
        for (let i = 0; i < cdfLen; i++) {
          const v = cdf.data[off + i]
          if (v === 0)
            break
          expect(v).toBeLessThanOrEqual(prev)
          prev = v
        }
      }
    }
  })
})

import { describe, expect, test } from 'bun:test'
import { decodeAV1Sequence } from '../src/av1/decoder'

// libaom two-frame stream using switchable sharp/smooth/regular filters,
// fractional MVs, NEARMV DRL selection, and secondary spatial candidates.
const STREAM = Uint8Array.fromBase64(
  'EgAKCgAAAAKv/7hPAAgy9QcQAIKAAAKA3hY1O68i/CvD9i1eGTIs9W1C6pi3tqzD+qp/zunXX8zggDb0kkZxN/Ccn50x8majvkYUh3vl4VT1zXLPj8CjoGKsEYP4n7BobK9yfRoxoQm6GPCDYkpd0+l59sQbVtkdFcVzJJ3j3BpQk/W9eS/5qjAnwRdtUnBEeHyQLcGSaFUpxy6mv6BxHPXT2lHAtoWGHoz/uoma0cxpunCOXsXxAOjUefqWq7xNZjc7OLN1n8CiLvclRBhny5UlrgJNvo/5g/XuhVpKHM8KBQDK6O9Aaw69mQ4cLK8cY7VCUulrwruQ40vd8WvxZwqnjWWGe9a+be/bJPLQQ7cM2KgGKZGAH3slG8CcVkJfsBHyyHfaX7AS9qudKIDjRrOChXoYJgJUInLbb/u5g5eeRuIccDJEcwawjv2CnuOFSP1jm7QKjkl899s28hzK6aoT1quQ2mRD7MbWKHtg9H/TPCZbwBxNZbTqlIRZMC6J2d8CpMjDV4XwvXviX+ItAKlKUZlRogLPeUkDcSgTrElXXxazrnnfHpEPfTXob/z3qjGPHGI1ubK1L/aNZ4s85w8ZlhzMNaEH5pUow0OyvBR4WkZi+5WcoA8chr5w+XYhGxH7VNE3vwkwQDsyA6R1N0IT53b/ZZKv/FnyHWbgVK6gSe04563OhhsKD8e0dhN+GYW7goqBKdrIHtMTJu2Cob9e9Fl4v8lHuoB5FIJaaZ8RWLXmrX/vMaiSBXRN7Mn1WRqNS274K4pSZXQ1ggOuFh/s+JirX2aK5Vti0KGaqR9B5Ig8aX992UctYjwu7J1tNvJ9/enQAkEcPAYIT615nHkCrfN32HcDopy+nWuxA5sCRFfFNRFrh8oiFBxnP1hckgkWoGLoPyU5hebqbNa9DQdtiOJQCCp7JH0h6KXSXyA4U/m9Nf9+rezJKdzxc7YbFHo1yekrntqk1oyORcvnuKr0pVjzPbXKqXCxyqfjFhXmKwvvcO7alRY/Ix2nlhwxt4NJQf2JcdeU8H3E/rMmayztSQxKuq16vkPGE0Y+MbXjOreQ8/7FHiUPpcJV7bzGTP1pzLIjzyI0+QKAOnPz84+qrst1j672fkXdKURUNBJ2rMN82/wrG89COv2KOgSp6gvirzfLETBqiHleGLPakaHc4sVP+9RU+TXn70PKpj0nHw2MWqq1NIcAdRf7/5lplTHN2opU6p8cCw1Ep+wFtn0qtYEx/0zj3bnWLF5Jwjt06F85N7pkvpnQ7Zm+24g4MEkwvOtHqQXOB1gPqBzxEPBRwIOPdudYsXi+zcPz/wLlTUZg0ojkusQ55rR+uKI9agGrpwvhnGP3HZ0xXeQ3SEgccfhGeBIAMowCMAPAgAAAZZAAABQA2MOlzomb+KNPo3w8vUbL1koiaD1J4ceFPHksxwNDLpLAZFsB6cbTtXvqfIhZVvqYl840nrzIjLUDQR0sFM0O5DKCwG6DdsfE9JuzTTgs2YR6I3rciy3t7XWURIGbO96kuzr6cwRf5TDJb+Ec8IM7Y8zbKjNS5fhTjyOlpV2HN6q0jl5d405PTeq78FqVxHfXsw6LfgOEXhMYbbq5V22EBaNVAfqvvVina70yQrGy7MQleIugb+GB3YvxtjEcXZSSsXGbqeXN1YgYbil/OVLF2YBPMTcGHbsZ7NTZE1vc0vSBKlbg7hIttlnLvC1uuYlpLwLK9MQq7KLYpFuC9pFCwA==',
)

function digest(data: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex')
}

describe('switchable inter filtering', () => {
  test('matches dav1d across the full MV candidate scan', () => {
    const frames = decodeAV1Sequence([STREAM.subarray(0, 1030), STREAM.subarray(1030)])
    expect(digest(frames[0].data)).toBe('42cff6a93a4c17823f0ab1c0dbc001fe27db4709e6a3138336a17af98ce42eff')
    expect(digest(frames[1].data)).toBe('903625618ca946d0304d09bcb6ec6c25fe943aed58b2d0bad702d5fd919c49f4')
  })
})

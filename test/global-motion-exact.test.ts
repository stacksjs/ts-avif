import { describe, expect, test } from 'bun:test'
import { decodeAV1Sequence } from '../src/av1/decoder'

// libaom two-frame stream with non-identity affine global-motion parameters
// and a coded GLOBALMV block. The pixel digests come from dav1d.
const STREAM = Uint8Array.fromBase64(
  'EgAKCgAAAAKv/7hPAAgy8wYQAIcAAAKA3hL4U4ofFP/g/Ud+J8+rP+sfM3pfl2baImv7OJc7e+tilaPiLpOmHZO+LXT/XkP9BqpIWMWOnBPqyg4FLOW65U//6ntGUC4D6gwsqwDqRncO2b/zTG1V1M14iE931Hrp5h+i9+Bemj/f2MHKuSx/TNxYDlGXlM01su2J8bXw1JUj1T6WDHguVAKdlmrN07Bf6/8bhJlh+wsTr5TlUPr5WbFD7I3Px+XCZFVl2VpvInSlgD1GyrJoe1d0OmUsGK8Gm9pSNy/X+fPP5Y8Y+ay5bweOtEAhcKnlkx1Wm9mruUTI6SKK/f9v67gAS7BTvso0dZfxo+FSu2L3oyZNjwHZmcRR0lCpuI4fSEV0Vq6YlDvHwQNP4oxvf3H2BzosJDVDG51qhG2gHpnhpoBAA5A524qaQvuKIW4tE+ALYGfJ/jQVgucS3h15gtjVLyHmlYz/FNrjU2/sPBK7izJWfOnVREXNBVx5QTf30I3Bo4eJTzYcDrlYJtQprw5jUJwnA7AB9Qx1NcNWpy63YvnrdUZ9exQPua5h13q/CxQ3N4EfWWExoEksBRqkiOoYUJt4CDytQnTToPgkmSb6QHuuHr6MWtryevmd98fYTD9WwCMVTq4B6rzAWKCvGoOcHmyOAe+LBb671ORHOlIyEL1Rm3Mt2ahT4uqM3CO7eDTHbrBnSnEuXdD1ZrrUe/3/Q8jh6py2tLosUElw2Vw6QN1JR56uuOvk8M9Eeo0oMpUH7doUBBDj+3spBObxDF4FN+EAoGzxwqyAq+ABBTnm2whccaK5DAbNrds0DFGvPdbh29N+WaUMi/7CDI7b9Y0cQJs1wL8WztDcN09GQM/XOOA5s9AphR9RWMlk7AygnGJ3Me85wE3F5EfjoIonZWa5wqk1GVt/UmnQxYgRbsZpcg/Rrim1BYBwTGOIB+1bPJyK6Ocd4hwhQrUqxUh+dnk2yGzJarKi5k7+2urwhyDVAIIBXfHMJ5gYUwue4iKeHC34tNFft7/smiA8kYLKcbTjAPsaLGtksgMXFIFo2xqBkNMTJZIsmnJcpA9eeDyvgH1rWN2fX0X+Xh0Q6G9gmkTIpW5ZPqmg0vbDLwGy+0bV+usfoYBpcpCiUjM2V1EpD1mrg6TvLg8YKOxa+ZVgmWsUDKlyDDQRSqjMR2bE4GTr+QtAEgAyFzADwIAAAEFQAAAEAaJ+/w0T9/gAmG9Q',
)

function digest(data: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex')
}

describe('global motion', () => {
  test('matches dav1d for non-identity signaling and GLOBALMV prediction', () => {
    const frames = decodeAV1Sequence([STREAM.subarray(0, 900), STREAM.subarray(900)])
    expect(digest(frames[0].data)).toBe('5e9376f741c6ec4deff52b012050ff94759e495211d4f3de63443e4f8b38a663')
    expect(digest(frames[1].data)).toBe('8a67a9fb9b4d891f0d61533234715c781b033b2bcdb98c335d52c719dd45bb05')
  })
})

import { describe, expect, test } from 'bun:test'
import { decodeAV1Sequence } from '../src/av1/decoder'

// libaom stream with inter-intra and switchable motion modes enabled at the
// sequence/frame level but selecting their translation-only branches.
const STREAM = Uint8Array.fromBase64(
  'EgAKCgAAAAKv/75vAAgy8wYQAIcAAAKA3hL4U4ofFP/g/Ud+J8+rP+sfM3pfl2baImv7OJc7e+tilaPiLpOmHZO+LXT/XkP9BqpIWMWOnBPqyg4FLOW65U//6ntGUC4D6gwsqwDqRncO2b/zTG1V1M14iE931Hrp5h+i9+Bemj/f2MHKuSx/TNxYDlGXlM01su2J8bXw1JUj1T6WDHguVAKdlmrN07Bf6/8bhJlh+wsTr5TlUPr5WbFD7I3Px+XCZFVl2VpvInSlgD1GyrJoe1d0OmUsGK8Gm9pSNy/X+fPP5Y8Y+ay5bweOtEAhcKnlkx1Wm9mruUTI6SKK/f9v67gAS7BTvso0dZfxo+FSu2L3oyZNjwHZmcRR0lCpuI4fSEV0Vq6YlDvHwQNP4oxvf3H2BzosJDVDG51qhG2gHpnhpoBAA5A524qaQvuKIW4tE+ALYGfJ/jQVgucS3h15gtjVLyHmlYz/FNrjU2/sPBK7izJWfOnVREXNBVx5QTf30I3Bo4eJTzYcDrlYJtQprw5jUJwnA7AB9Qx1NcNWpy63YvnrdUZ9exQPua5h13q/CxQ3N4EfWWExoEksBRqkiOoYUJt4CDytQnTToPgkmSb6QHuuHr6MWtryevmd98fYTD9WwCMVTq4B6rzAWKCvGoOcHmyOAe+LBb671ORHOlIyEL1Rm3Mt2ahT4uqM3CO7eDTHbrBnSnEuXdD1ZrrUe/3/Q8jh6py2tLosUElw2Vw6QN1JR56uuOvk8M9Eeo0oMpUH7doUBBDj+3spBObxDF4FN+EAoGzxwqyAq+ABBTnm2whccaK5DAbNrds0DFGvPdbh29N+WaUMi/7CDI7b9Y0cQJs1wL8WztDcN09GQM/XOOA5s9AphR9RWMlk7AygnGJ3Me85wE3F5EfjoIonZWa5wqk1GVt/UmnQxYgRbsZpcg/Rrim1BYBwTGOIB+1bPJyK6Ocd4hwhQrUqxUh+dnk2yGzJarKi5k7+2urwhyDVAIIBXfHMJ5gYUwue4iKeHC34tNFft7/smiA8kYLKcbTjAPsaLGtksgMXFIFo2xqBkNMTJZIsmnJcpA9eeDyvgH1rWN2fX0X+Xh0Q6G9gmkTIpW5ZPqmg0vbDLwGy+0bV+usfoYBpcpCiUjM2V1EpD1mrg6TvLg8YKOxa+ZVgmWsUDKlyDDQRSqjMR2bE4GTr+QtAEgAy4wIwA8CAAABlQAIAAAFAYD3wwHvg3uTXECS0EuFqpcavXB4m3qPu1/LqUw6cBpuQeC0oGvusDANpKxVSBz4cG+yMR6OWyS2R7kXb/S/vQpIq9tGrFCBkar+Mpx7DjKy2SgweQp/jcGnGPX4ETxNanzkpLnU/I/imXAu3mDDLrrHQ0ajfYWlTV8VtP0/vPJ2gBNMuB70FjmX6mVUiJh9Lm5WJqvui7AEsp//xZlvGjiYqWLvAkL+NP04KAe98cLgTnB3srHTdnl+hIim4CWKBug2PXAyUN5HttB7rt7SpiFVlzq+EhieLG0VbR0BQrhbwfiRJzLhk5pno0VeqUzM5ziwPkTfhOdeq8+RFDw8cjZrWwxs0KkhtAqCj4LZUu8+1ViIgfqaFZJz6D1+PFRRHDHD3eO4On8ps5qu6kTk9srsTJRx1WH9aNBzc/u1OvGrSOBEqXGWH9RYe41/iB8uyy0vUdWZA',
)

function digest(data: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex')
}

describe('optional inter tool signaling', () => {
  test('keeps disabled inter-intra and motion-mode branches bit-exact', () => {
    const frames = decodeAV1Sequence([STREAM.subarray(0, 900), STREAM.subarray(900)])
    expect(digest(frames[0].data)).toBe('5e9376f741c6ec4deff52b012050ff94759e495211d4f3de63443e4f8b38a663')
    expect(digest(frames[1].data)).toBe('3506bcb36bfbabfcde269e5d691a21211a8ad18e2d1347d8d0b15ade8aa8e37d')
  })
})

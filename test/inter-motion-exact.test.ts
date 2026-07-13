import { describe, expect, test } from 'bun:test'
import { decodeAV1Sequence } from '../src/av1/decoder'

// libaom two-frame stream with fractional NEWMV residuals, spatial MV
// candidates, variable transform partitions, and inter-coded coefficients.
// Loop filtering, CDEF, and restoration are disabled so this gate isolates
// prediction and residual reconstruction. The hashes are from dav1d output.
const STREAM = Uint8Array.fromBase64(
  'EgAKCgAAAAKv/5hPAAgy8AEQAIkAAAKAtKUBHdKs5Tjqhc6o93yGQ2StZEdDMr2s+nVEJ6kjVnzEfNN3HOS9GxUWHzjASvadK1NAFIHEx52tIbtpCMAXpIXcvhdAWZRg+Za22NRNOibDYxZh3FcMOUe5W1aaZ34gjXQ2AfDpyFJhOW5w3bGFTtcklKgtAWHZDcu5pC2ecH///dFW1brp3a/gxuKPPkBsQlNLIgaFa7RzCR3IqWxVu0zArGtyLchFtS/YYdyDCFQ3pLeYv+LEwiyku8xk14gJ1o9FS2OM8GNplCD3Ap3IaZ1y4yALaVBNII/bdFUk6okr+j6ZxrL7ZkwSADJnMAPAgAAAQVAAAAUAANii9lAzKeAdpa6PuGKHqG6G+jQ8IJ0TZ377vBatOYaNyjSUR6w0bVQgfLSAvG0AehG1wx/IECVCpXRhW+Vm3Rog9hCPV18A69qZ6lBI7+0Gdk+/ioXSWsdfJg==',
)

function digest(data: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex')
}

describe('translational inter prediction', () => {
  test('reconstructs moving inter blocks bit-exactly', () => {
    const frames = decodeAV1Sequence([
      STREAM.subarray(0, 257),
      STREAM.subarray(257),
    ])

    expect(frames).toHaveLength(2)
    expect(digest(frames[0].data)).toBe('30f91b4ce040d4c4293f2a4db3477c5fc75c581326ec09b547c03d96d506af27')
    expect(digest(frames[1].data)).toBe('7db239334f38b3c823dcb7ea87707261dcf603be4d1217d241fa47dd0e9b1803')
  })
})

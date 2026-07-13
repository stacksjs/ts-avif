/** A decoded AV1 sample plane. High-bit-depth samples are stored unpacked. */
export type PixelPlane = Uint8Array | Uint16Array

export function createPixelPlane(length: number, bitDepth: number): PixelPlane {
  return bitDepth > 8 ? new Uint16Array(length) : new Uint8Array(length)
}

export function bitDepthMax(bitDepth: number): number {
  return (1 << bitDepth) - 1
}

export function clipPixel(value: number, bitDepth: number): number {
  const max = bitDepthMax(bitDepth)
  return value < 0 ? 0 : value > max ? max : value
}

export function midSample(bitDepth: number): number {
  return 1 << (bitDepth - 1)
}

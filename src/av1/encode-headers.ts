import { BitWriter, ceilLog2 } from './bits'

/**
 * Emit the reduced still-picture sequence header used by the pure TypeScript
 * encoder. The profile is 8-bit 4:2:0 with full-range BT.709/sRGB signaling.
 */
export function encodeSequenceHeader(width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new RangeError('ts-avif: width and height must be positive integers')
  if (width > 65536 || height > 65536)
    throw new RangeError('ts-avif: pure TypeScript encoder supports dimensions up to 65536')

  const w = new BitWriter()
  w.writeBits(0, 3) // seq_profile: Main (8/10-bit 4:2:0)
  w.writeBit(1) // still_picture
  w.writeBit(1) // reduced_still_picture_header
  w.writeBits(0, 5) // seq_level_idx[0]: level 2.0

  const widthBits = Math.max(1, ceilLog2(width))
  const heightBits = Math.max(1, ceilLog2(height))
  w.writeBits(widthBits - 1, 4)
  w.writeBits(heightBits - 1, 4)
  w.writeBits(width - 1, widthBits)
  w.writeBits(height - 1, heightBits)

  w.writeBit(0) // use_128x128_superblock
  w.writeBit(0) // enable_filter_intra
  w.writeBit(0) // enable_intra_edge_filter
  w.writeBit(0) // enable_superres
  w.writeBit(0) // enable_cdef
  w.writeBit(0) // enable_restoration

  w.writeBit(0) // high_bitdepth: 8-bit
  w.writeBit(0) // monochrome
  w.writeBit(1) // color_description_present_flag
  w.writeBits(1, 8) // color_primaries: BT.709
  w.writeBits(13, 8) // transfer_characteristics: sRGB
  w.writeBits(1, 8) // matrix_coefficients: BT.709
  w.writeBit(1) // color_range: full
  // profile 0 implies subsampling_x = subsampling_y = 1
  w.writeBits(0, 2) // chroma_sample_position: unknown/co-sited
  w.writeBit(0) // separate_uv_delta_q
  w.writeBit(0) // film_grain_params_present
  w.trailingBits()
  return w.finish()
}

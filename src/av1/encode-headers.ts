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

/** Emit the uncompressed KEY_FRAME header for a single 64x64-superblock tile. */
export function encodeFrameHeader(width: number, height: number, baseQIdx: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new RangeError('ts-avif: width and height must be positive integers')
  if (width > 4096 || height > 2304)
    throw new RangeError('ts-avif: pure TypeScript encoder currently supports frames up to 4096x2304')
  if (!Number.isInteger(baseQIdx) || baseQIdx < 0 || baseQIdx > 255)
    throw new RangeError('ts-avif: AV1 base quantizer must be in 0..255')

  const w = new BitWriter()
  // reduced_still_picture_header implies KEY_FRAME, show_frame, error resilient,
  // no order hint, fixed sequence dimensions, and all reference slots refreshed.
  w.writeBit(0) // disable_cdf_update
  w.writeBit(0) // allow_screen_content_tools
  w.writeBit(0) // render_and_frame_size_different

  writeSingleTileInfo(w, width, height)

  w.writeBits(baseQIdx, 8)
  w.writeBit(0) // delta_q_y_dc absent
  w.writeBit(0) // delta_q_u_dc absent
  w.writeBit(0) // delta_q_u_ac absent; V reuses U deltas
  w.writeBit(0) // using_qmatrix
  w.writeBit(0) // segmentation_enabled
  if (baseQIdx > 0)
    w.writeBit(0) // delta_q_present

  if (baseQIdx > 0) {
    w.writeBits(0, 6) // loop_filter_level[0]
    w.writeBits(0, 6) // loop_filter_level[1]
    w.writeBits(0, 3) // loop_filter_sharpness
    w.writeBit(0) // loop_filter_delta_enabled
    // CDEF and loop restoration are disabled in the sequence header.
    w.writeBit(0) // tx_mode_select: largest transform
  }
  w.writeBit(1) // reduced_tx_set
  w.byteAlign()
  return w.finish()
}

function writeSingleTileInfo(w: BitWriter, width: number, height: number): void {
  const miCols = 2 * ((width + 7) >> 3)
  const miRows = 2 * ((height + 7) >> 3)
  const sbCols = (miCols + 15) >> 4
  const sbRows = (miRows + 15) >> 4
  const maxLog2TileCols = tileLog2(1, Math.min(sbCols, 64))
  const maxLog2TileRows = tileLog2(1, Math.min(sbRows, 64))

  w.writeBit(1) // uniform_tile_spacing_flag
  if (maxLog2TileCols > 0)
    w.writeBit(0) // tile_cols_log2 = 0
  if (maxLog2TileRows > 0)
    w.writeBit(0) // tile_rows_log2 = 0
}

function tileLog2(blockSize: number, target: number): number {
  let k = 0
  while ((blockSize << k) < target)
    k++
  return k
}

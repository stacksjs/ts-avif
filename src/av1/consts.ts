/**
 * AV1 decoder enums and derived constants, following dav1d's levels.h
 * naming/order (which our generated CDF and helper tables assume).
 */

export const enum TxfmSize {
  TX_4X4 = 0,
  TX_8X8 = 1,
  TX_16X16 = 2,
  TX_32X32 = 3,
  TX_64X64 = 4,
  N_TX_SIZES = 5,
}

export const enum BlockLevel {
  BL_128X128 = 0,
  BL_64X64 = 1,
  BL_32X32 = 2,
  BL_16X16 = 3,
  BL_8X8 = 4,
}

export const RTX_4X8 = 5

export const enum TxfmType {
  DCT_DCT = 0,
  ADST_DCT = 1,
  DCT_ADST = 2,
  ADST_ADST = 3,
  FLIPADST_DCT = 4,
  DCT_FLIPADST = 5,
  FLIPADST_FLIPADST = 6,
  ADST_FLIPADST = 7,
  FLIPADST_ADST = 8,
  IDTX = 9,
  V_DCT = 10,
  H_DCT = 11,
  V_ADST = 12,
  H_ADST = 13,
  V_FLIPADST = 14,
  H_FLIPADST = 15,
  N_TX_TYPES = 16,
  WHT_WHT = 16,
}

export const enum TxClass {
  TWO_D = 0,
  H = 1,
  V = 2,
}

export const enum IntraPredMode {
  DC_PRED = 0,
  VERT_PRED = 1,
  HOR_PRED = 2,
  DIAG_DOWN_LEFT_PRED = 3,
  DIAG_DOWN_RIGHT_PRED = 4,
  VERT_RIGHT_PRED = 5,
  HOR_DOWN_PRED = 6,
  HOR_UP_PRED = 7,
  VERT_LEFT_PRED = 8,
  SMOOTH_PRED = 9,
  SMOOTH_V_PRED = 10,
  SMOOTH_H_PRED = 11,
  PAETH_PRED = 12,
  N_INTRA_PRED_MODES = 13,
  CFL_PRED = 13,
  FILTER_PRED = 13,
  // implicit modes used by edge preparation / prediction dispatch
  LEFT_DC_PRED = 3,
  TOP_DC_PRED = 4,
  DC_128_PRED = 5,
  Z1_PRED = 6,
  Z2_PRED = 7,
  Z3_PRED = 8,
}

export const N_UV_INTRA_PRED_MODES = 14

export const enum BlockPartition {
  NONE = 0,
  H = 1,
  V = 2,
  SPLIT = 3,
  T_TOP_SPLIT = 4,
  T_BOTTOM_SPLIT = 5,
  T_LEFT_SPLIT = 6,
  T_RIGHT_SPLIT = 7,
  H4 = 8,
  V4 = 9,
  N_PARTITIONS = 10,
}

export const enum BlockSize {
  BS_128x128 = 0,
  BS_128x64 = 1,
  BS_64x128 = 2,
  BS_64x64 = 3,
  BS_64x32 = 4,
  BS_64x16 = 5,
  BS_32x64 = 6,
  BS_32x32 = 7,
  BS_32x16 = 8,
  BS_32x8 = 9,
  BS_16x64 = 10,
  BS_16x32 = 11,
  BS_16x16 = 12,
  BS_16x8 = 13,
  BS_16x4 = 14,
  BS_8x32 = 15,
  BS_8x16 = 16,
  BS_8x8 = 17,
  BS_8x4 = 18,
  BS_4x16 = 19,
  BS_4x8 = 20,
  BS_4x4 = 21,
  N_BS_SIZES = 22,
}

export const CFL_ALLOWED_MASK
  = (1 << BlockSize.BS_32x32)
    | (1 << BlockSize.BS_32x16)
    | (1 << BlockSize.BS_32x8)
    | (1 << BlockSize.BS_16x32)
    | (1 << BlockSize.BS_16x16)
    | (1 << BlockSize.BS_16x8)
    | (1 << BlockSize.BS_16x4)
    | (1 << BlockSize.BS_8x32)
    | (1 << BlockSize.BS_8x16)
    | (1 << BlockSize.BS_8x8)
    | (1 << BlockSize.BS_8x4)
    | (1 << BlockSize.BS_4x16)
    | (1 << BlockSize.BS_4x8)
    | (1 << BlockSize.BS_4x4)

// EdgeFlags (intra prediction sample availability)
export const EDGE_I444_TOP_HAS_RIGHT = 1 << 0
export const EDGE_I422_TOP_HAS_RIGHT = 1 << 1
export const EDGE_I420_TOP_HAS_RIGHT = 1 << 2
export const EDGE_I444_LEFT_HAS_BOTTOM = 1 << 3
export const EDGE_I422_LEFT_HAS_BOTTOM = 1 << 4
export const EDGE_I420_LEFT_HAS_BOTTOM = 1 << 5
export const EDGE_ALL_TOP_HAS_RIGHT
  = EDGE_I444_TOP_HAS_RIGHT | EDGE_I422_TOP_HAS_RIGHT | EDGE_I420_TOP_HAS_RIGHT
export const EDGE_ALL_LEFT_HAS_BOTTOM
  = EDGE_I444_LEFT_HAS_BOTTOM | EDGE_I422_LEFT_HAS_BOTTOM | EDGE_I420_LEFT_HAS_BOTTOM
export const EDGE_ALL_TR_AND_BL = EDGE_ALL_TOP_HAS_RIGHT | EDGE_ALL_LEFT_HAS_BOTTOM

/** Pixel layout indices matching dav1d (used to index MAX_TXFM_SIZE_FOR_BS). */
export const enum PixelLayout {
  I400 = 0,
  I420 = 1,
  I422 = 2,
  I444 = 3,
}

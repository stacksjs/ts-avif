/**
 * AV1 inverse transforms, ported from dav1d's src/itx_1d.c and src/itx_tmpl.c
 * (BSD-2-Clause, (c) VideoLAN and dav1d authors), 8bpc only: row and column
 * intermediates clip to int16 and pixels to 0..255. Coefficients arrive
 * packed column-major with stride min(h, 32), exactly as decode-tile stores
 * them, and the consumed region is zeroed on return (same contract as dav1d).
 */
import { TxfmType } from './consts'
import { TXFM_INFO } from './decode-tile'
import type { PixelPlane } from './pixels'
import { bitDepthMax } from './pixels'
import { SCANS } from './tables'

// 1D transform types, matching dav1d itx_1d.h enum Tx1dType
const DCT = 0
const ADST = 1
const IDENTITY = 2
const FLIPADST = 3

// (first, second) 1D type pairs indexed by the public TxfmType. This is
// dav1d_tx1d_types with each asymmetric pair swapped, because dav1d's
// itxfm_add dispatch cross-assigns them (assign_itx_all_fn16 in itx_tmpl.c
// maps e.g. itxfm_add[ADST_DCT] to inv_txfm_add_dct_adst).
const TX1D_TYPES = [
  DCT, DCT, // DCT_DCT
  DCT, ADST, // ADST_DCT
  ADST, DCT, // DCT_ADST
  ADST, ADST, // ADST_ADST
  DCT, FLIPADST, // FLIPADST_DCT
  FLIPADST, DCT, // DCT_FLIPADST
  FLIPADST, FLIPADST, // FLIPADST_FLIPADST
  FLIPADST, ADST, // ADST_FLIPADST
  ADST, FLIPADST, // FLIPADST_ADST
  IDENTITY, IDENTITY, // IDTX
  IDENTITY, DCT, // V_DCT
  DCT, IDENTITY, // H_DCT
  IDENTITY, ADST, // V_ADST
  ADST, IDENTITY, // H_ADST
  IDENTITY, FLIPADST, // V_FLIPADST
  FLIPADST, IDENTITY, // H_FLIPADST
] as const

// Per-RectTxfmSize intermediate downshift, from the inv_txfm_fn
// instantiations at the bottom of itx_tmpl.c.
const SHIFT = [0, 1, 2, 2, 2, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2] as const

function iclip(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

function clipPixel(v: number, max: number): number {
  return v < 0 ? 0 : v > max ? max : v
}

// DCT family (inv_dct4/8/16/32/64_1d_c); the tx64 flag means only the low
// half of the inputs exists, so odd-input products collapse to one term.
function invDct4Internal(c: Int32Array, o: number, s: number, min: number, max: number, tx64: boolean): void {
  const in0 = c[o + 0 * s]
  const in1 = c[o + 1 * s]

  let t0: number, t1: number, t2: number, t3: number
  if (tx64) {
    t0 = t1 = (in0 * 181 + 128) >> 8
    t2 = (in1 * 1567 + 2048) >> 12
    t3 = (in1 * 3784 + 2048) >> 12
  }
  else {
    const in2 = c[o + 2 * s]
    const in3 = c[o + 3 * s]

    t0 = ((in0 + in2) * 181 + 128) >> 8
    t1 = ((in0 - in2) * 181 + 128) >> 8
    t2 = ((in1 * 1567 - in3 * (3784 - 4096) + 2048) >> 12) - in3
    t3 = ((in1 * (3784 - 4096) + in3 * 1567 + 2048) >> 12) + in1
  }

  c[o + 0 * s] = iclip(t0 + t3, min, max)
  c[o + 1 * s] = iclip(t1 + t2, min, max)
  c[o + 2 * s] = iclip(t1 - t2, min, max)
  c[o + 3 * s] = iclip(t0 - t3, min, max)
}

function invDct8Internal(c: Int32Array, o: number, s: number, min: number, max: number, tx64: boolean): void {
  invDct4Internal(c, o, s << 1, min, max, tx64)

  const in1 = c[o + 1 * s]
  const in3 = c[o + 3 * s]

  let t4a: number, t5a: number, t6a: number, t7a: number
  if (tx64) {
    t4a = (in1 * 799 + 2048) >> 12
    t5a = (in3 * -2276 + 2048) >> 12
    t6a = (in3 * 3406 + 2048) >> 12
    t7a = (in1 * 4017 + 2048) >> 12
  }
  else {
    const in5 = c[o + 5 * s]
    const in7 = c[o + 7 * s]

    t4a = ((in1 * 799 - in7 * (4017 - 4096) + 2048) >> 12) - in7
    t5a = (in5 * 1703 - in3 * 1138 + 1024) >> 11
    t6a = (in5 * 1138 + in3 * 1703 + 1024) >> 11
    t7a = ((in1 * (4017 - 4096) + in7 * 799 + 2048) >> 12) + in1
  }

  const t4 = iclip(t4a + t5a, min, max)
  t5a = iclip(t4a - t5a, min, max)
  const t7 = iclip(t7a + t6a, min, max)
  t6a = iclip(t7a - t6a, min, max)

  const t5 = ((t6a - t5a) * 181 + 128) >> 8
  const t6 = ((t6a + t5a) * 181 + 128) >> 8

  const t0 = c[o + 0 * s]
  const t1 = c[o + 2 * s]
  const t2 = c[o + 4 * s]
  const t3 = c[o + 6 * s]

  c[o + 0 * s] = iclip(t0 + t7, min, max)
  c[o + 1 * s] = iclip(t1 + t6, min, max)
  c[o + 2 * s] = iclip(t2 + t5, min, max)
  c[o + 3 * s] = iclip(t3 + t4, min, max)
  c[o + 4 * s] = iclip(t3 - t4, min, max)
  c[o + 5 * s] = iclip(t2 - t5, min, max)
  c[o + 6 * s] = iclip(t1 - t6, min, max)
  c[o + 7 * s] = iclip(t0 - t7, min, max)
}

function invDct16Internal(c: Int32Array, o: number, s: number, min: number, max: number, tx64: boolean): void {
  invDct8Internal(c, o, s << 1, min, max, tx64)

  const in1 = c[o + 1 * s]
  const in3 = c[o + 3 * s]
  const in5 = c[o + 5 * s]
  const in7 = c[o + 7 * s]

  let t8a: number, t9a: number, t10a: number, t11a: number
  let t12a: number, t13a: number, t14a: number, t15a: number
  if (tx64) {
    t8a = (in1 * 401 + 2048) >> 12
    t9a = (in7 * -2598 + 2048) >> 12
    t10a = (in5 * 1931 + 2048) >> 12
    t11a = (in3 * -1189 + 2048) >> 12
    t12a = (in3 * 3920 + 2048) >> 12
    t13a = (in5 * 3612 + 2048) >> 12
    t14a = (in7 * 3166 + 2048) >> 12
    t15a = (in1 * 4076 + 2048) >> 12
  }
  else {
    const in9 = c[o + 9 * s]
    const in11 = c[o + 11 * s]
    const in13 = c[o + 13 * s]
    const in15 = c[o + 15 * s]

    t8a = ((in1 * 401 - in15 * (4076 - 4096) + 2048) >> 12) - in15
    t9a = (in9 * 1583 - in7 * 1299 + 1024) >> 11
    t10a = ((in5 * 1931 - in11 * (3612 - 4096) + 2048) >> 12) - in11
    t11a = ((in13 * (3920 - 4096) - in3 * 1189 + 2048) >> 12) + in13
    t12a = ((in13 * 1189 + in3 * (3920 - 4096) + 2048) >> 12) + in3
    t13a = ((in5 * (3612 - 4096) + in11 * 1931 + 2048) >> 12) + in5
    t14a = (in9 * 1299 + in7 * 1583 + 1024) >> 11
    t15a = ((in1 * (4076 - 4096) + in15 * 401 + 2048) >> 12) + in1
  }

  let t8 = iclip(t8a + t9a, min, max)
  let t9 = iclip(t8a - t9a, min, max)
  let t10 = iclip(t11a - t10a, min, max)
  let t11 = iclip(t11a + t10a, min, max)
  let t12 = iclip(t12a + t13a, min, max)
  let t13 = iclip(t12a - t13a, min, max)
  let t14 = iclip(t15a - t14a, min, max)
  let t15 = iclip(t15a + t14a, min, max)

  t9a = ((t14 * 1567 - t9 * (3784 - 4096) + 2048) >> 12) - t9
  t14a = ((t14 * (3784 - 4096) + t9 * 1567 + 2048) >> 12) + t14
  t10a = ((-(t13 * (3784 - 4096) + t10 * 1567) + 2048) >> 12) - t13
  t13a = ((t13 * 1567 - t10 * (3784 - 4096) + 2048) >> 12) - t10

  t8a = iclip(t8 + t11, min, max)
  t9 = iclip(t9a + t10a, min, max)
  t10 = iclip(t9a - t10a, min, max)
  t11a = iclip(t8 - t11, min, max)
  t12a = iclip(t15 - t12, min, max)
  t13 = iclip(t14a - t13a, min, max)
  t14 = iclip(t14a + t13a, min, max)
  t15a = iclip(t15 + t12, min, max)

  t10a = ((t13 - t10) * 181 + 128) >> 8
  t13a = ((t13 + t10) * 181 + 128) >> 8
  t11 = ((t12a - t11a) * 181 + 128) >> 8
  t12 = ((t12a + t11a) * 181 + 128) >> 8

  const t0 = c[o + 0 * s]
  const t1 = c[o + 2 * s]
  const t2 = c[o + 4 * s]
  const t3 = c[o + 6 * s]
  const t4 = c[o + 8 * s]
  const t5 = c[o + 10 * s]
  const t6 = c[o + 12 * s]
  const t7 = c[o + 14 * s]

  c[o + 0 * s] = iclip(t0 + t15a, min, max)
  c[o + 1 * s] = iclip(t1 + t14, min, max)
  c[o + 2 * s] = iclip(t2 + t13a, min, max)
  c[o + 3 * s] = iclip(t3 + t12, min, max)
  c[o + 4 * s] = iclip(t4 + t11, min, max)
  c[o + 5 * s] = iclip(t5 + t10a, min, max)
  c[o + 6 * s] = iclip(t6 + t9, min, max)
  c[o + 7 * s] = iclip(t7 + t8a, min, max)
  c[o + 8 * s] = iclip(t7 - t8a, min, max)
  c[o + 9 * s] = iclip(t6 - t9, min, max)
  c[o + 10 * s] = iclip(t5 - t10a, min, max)
  c[o + 11 * s] = iclip(t4 - t11, min, max)
  c[o + 12 * s] = iclip(t3 - t12, min, max)
  c[o + 13 * s] = iclip(t2 - t13a, min, max)
  c[o + 14 * s] = iclip(t1 - t14, min, max)
  c[o + 15 * s] = iclip(t0 - t15a, min, max)
}

function invDct32Internal(c: Int32Array, o: number, s: number, min: number, max: number, tx64: boolean): void {
  invDct16Internal(c, o, s << 1, min, max, tx64)

  const in1 = c[o + 1 * s]
  const in3 = c[o + 3 * s]
  const in5 = c[o + 5 * s]
  const in7 = c[o + 7 * s]
  const in9 = c[o + 9 * s]
  const in11 = c[o + 11 * s]
  const in13 = c[o + 13 * s]
  const in15 = c[o + 15 * s]

  let t16a: number, t17a: number, t18a: number, t19a: number
  let t20a: number, t21a: number, t22a: number, t23a: number
  let t24a: number, t25a: number, t26a: number, t27a: number
  let t28a: number, t29a: number, t30a: number, t31a: number
  if (tx64) {
    t16a = (in1 * 201 + 2048) >> 12
    t17a = (in15 * -2751 + 2048) >> 12
    t18a = (in9 * 1751 + 2048) >> 12
    t19a = (in7 * -1380 + 2048) >> 12
    t20a = (in5 * 995 + 2048) >> 12
    t21a = (in11 * -2106 + 2048) >> 12
    t22a = (in13 * 2440 + 2048) >> 12
    t23a = (in3 * -601 + 2048) >> 12
    t24a = (in3 * 4052 + 2048) >> 12
    t25a = (in13 * 3290 + 2048) >> 12
    t26a = (in11 * 3513 + 2048) >> 12
    t27a = (in5 * 3973 + 2048) >> 12
    t28a = (in7 * 3857 + 2048) >> 12
    t29a = (in9 * 3703 + 2048) >> 12
    t30a = (in15 * 3035 + 2048) >> 12
    t31a = (in1 * 4091 + 2048) >> 12
  }
  else {
    const in17 = c[o + 17 * s]
    const in19 = c[o + 19 * s]
    const in21 = c[o + 21 * s]
    const in23 = c[o + 23 * s]
    const in25 = c[o + 25 * s]
    const in27 = c[o + 27 * s]
    const in29 = c[o + 29 * s]
    const in31 = c[o + 31 * s]

    t16a = ((in1 * 201 - in31 * (4091 - 4096) + 2048) >> 12) - in31
    t17a = ((in17 * (3035 - 4096) - in15 * 2751 + 2048) >> 12) + in17
    t18a = ((in9 * 1751 - in23 * (3703 - 4096) + 2048) >> 12) - in23
    t19a = ((in25 * (3857 - 4096) - in7 * 1380 + 2048) >> 12) + in25
    t20a = ((in5 * 995 - in27 * (3973 - 4096) + 2048) >> 12) - in27
    t21a = ((in21 * (3513 - 4096) - in11 * 2106 + 2048) >> 12) + in21
    t22a = (in13 * 1220 - in19 * 1645 + 1024) >> 11
    t23a = ((in29 * (4052 - 4096) - in3 * 601 + 2048) >> 12) + in29
    t24a = ((in29 * 601 + in3 * (4052 - 4096) + 2048) >> 12) + in3
    t25a = (in13 * 1645 + in19 * 1220 + 1024) >> 11
    t26a = ((in21 * 2106 + in11 * (3513 - 4096) + 2048) >> 12) + in11
    t27a = ((in5 * (3973 - 4096) + in27 * 995 + 2048) >> 12) + in5
    t28a = ((in25 * 1380 + in7 * (3857 - 4096) + 2048) >> 12) + in7
    t29a = ((in9 * (3703 - 4096) + in23 * 1751 + 2048) >> 12) + in9
    t30a = ((in17 * 2751 + in15 * (3035 - 4096) + 2048) >> 12) + in15
    t31a = ((in1 * (4091 - 4096) + in31 * 201 + 2048) >> 12) + in1
  }

  let t16 = iclip(t16a + t17a, min, max)
  let t17 = iclip(t16a - t17a, min, max)
  let t18 = iclip(t19a - t18a, min, max)
  let t19 = iclip(t19a + t18a, min, max)
  let t20 = iclip(t20a + t21a, min, max)
  let t21 = iclip(t20a - t21a, min, max)
  let t22 = iclip(t23a - t22a, min, max)
  let t23 = iclip(t23a + t22a, min, max)
  let t24 = iclip(t24a + t25a, min, max)
  let t25 = iclip(t24a - t25a, min, max)
  let t26 = iclip(t27a - t26a, min, max)
  let t27 = iclip(t27a + t26a, min, max)
  let t28 = iclip(t28a + t29a, min, max)
  let t29 = iclip(t28a - t29a, min, max)
  let t30 = iclip(t31a - t30a, min, max)
  let t31 = iclip(t31a + t30a, min, max)

  t17a = ((t30 * 799 - t17 * (4017 - 4096) + 2048) >> 12) - t17
  t30a = ((t30 * (4017 - 4096) + t17 * 799 + 2048) >> 12) + t30
  t18a = ((-(t29 * (4017 - 4096) + t18 * 799) + 2048) >> 12) - t29
  t29a = ((t29 * 799 - t18 * (4017 - 4096) + 2048) >> 12) - t18
  t21a = (t26 * 1703 - t21 * 1138 + 1024) >> 11
  t26a = (t26 * 1138 + t21 * 1703 + 1024) >> 11
  t22a = (-(t25 * 1138 + t22 * 1703) + 1024) >> 11
  t25a = (t25 * 1703 - t22 * 1138 + 1024) >> 11

  t16a = iclip(t16 + t19, min, max)
  t17 = iclip(t17a + t18a, min, max)
  t18 = iclip(t17a - t18a, min, max)
  t19a = iclip(t16 - t19, min, max)
  t20a = iclip(t23 - t20, min, max)
  t21 = iclip(t22a - t21a, min, max)
  t22 = iclip(t22a + t21a, min, max)
  t23a = iclip(t23 + t20, min, max)
  t24a = iclip(t24 + t27, min, max)
  t25 = iclip(t25a + t26a, min, max)
  t26 = iclip(t25a - t26a, min, max)
  t27a = iclip(t24 - t27, min, max)
  t28a = iclip(t31 - t28, min, max)
  t29 = iclip(t30a - t29a, min, max)
  t30 = iclip(t30a + t29a, min, max)
  t31a = iclip(t31 + t28, min, max)

  t18a = ((t29 * 1567 - t18 * (3784 - 4096) + 2048) >> 12) - t18
  t29a = ((t29 * (3784 - 4096) + t18 * 1567 + 2048) >> 12) + t29
  t19 = ((t28a * 1567 - t19a * (3784 - 4096) + 2048) >> 12) - t19a
  t28 = ((t28a * (3784 - 4096) + t19a * 1567 + 2048) >> 12) + t28a
  t20 = ((-(t27a * (3784 - 4096) + t20a * 1567) + 2048) >> 12) - t27a
  t27 = ((t27a * 1567 - t20a * (3784 - 4096) + 2048) >> 12) - t20a
  t21a = ((-(t26 * (3784 - 4096) + t21 * 1567) + 2048) >> 12) - t26
  t26a = ((t26 * 1567 - t21 * (3784 - 4096) + 2048) >> 12) - t21

  t16 = iclip(t16a + t23a, min, max)
  t17a = iclip(t17 + t22, min, max)
  t18 = iclip(t18a + t21a, min, max)
  t19a = iclip(t19 + t20, min, max)
  t20a = iclip(t19 - t20, min, max)
  t21 = iclip(t18a - t21a, min, max)
  t22a = iclip(t17 - t22, min, max)
  t23 = iclip(t16a - t23a, min, max)
  t24 = iclip(t31a - t24a, min, max)
  t25a = iclip(t30 - t25, min, max)
  t26 = iclip(t29a - t26a, min, max)
  t27a = iclip(t28 - t27, min, max)
  t28a = iclip(t28 + t27, min, max)
  t29 = iclip(t29a + t26a, min, max)
  t30a = iclip(t30 + t25, min, max)
  t31 = iclip(t31a + t24a, min, max)

  t20 = ((t27a - t20a) * 181 + 128) >> 8
  t27 = ((t27a + t20a) * 181 + 128) >> 8
  t21a = ((t26 - t21) * 181 + 128) >> 8
  t26a = ((t26 + t21) * 181 + 128) >> 8
  t22 = ((t25a - t22a) * 181 + 128) >> 8
  t25 = ((t25a + t22a) * 181 + 128) >> 8
  t23a = ((t24 - t23) * 181 + 128) >> 8
  t24a = ((t24 + t23) * 181 + 128) >> 8

  const t0 = c[o + 0 * s]
  const t1 = c[o + 2 * s]
  const t2 = c[o + 4 * s]
  const t3 = c[o + 6 * s]
  const t4 = c[o + 8 * s]
  const t5 = c[o + 10 * s]
  const t6 = c[o + 12 * s]
  const t7 = c[o + 14 * s]
  const t8 = c[o + 16 * s]
  const t9 = c[o + 18 * s]
  const t10 = c[o + 20 * s]
  const t11 = c[o + 22 * s]
  const t12 = c[o + 24 * s]
  const t13 = c[o + 26 * s]
  const t14 = c[o + 28 * s]
  const t15 = c[o + 30 * s]

  c[o + 0 * s] = iclip(t0 + t31, min, max)
  c[o + 1 * s] = iclip(t1 + t30a, min, max)
  c[o + 2 * s] = iclip(t2 + t29, min, max)
  c[o + 3 * s] = iclip(t3 + t28a, min, max)
  c[o + 4 * s] = iclip(t4 + t27, min, max)
  c[o + 5 * s] = iclip(t5 + t26a, min, max)
  c[o + 6 * s] = iclip(t6 + t25, min, max)
  c[o + 7 * s] = iclip(t7 + t24a, min, max)
  c[o + 8 * s] = iclip(t8 + t23a, min, max)
  c[o + 9 * s] = iclip(t9 + t22, min, max)
  c[o + 10 * s] = iclip(t10 + t21a, min, max)
  c[o + 11 * s] = iclip(t11 + t20, min, max)
  c[o + 12 * s] = iclip(t12 + t19a, min, max)
  c[o + 13 * s] = iclip(t13 + t18, min, max)
  c[o + 14 * s] = iclip(t14 + t17a, min, max)
  c[o + 15 * s] = iclip(t15 + t16, min, max)
  c[o + 16 * s] = iclip(t15 - t16, min, max)
  c[o + 17 * s] = iclip(t14 - t17a, min, max)
  c[o + 18 * s] = iclip(t13 - t18, min, max)
  c[o + 19 * s] = iclip(t12 - t19a, min, max)
  c[o + 20 * s] = iclip(t11 - t20, min, max)
  c[o + 21 * s] = iclip(t10 - t21a, min, max)
  c[o + 22 * s] = iclip(t9 - t22, min, max)
  c[o + 23 * s] = iclip(t8 - t23a, min, max)
  c[o + 24 * s] = iclip(t7 - t24a, min, max)
  c[o + 25 * s] = iclip(t6 - t25, min, max)
  c[o + 26 * s] = iclip(t5 - t26a, min, max)
  c[o + 27 * s] = iclip(t4 - t27, min, max)
  c[o + 28 * s] = iclip(t3 - t28a, min, max)
  c[o + 29 * s] = iclip(t2 - t29, min, max)
  c[o + 30 * s] = iclip(t1 - t30a, min, max)
  c[o + 31 * s] = iclip(t0 - t31, min, max)
}

function invDct64(c: Int32Array, o: number, s: number, min: number, max: number): void {
  invDct32Internal(c, o, s << 1, min, max, true)

  const in1 = c[o + 1 * s]
  const in3 = c[o + 3 * s]
  const in5 = c[o + 5 * s]
  const in7 = c[o + 7 * s]
  const in9 = c[o + 9 * s]
  const in11 = c[o + 11 * s]
  const in13 = c[o + 13 * s]
  const in15 = c[o + 15 * s]
  const in17 = c[o + 17 * s]
  const in19 = c[o + 19 * s]
  const in21 = c[o + 21 * s]
  const in23 = c[o + 23 * s]
  const in25 = c[o + 25 * s]
  const in27 = c[o + 27 * s]
  const in29 = c[o + 29 * s]
  const in31 = c[o + 31 * s]

  let t32a = (in1 * 101 + 2048) >> 12
  let t33a = (in31 * -2824 + 2048) >> 12
  let t34a = (in17 * 1660 + 2048) >> 12
  let t35a = (in15 * -1474 + 2048) >> 12
  let t36a = (in9 * 897 + 2048) >> 12
  let t37a = (in23 * -2191 + 2048) >> 12
  let t38a = (in25 * 2359 + 2048) >> 12
  let t39a = (in7 * -700 + 2048) >> 12
  let t40a = (in5 * 501 + 2048) >> 12
  let t41a = (in27 * -2520 + 2048) >> 12
  let t42a = (in21 * 2019 + 2048) >> 12
  let t43a = (in11 * -1092 + 2048) >> 12
  let t44a = (in13 * 1285 + 2048) >> 12
  let t45a = (in19 * -1842 + 2048) >> 12
  let t46a = (in29 * 2675 + 2048) >> 12
  let t47a = (in3 * -301 + 2048) >> 12
  let t48a = (in3 * 4085 + 2048) >> 12
  let t49a = (in29 * 3102 + 2048) >> 12
  let t50a = (in19 * 3659 + 2048) >> 12
  let t51a = (in13 * 3889 + 2048) >> 12
  let t52a = (in11 * 3948 + 2048) >> 12
  let t53a = (in21 * 3564 + 2048) >> 12
  let t54a = (in27 * 3229 + 2048) >> 12
  let t55a = (in5 * 4065 + 2048) >> 12
  let t56a = (in7 * 4036 + 2048) >> 12
  let t57a = (in25 * 3349 + 2048) >> 12
  let t58a = (in23 * 3461 + 2048) >> 12
  let t59a = (in9 * 3996 + 2048) >> 12
  let t60a = (in15 * 3822 + 2048) >> 12
  let t61a = (in17 * 3745 + 2048) >> 12
  let t62a = (in31 * 2967 + 2048) >> 12
  let t63a = (in1 * 4095 + 2048) >> 12

  let t32 = iclip(t32a + t33a, min, max)
  let t33 = iclip(t32a - t33a, min, max)
  let t34 = iclip(t35a - t34a, min, max)
  let t35 = iclip(t35a + t34a, min, max)
  let t36 = iclip(t36a + t37a, min, max)
  let t37 = iclip(t36a - t37a, min, max)
  let t38 = iclip(t39a - t38a, min, max)
  let t39 = iclip(t39a + t38a, min, max)
  let t40 = iclip(t40a + t41a, min, max)
  let t41 = iclip(t40a - t41a, min, max)
  let t42 = iclip(t43a - t42a, min, max)
  let t43 = iclip(t43a + t42a, min, max)
  let t44 = iclip(t44a + t45a, min, max)
  let t45 = iclip(t44a - t45a, min, max)
  let t46 = iclip(t47a - t46a, min, max)
  let t47 = iclip(t47a + t46a, min, max)
  let t48 = iclip(t48a + t49a, min, max)
  let t49 = iclip(t48a - t49a, min, max)
  let t50 = iclip(t51a - t50a, min, max)
  let t51 = iclip(t51a + t50a, min, max)
  let t52 = iclip(t52a + t53a, min, max)
  let t53 = iclip(t52a - t53a, min, max)
  let t54 = iclip(t55a - t54a, min, max)
  let t55 = iclip(t55a + t54a, min, max)
  let t56 = iclip(t56a + t57a, min, max)
  let t57 = iclip(t56a - t57a, min, max)
  let t58 = iclip(t59a - t58a, min, max)
  let t59 = iclip(t59a + t58a, min, max)
  let t60 = iclip(t60a + t61a, min, max)
  let t61 = iclip(t60a - t61a, min, max)
  let t62 = iclip(t63a - t62a, min, max)
  let t63 = iclip(t63a + t62a, min, max)

  t33a = ((t33 * (4096 - 4076) + t62 * 401 + 2048) >> 12) - t33
  t34a = ((t34 * -401 + t61 * (4096 - 4076) + 2048) >> 12) - t61
  t37a = (t37 * -1299 + t58 * 1583 + 1024) >> 11
  t38a = (t38 * -1583 + t57 * -1299 + 1024) >> 11
  t41a = ((t41 * (4096 - 3612) + t54 * 1931 + 2048) >> 12) - t41
  t42a = ((t42 * -1931 + t53 * (4096 - 3612) + 2048) >> 12) - t53
  t45a = ((t45 * -1189 + t50 * (3920 - 4096) + 2048) >> 12) + t50
  t46a = ((t46 * (4096 - 3920) + t49 * -1189 + 2048) >> 12) - t46
  t49a = ((t46 * -1189 + t49 * (3920 - 4096) + 2048) >> 12) + t49
  t50a = ((t45 * (3920 - 4096) + t50 * 1189 + 2048) >> 12) + t45
  t53a = ((t42 * (4096 - 3612) + t53 * 1931 + 2048) >> 12) - t42
  t54a = ((t41 * 1931 + t54 * (3612 - 4096) + 2048) >> 12) + t54
  t57a = (t38 * -1299 + t57 * 1583 + 1024) >> 11
  t58a = (t37 * 1583 + t58 * 1299 + 1024) >> 11
  t61a = ((t34 * (4096 - 4076) + t61 * 401 + 2048) >> 12) - t34
  t62a = ((t33 * 401 + t62 * (4076 - 4096) + 2048) >> 12) + t62

  t32a = iclip(t32 + t35, min, max)
  t33 = iclip(t33a + t34a, min, max)
  t34 = iclip(t33a - t34a, min, max)
  t35a = iclip(t32 - t35, min, max)
  t36a = iclip(t39 - t36, min, max)
  t37 = iclip(t38a - t37a, min, max)
  t38 = iclip(t38a + t37a, min, max)
  t39a = iclip(t39 + t36, min, max)
  t40a = iclip(t40 + t43, min, max)
  t41 = iclip(t41a + t42a, min, max)
  t42 = iclip(t41a - t42a, min, max)
  t43a = iclip(t40 - t43, min, max)
  t44a = iclip(t47 - t44, min, max)
  t45 = iclip(t46a - t45a, min, max)
  t46 = iclip(t46a + t45a, min, max)
  t47a = iclip(t47 + t44, min, max)
  t48a = iclip(t48 + t51, min, max)
  t49 = iclip(t49a + t50a, min, max)
  t50 = iclip(t49a - t50a, min, max)
  t51a = iclip(t48 - t51, min, max)
  t52a = iclip(t55 - t52, min, max)
  t53 = iclip(t54a - t53a, min, max)
  t54 = iclip(t54a + t53a, min, max)
  t55a = iclip(t55 + t52, min, max)
  t56a = iclip(t56 + t59, min, max)
  t57 = iclip(t57a + t58a, min, max)
  t58 = iclip(t57a - t58a, min, max)
  t59a = iclip(t56 - t59, min, max)
  t60a = iclip(t63 - t60, min, max)
  t61 = iclip(t62a - t61a, min, max)
  t62 = iclip(t62a + t61a, min, max)
  t63a = iclip(t63 + t60, min, max)

  t34a = ((t34 * (4096 - 4017) + t61 * 799 + 2048) >> 12) - t34
  t35 = ((t35a * (4096 - 4017) + t60a * 799 + 2048) >> 12) - t35a
  t36 = ((t36a * -799 + t59a * (4096 - 4017) + 2048) >> 12) - t59a
  t37a = ((t37 * -799 + t58 * (4096 - 4017) + 2048) >> 12) - t58
  t42a = (t42 * -1138 + t53 * 1703 + 1024) >> 11
  t43 = (t43a * -1138 + t52a * 1703 + 1024) >> 11
  t44 = (t44a * -1703 + t51a * -1138 + 1024) >> 11
  t45a = (t45 * -1703 + t50 * -1138 + 1024) >> 11
  t50a = (t45 * -1138 + t50 * 1703 + 1024) >> 11
  t51 = (t44a * -1138 + t51a * 1703 + 1024) >> 11
  t52 = (t43a * 1703 + t52a * 1138 + 1024) >> 11
  t53a = (t42 * 1703 + t53 * 1138 + 1024) >> 11
  t58a = ((t37 * (4096 - 4017) + t58 * 799 + 2048) >> 12) - t37
  t59 = ((t36a * (4096 - 4017) + t59a * 799 + 2048) >> 12) - t36a
  t60 = ((t35a * 799 + t60a * (4017 - 4096) + 2048) >> 12) + t60a
  t61a = ((t34 * 799 + t61 * (4017 - 4096) + 2048) >> 12) + t61

  t32 = iclip(t32a + t39a, min, max)
  t33a = iclip(t33 + t38, min, max)
  t34 = iclip(t34a + t37a, min, max)
  t35a = iclip(t35 + t36, min, max)
  t36a = iclip(t35 - t36, min, max)
  t37 = iclip(t34a - t37a, min, max)
  t38a = iclip(t33 - t38, min, max)
  t39 = iclip(t32a - t39a, min, max)
  t40 = iclip(t47a - t40a, min, max)
  t41a = iclip(t46 - t41, min, max)
  t42 = iclip(t45a - t42a, min, max)
  t43a = iclip(t44 - t43, min, max)
  t44a = iclip(t44 + t43, min, max)
  t45 = iclip(t45a + t42a, min, max)
  t46a = iclip(t46 + t41, min, max)
  t47 = iclip(t47a + t40a, min, max)
  t48 = iclip(t48a + t55a, min, max)
  t49a = iclip(t49 + t54, min, max)
  t50 = iclip(t50a + t53a, min, max)
  t51a = iclip(t51 + t52, min, max)
  t52a = iclip(t51 - t52, min, max)
  t53 = iclip(t50a - t53a, min, max)
  t54a = iclip(t49 - t54, min, max)
  t55 = iclip(t48a - t55a, min, max)
  t56 = iclip(t63a - t56a, min, max)
  t57a = iclip(t62 - t57, min, max)
  t58 = iclip(t61a - t58a, min, max)
  t59a = iclip(t60 - t59, min, max)
  t60a = iclip(t60 + t59, min, max)
  t61 = iclip(t61a + t58a, min, max)
  t62a = iclip(t62 + t57, min, max)
  t63 = iclip(t63a + t56a, min, max)

  t36 = ((t36a * (4096 - 3784) + t59a * 1567 + 2048) >> 12) - t36a
  t37a = ((t37 * (4096 - 3784) + t58 * 1567 + 2048) >> 12) - t37
  t38 = ((t38a * (4096 - 3784) + t57a * 1567 + 2048) >> 12) - t38a
  t39a = ((t39 * (4096 - 3784) + t56 * 1567 + 2048) >> 12) - t39
  t40a = ((t40 * -1567 + t55 * (4096 - 3784) + 2048) >> 12) - t55
  t41 = ((t41a * -1567 + t54a * (4096 - 3784) + 2048) >> 12) - t54a
  t42a = ((t42 * -1567 + t53 * (4096 - 3784) + 2048) >> 12) - t53
  t43 = ((t43a * -1567 + t52a * (4096 - 3784) + 2048) >> 12) - t52a
  t52 = ((t43a * (4096 - 3784) + t52a * 1567 + 2048) >> 12) - t43a
  t53a = ((t42 * (4096 - 3784) + t53 * 1567 + 2048) >> 12) - t42
  t54 = ((t41a * (4096 - 3784) + t54a * 1567 + 2048) >> 12) - t41a
  t55a = ((t40 * (4096 - 3784) + t55 * 1567 + 2048) >> 12) - t40
  t56a = ((t39 * 1567 + t56 * (3784 - 4096) + 2048) >> 12) + t56
  t57 = ((t38a * 1567 + t57a * (3784 - 4096) + 2048) >> 12) + t57a
  t58a = ((t37 * 1567 + t58 * (3784 - 4096) + 2048) >> 12) + t58
  t59 = ((t36a * 1567 + t59a * (3784 - 4096) + 2048) >> 12) + t59a

  t32a = iclip(t32 + t47, min, max)
  t33 = iclip(t33a + t46a, min, max)
  t34a = iclip(t34 + t45, min, max)
  t35 = iclip(t35a + t44a, min, max)
  t36a = iclip(t36 + t43, min, max)
  t37 = iclip(t37a + t42a, min, max)
  t38a = iclip(t38 + t41, min, max)
  t39 = iclip(t39a + t40a, min, max)
  t40 = iclip(t39a - t40a, min, max)
  t41a = iclip(t38 - t41, min, max)
  t42 = iclip(t37a - t42a, min, max)
  t43a = iclip(t36 - t43, min, max)
  t44 = iclip(t35a - t44a, min, max)
  t45a = iclip(t34 - t45, min, max)
  t46 = iclip(t33a - t46a, min, max)
  t47a = iclip(t32 - t47, min, max)
  t48a = iclip(t63 - t48, min, max)
  t49 = iclip(t62a - t49a, min, max)
  t50a = iclip(t61 - t50, min, max)
  t51 = iclip(t60a - t51a, min, max)
  t52a = iclip(t59 - t52, min, max)
  t53 = iclip(t58a - t53a, min, max)
  t54a = iclip(t57 - t54, min, max)
  t55 = iclip(t56a - t55a, min, max)
  t56 = iclip(t56a + t55a, min, max)
  t57a = iclip(t57 + t54, min, max)
  t58 = iclip(t58a + t53a, min, max)
  t59a = iclip(t59 + t52, min, max)
  t60 = iclip(t60a + t51a, min, max)
  t61a = iclip(t61 + t50, min, max)
  t62 = iclip(t62a + t49a, min, max)
  t63a = iclip(t63 + t48, min, max)

  t40a = ((t55 - t40) * 181 + 128) >> 8
  t41 = ((t54a - t41a) * 181 + 128) >> 8
  t42a = ((t53 - t42) * 181 + 128) >> 8
  t43 = ((t52a - t43a) * 181 + 128) >> 8
  t44a = ((t51 - t44) * 181 + 128) >> 8
  t45 = ((t50a - t45a) * 181 + 128) >> 8
  t46a = ((t49 - t46) * 181 + 128) >> 8
  t47 = ((t48a - t47a) * 181 + 128) >> 8
  t48 = ((t47a + t48a) * 181 + 128) >> 8
  t49a = ((t46 + t49) * 181 + 128) >> 8
  t50 = ((t45a + t50a) * 181 + 128) >> 8
  t51a = ((t44 + t51) * 181 + 128) >> 8
  t52 = ((t43a + t52a) * 181 + 128) >> 8
  t53a = ((t42 + t53) * 181 + 128) >> 8
  t54 = ((t41a + t54a) * 181 + 128) >> 8
  t55a = ((t40 + t55) * 181 + 128) >> 8

  const t0 = c[o + 0 * s]
  const t1 = c[o + 2 * s]
  const t2 = c[o + 4 * s]
  const t3 = c[o + 6 * s]
  const t4 = c[o + 8 * s]
  const t5 = c[o + 10 * s]
  const t6 = c[o + 12 * s]
  const t7 = c[o + 14 * s]
  const t8 = c[o + 16 * s]
  const t9 = c[o + 18 * s]
  const t10 = c[o + 20 * s]
  const t11 = c[o + 22 * s]
  const t12 = c[o + 24 * s]
  const t13 = c[o + 26 * s]
  const t14 = c[o + 28 * s]
  const t15 = c[o + 30 * s]
  const t16 = c[o + 32 * s]
  const t17 = c[o + 34 * s]
  const t18 = c[o + 36 * s]
  const t19 = c[o + 38 * s]
  const t20 = c[o + 40 * s]
  const t21 = c[o + 42 * s]
  const t22 = c[o + 44 * s]
  const t23 = c[o + 46 * s]
  const t24 = c[o + 48 * s]
  const t25 = c[o + 50 * s]
  const t26 = c[o + 52 * s]
  const t27 = c[o + 54 * s]
  const t28 = c[o + 56 * s]
  const t29 = c[o + 58 * s]
  const t30 = c[o + 60 * s]
  const t31 = c[o + 62 * s]

  c[o + 0 * s] = iclip(t0 + t63a, min, max)
  c[o + 1 * s] = iclip(t1 + t62, min, max)
  c[o + 2 * s] = iclip(t2 + t61a, min, max)
  c[o + 3 * s] = iclip(t3 + t60, min, max)
  c[o + 4 * s] = iclip(t4 + t59a, min, max)
  c[o + 5 * s] = iclip(t5 + t58, min, max)
  c[o + 6 * s] = iclip(t6 + t57a, min, max)
  c[o + 7 * s] = iclip(t7 + t56, min, max)
  c[o + 8 * s] = iclip(t8 + t55a, min, max)
  c[o + 9 * s] = iclip(t9 + t54, min, max)
  c[o + 10 * s] = iclip(t10 + t53a, min, max)
  c[o + 11 * s] = iclip(t11 + t52, min, max)
  c[o + 12 * s] = iclip(t12 + t51a, min, max)
  c[o + 13 * s] = iclip(t13 + t50, min, max)
  c[o + 14 * s] = iclip(t14 + t49a, min, max)
  c[o + 15 * s] = iclip(t15 + t48, min, max)
  c[o + 16 * s] = iclip(t16 + t47, min, max)
  c[o + 17 * s] = iclip(t17 + t46a, min, max)
  c[o + 18 * s] = iclip(t18 + t45, min, max)
  c[o + 19 * s] = iclip(t19 + t44a, min, max)
  c[o + 20 * s] = iclip(t20 + t43, min, max)
  c[o + 21 * s] = iclip(t21 + t42a, min, max)
  c[o + 22 * s] = iclip(t22 + t41, min, max)
  c[o + 23 * s] = iclip(t23 + t40a, min, max)
  c[o + 24 * s] = iclip(t24 + t39, min, max)
  c[o + 25 * s] = iclip(t25 + t38a, min, max)
  c[o + 26 * s] = iclip(t26 + t37, min, max)
  c[o + 27 * s] = iclip(t27 + t36a, min, max)
  c[o + 28 * s] = iclip(t28 + t35, min, max)
  c[o + 29 * s] = iclip(t29 + t34a, min, max)
  c[o + 30 * s] = iclip(t30 + t33, min, max)
  c[o + 31 * s] = iclip(t31 + t32a, min, max)
  c[o + 32 * s] = iclip(t31 - t32a, min, max)
  c[o + 33 * s] = iclip(t30 - t33, min, max)
  c[o + 34 * s] = iclip(t29 - t34a, min, max)
  c[o + 35 * s] = iclip(t28 - t35, min, max)
  c[o + 36 * s] = iclip(t27 - t36a, min, max)
  c[o + 37 * s] = iclip(t26 - t37, min, max)
  c[o + 38 * s] = iclip(t25 - t38a, min, max)
  c[o + 39 * s] = iclip(t24 - t39, min, max)
  c[o + 40 * s] = iclip(t23 - t40a, min, max)
  c[o + 41 * s] = iclip(t22 - t41, min, max)
  c[o + 42 * s] = iclip(t21 - t42a, min, max)
  c[o + 43 * s] = iclip(t20 - t43, min, max)
  c[o + 44 * s] = iclip(t19 - t44a, min, max)
  c[o + 45 * s] = iclip(t18 - t45, min, max)
  c[o + 46 * s] = iclip(t17 - t46a, min, max)
  c[o + 47 * s] = iclip(t16 - t47, min, max)
  c[o + 48 * s] = iclip(t15 - t48, min, max)
  c[o + 49 * s] = iclip(t14 - t49a, min, max)
  c[o + 50 * s] = iclip(t13 - t50, min, max)
  c[o + 51 * s] = iclip(t12 - t51a, min, max)
  c[o + 52 * s] = iclip(t11 - t52, min, max)
  c[o + 53 * s] = iclip(t10 - t53a, min, max)
  c[o + 54 * s] = iclip(t9 - t54, min, max)
  c[o + 55 * s] = iclip(t8 - t55a, min, max)
  c[o + 56 * s] = iclip(t7 - t56, min, max)
  c[o + 57 * s] = iclip(t6 - t57a, min, max)
  c[o + 58 * s] = iclip(t5 - t58, min, max)
  c[o + 59 * s] = iclip(t4 - t59a, min, max)
  c[o + 60 * s] = iclip(t3 - t60, min, max)
  c[o + 61 * s] = iclip(t2 - t61a, min, max)
  c[o + 62 * s] = iclip(t1 - t62, min, max)
  c[o + 63 * s] = iclip(t0 - t63a, min, max)
}

// ADST family (inv_adst4/8/16_1d_internal_c); the flip variants write the
// same outputs in reverse order via a negative output stride.
function invAdst4Internal(c: Int32Array, inO: number, inS: number, outO: number, outS: number): void {
  const in0 = c[inO + 0 * inS]
  const in1 = c[inO + 1 * inS]
  const in2 = c[inO + 2 * inS]
  const in3 = c[inO + 3 * inS]

  c[outO + 0 * outS] = ((1321 * in0 + (3803 - 4096) * in2
    + (2482 - 4096) * in3 + (3344 - 4096) * in1 + 2048) >> 12)
    + in2 + in3 + in1
  c[outO + 1 * outS] = (((2482 - 4096) * in0 - 1321 * in2
    - (3803 - 4096) * in3 + (3344 - 4096) * in1 + 2048) >> 12)
    + in0 - in3 + in1
  c[outO + 2 * outS] = (209 * (in0 - in2 + in3) + 128) >> 8
  c[outO + 3 * outS] = (((3803 - 4096) * in0 + (2482 - 4096) * in2
    - 1321 * in3 - (3344 - 4096) * in1 + 2048) >> 12)
    + in0 + in2 - in1
}

function invAdst8Internal(c: Int32Array, inO: number, inS: number, min: number, max: number, outO: number, outS: number): void {
  const in0 = c[inO + 0 * inS]
  const in1 = c[inO + 1 * inS]
  const in2 = c[inO + 2 * inS]
  const in3 = c[inO + 3 * inS]
  const in4 = c[inO + 4 * inS]
  const in5 = c[inO + 5 * inS]
  const in6 = c[inO + 6 * inS]
  const in7 = c[inO + 7 * inS]

  const t0a = (((4076 - 4096) * in7 + 401 * in0 + 2048) >> 12) + in7
  const t1a = ((401 * in7 - (4076 - 4096) * in0 + 2048) >> 12) - in0
  const t2a = (((3612 - 4096) * in5 + 1931 * in2 + 2048) >> 12) + in5
  const t3a = ((1931 * in5 - (3612 - 4096) * in2 + 2048) >> 12) - in2
  let t4a = (1299 * in3 + 1583 * in4 + 1024) >> 11
  let t5a = (1583 * in3 - 1299 * in4 + 1024) >> 11
  let t6a = ((1189 * in1 + (3920 - 4096) * in6 + 2048) >> 12) + in6
  let t7a = (((3920 - 4096) * in1 - 1189 * in6 + 2048) >> 12) + in1

  const t0 = iclip(t0a + t4a, min, max)
  const t1 = iclip(t1a + t5a, min, max)
  let t2 = iclip(t2a + t6a, min, max)
  let t3 = iclip(t3a + t7a, min, max)
  const t4 = iclip(t0a - t4a, min, max)
  const t5 = iclip(t1a - t5a, min, max)
  let t6 = iclip(t2a - t6a, min, max)
  let t7 = iclip(t3a - t7a, min, max)

  t4a = (((3784 - 4096) * t4 + 1567 * t5 + 2048) >> 12) + t4
  t5a = ((1567 * t4 - (3784 - 4096) * t5 + 2048) >> 12) - t5
  t6a = (((3784 - 4096) * t7 - 1567 * t6 + 2048) >> 12) + t7
  t7a = ((1567 * t7 + (3784 - 4096) * t6 + 2048) >> 12) + t6

  c[outO + 0 * outS] = iclip(t0 + t2, min, max)
  c[outO + 7 * outS] = -iclip(t1 + t3, min, max)
  t2 = iclip(t0 - t2, min, max)
  t3 = iclip(t1 - t3, min, max)
  c[outO + 1 * outS] = -iclip(t4a + t6a, min, max)
  c[outO + 6 * outS] = iclip(t5a + t7a, min, max)
  t6 = iclip(t4a - t6a, min, max)
  t7 = iclip(t5a - t7a, min, max)

  c[outO + 3 * outS] = -(((t2 + t3) * 181 + 128) >> 8)
  c[outO + 4 * outS] = ((t2 - t3) * 181 + 128) >> 8
  c[outO + 2 * outS] = ((t6 + t7) * 181 + 128) >> 8
  c[outO + 5 * outS] = -(((t6 - t7) * 181 + 128) >> 8)
}

function invAdst16Internal(c: Int32Array, inO: number, inS: number, min: number, max: number, outO: number, outS: number): void {
  const in0 = c[inO + 0 * inS]
  const in1 = c[inO + 1 * inS]
  const in2 = c[inO + 2 * inS]
  const in3 = c[inO + 3 * inS]
  const in4 = c[inO + 4 * inS]
  const in5 = c[inO + 5 * inS]
  const in6 = c[inO + 6 * inS]
  const in7 = c[inO + 7 * inS]
  const in8 = c[inO + 8 * inS]
  const in9 = c[inO + 9 * inS]
  const in10 = c[inO + 10 * inS]
  const in11 = c[inO + 11 * inS]
  const in12 = c[inO + 12 * inS]
  const in13 = c[inO + 13 * inS]
  const in14 = c[inO + 14 * inS]
  const in15 = c[inO + 15 * inS]

  let t0 = ((in15 * (4091 - 4096) + in0 * 201 + 2048) >> 12) + in15
  let t1 = ((in15 * 201 - in0 * (4091 - 4096) + 2048) >> 12) - in0
  let t2 = ((in13 * (3973 - 4096) + in2 * 995 + 2048) >> 12) + in13
  let t3 = ((in13 * 995 - in2 * (3973 - 4096) + 2048) >> 12) - in2
  let t4 = ((in11 * (3703 - 4096) + in4 * 1751 + 2048) >> 12) + in11
  let t5 = ((in11 * 1751 - in4 * (3703 - 4096) + 2048) >> 12) - in4
  let t6 = (in9 * 1645 + in6 * 1220 + 1024) >> 11
  let t7 = (in9 * 1220 - in6 * 1645 + 1024) >> 11
  let t8 = ((in7 * 2751 + in8 * (3035 - 4096) + 2048) >> 12) + in8
  let t9 = ((in7 * (3035 - 4096) - in8 * 2751 + 2048) >> 12) + in7
  let t10 = ((in5 * 2106 + in10 * (3513 - 4096) + 2048) >> 12) + in10
  let t11 = ((in5 * (3513 - 4096) - in10 * 2106 + 2048) >> 12) + in5
  let t12 = ((in3 * 1380 + in12 * (3857 - 4096) + 2048) >> 12) + in12
  let t13 = ((in3 * (3857 - 4096) - in12 * 1380 + 2048) >> 12) + in3
  let t14 = ((in1 * 601 + in14 * (4052 - 4096) + 2048) >> 12) + in14
  let t15 = ((in1 * (4052 - 4096) - in14 * 601 + 2048) >> 12) + in1

  const t0a = iclip(t0 + t8, min, max)
  const t1a = iclip(t1 + t9, min, max)
  const t2a = iclip(t2 + t10, min, max)
  const t3a = iclip(t3 + t11, min, max)
  let t4a = iclip(t4 + t12, min, max)
  let t5a = iclip(t5 + t13, min, max)
  let t6a = iclip(t6 + t14, min, max)
  let t7a = iclip(t7 + t15, min, max)
  let t8a = iclip(t0 - t8, min, max)
  let t9a = iclip(t1 - t9, min, max)
  let t10a = iclip(t2 - t10, min, max)
  let t11a = iclip(t3 - t11, min, max)
  let t12a = iclip(t4 - t12, min, max)
  let t13a = iclip(t5 - t13, min, max)
  let t14a = iclip(t6 - t14, min, max)
  let t15a = iclip(t7 - t15, min, max)

  t8 = ((t8a * (4017 - 4096) + t9a * 799 + 2048) >> 12) + t8a
  t9 = ((t8a * 799 - t9a * (4017 - 4096) + 2048) >> 12) - t9a
  t10 = ((t10a * 2276 + t11a * (3406 - 4096) + 2048) >> 12) + t11a
  t11 = ((t10a * (3406 - 4096) - t11a * 2276 + 2048) >> 12) + t10a
  t12 = ((t13a * (4017 - 4096) - t12a * 799 + 2048) >> 12) + t13a
  t13 = ((t13a * 799 + t12a * (4017 - 4096) + 2048) >> 12) + t12a
  t14 = ((t15a * 2276 - t14a * (3406 - 4096) + 2048) >> 12) - t14a
  t15 = ((t15a * (3406 - 4096) + t14a * 2276 + 2048) >> 12) + t15a

  t0 = iclip(t0a + t4a, min, max)
  t1 = iclip(t1a + t5a, min, max)
  t2 = iclip(t2a + t6a, min, max)
  t3 = iclip(t3a + t7a, min, max)
  t4 = iclip(t0a - t4a, min, max)
  t5 = iclip(t1a - t5a, min, max)
  t6 = iclip(t2a - t6a, min, max)
  t7 = iclip(t3a - t7a, min, max)
  t8a = iclip(t8 + t12, min, max)
  t9a = iclip(t9 + t13, min, max)
  t10a = iclip(t10 + t14, min, max)
  t11a = iclip(t11 + t15, min, max)
  t12a = iclip(t8 - t12, min, max)
  t13a = iclip(t9 - t13, min, max)
  t14a = iclip(t10 - t14, min, max)
  t15a = iclip(t11 - t15, min, max)

  t4a = ((t4 * (3784 - 4096) + t5 * 1567 + 2048) >> 12) + t4
  t5a = ((t4 * 1567 - t5 * (3784 - 4096) + 2048) >> 12) - t5
  t6a = ((t7 * (3784 - 4096) - t6 * 1567 + 2048) >> 12) + t7
  t7a = ((t7 * 1567 + t6 * (3784 - 4096) + 2048) >> 12) + t6
  t12 = ((t12a * (3784 - 4096) + t13a * 1567 + 2048) >> 12) + t12a
  t13 = ((t12a * 1567 - t13a * (3784 - 4096) + 2048) >> 12) - t13a
  t14 = ((t15a * (3784 - 4096) - t14a * 1567 + 2048) >> 12) + t15a
  t15 = ((t15a * 1567 + t14a * (3784 - 4096) + 2048) >> 12) + t14a

  c[outO + 0 * outS] = iclip(t0 + t2, min, max)
  c[outO + 15 * outS] = -iclip(t1 + t3, min, max)
  const t2a2 = iclip(t0 - t2, min, max)
  const t3a2 = iclip(t1 - t3, min, max)
  c[outO + 3 * outS] = -iclip(t4a + t6a, min, max)
  c[outO + 12 * outS] = iclip(t5a + t7a, min, max)
  t6 = iclip(t4a - t6a, min, max)
  t7 = iclip(t5a - t7a, min, max)
  c[outO + 1 * outS] = -iclip(t8a + t10a, min, max)
  c[outO + 14 * outS] = iclip(t9a + t11a, min, max)
  t10 = iclip(t8a - t10a, min, max)
  t11 = iclip(t9a - t11a, min, max)
  c[outO + 2 * outS] = iclip(t12 + t14, min, max)
  c[outO + 13 * outS] = -iclip(t13 + t15, min, max)
  t14a = iclip(t12 - t14, min, max)
  t15a = iclip(t13 - t15, min, max)

  c[outO + 7 * outS] = -(((t2a2 + t3a2) * 181 + 128) >> 8)
  c[outO + 8 * outS] = ((t2a2 - t3a2) * 181 + 128) >> 8
  c[outO + 4 * outS] = ((t6 + t7) * 181 + 128) >> 8
  c[outO + 11 * outS] = -(((t6 - t7) * 181 + 128) >> 8)
  c[outO + 6 * outS] = ((t10 + t11) * 181 + 128) >> 8
  c[outO + 9 * outS] = -(((t10 - t11) * 181 + 128) >> 8)
  c[outO + 5 * outS] = -(((t14a + t15a) * 181 + 128) >> 8)
  c[outO + 10 * outS] = ((t14a - t15a) * 181 + 128) >> 8
}

// Identity family (inv_identity4/8/16/32_1d_c), exact dav1d multipliers.
function invIdentity4(c: Int32Array, o: number, s: number): void {
  for (let i = 0; i < 4; i++) {
    const v = c[o + s * i]
    c[o + s * i] = v + ((v * 1697 + 2048) >> 12)
  }
}

function invIdentity8(c: Int32Array, o: number, s: number): void {
  for (let i = 0; i < 8; i++)
    c[o + s * i] *= 2
}

function invIdentity16(c: Int32Array, o: number, s: number): void {
  for (let i = 0; i < 16; i++) {
    const v = c[o + s * i]
    c[o + s * i] = 2 * v + ((v * 1697 + 1024) >> 11)
  }
}

function invIdentity32(c: Int32Array, o: number, s: number): void {
  for (let i = 0; i < 32; i++)
    c[o + s * i] *= 4
}

// Walsh-Hadamard 4-point (dav1d_inv_wht4_1d_c), used only by WHT_WHT 4x4.
function invWht4(c: Int32Array, o: number, s: number): void {
  const in0 = c[o + 0 * s]
  const in1 = c[o + 1 * s]
  const in2 = c[o + 2 * s]
  const in3 = c[o + 3 * s]

  const t0 = in0 + in1
  const t2 = in2 - in3
  const t4 = (t0 - t2) >> 1
  const t3 = t4 - in3
  const t1 = t4 - in1

  c[o + 0 * s] = t0 - t3
  c[o + 1 * s] = t3
  c[o + 2 * s] = t1
  c[o + 3 * s] = t2 + t1
}

type Itx1dFn = (c: Int32Array, o: number, s: number, min: number, max: number) => void

const dct4: Itx1dFn = (c, o, s, min, max) => invDct4Internal(c, o, s, min, max, false)
const dct8: Itx1dFn = (c, o, s, min, max) => invDct8Internal(c, o, s, min, max, false)
const dct16: Itx1dFn = (c, o, s, min, max) => invDct16Internal(c, o, s, min, max, false)
const dct32: Itx1dFn = (c, o, s, min, max) => invDct32Internal(c, o, s, min, max, false)
const adst4: Itx1dFn = (c, o, s) => invAdst4Internal(c, o, s, o, s)
const flipadst4: Itx1dFn = (c, o, s) => invAdst4Internal(c, o, s, o + 3 * s, -s)
const adst8: Itx1dFn = (c, o, s, min, max) => invAdst8Internal(c, o, s, min, max, o, s)
const flipadst8: Itx1dFn = (c, o, s, min, max) => invAdst8Internal(c, o, s, min, max, o + 7 * s, -s)
const adst16: Itx1dFn = (c, o, s, min, max) => invAdst16Internal(c, o, s, min, max, o, s)
const flipadst16: Itx1dFn = (c, o, s, min, max) => invAdst16Internal(c, o, s, min, max, o + 15 * s, -s)

// dav1d_tx1d_fns[log2(size)-2][Tx1dType]
const TX1D_FNS: (Itx1dFn | undefined)[][] = [
  [dct4, adst4, invIdentity4, flipadst4],
  [dct8, adst8, invIdentity8, flipadst8],
  [dct16, adst16, invIdentity16, flipadst16],
  [dct32, undefined, invIdentity32, undefined],
  [invDct64, undefined, undefined, undefined],
]

// last_nonzero_col_from_eob tables (scan.c init_tbl), built per RectTxfmSize
// from its scan; SCANS already carries dav1d's 64-to-32 geometry aliasing.
const LAST_NONZERO_COL_FROM_EOB: Uint8Array[] = []
for (let tx = 0; tx < 19; tx++) {
  const tDim = TXFM_INFO[tx]
  const sw = Math.min(4 * tDim.w, 32)
  const sh = Math.min(4 * tDim.h, 32)
  const scan = SCANS[tx]
  const tbl = new Uint8Array(sw * sh)
  let maxCol = 0
  for (let n = 0; n < sw * sh; n++) {
    const rcx = scan[n] & (sh - 1)
    if (rcx > maxCol)
      maxCol = rcx
    tbl[n] = maxCol
  }
  LAST_NONZERO_COL_FROM_EOB.push(tbl)
}

const TMP = new Int32Array(64 * 64)

function invTxfmAddWht4x4(
  dst: PixelPlane,
  dstOff: number,
  stride: number,
  cf: Int32Array,
  max: number,
): void {
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++)
      TMP[y * 4 + x] = cf[y + x * 4] >> 2
    invWht4(TMP, y * 4, 1)
  }
  cf.fill(0, 0, 4 * 4)

  for (let x = 0; x < 4; x++)
    invWht4(TMP, x, 4)

  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++)
      dst[dstOff + y * stride + x] = clipPixel(dst[dstOff + y * stride + x] + TMP[y * 4 + x], max)
}

/**
 * Inverse-transform the dequantized coefficients `cf` (packed column-major,
 * stride min(h, 32)) and add the residual into an 8-bit pixel plane.
 * Zeroes the consumed region of `cf` (same contract as dav1d).
 */
export function itxfmAdd(
  dst: PixelPlane,
  dstOff: number,
  stride: number,
  cf: Int32Array,
  tx: number,
  txtp: number,
  eob: number,
  bitDepth = 8,
): void {
  const max = bitDepthMax(bitDepth)
  if (txtp === TxfmType.WHT_WHT) {
    invTxfmAddWht4x4(dst, dstOff, stride, cf, max)
    return
  }

  const tDim = TXFM_INFO[tx]
  const w = 4 * tDim.w
  const h = 4 * tDim.h
  const shift = SHIFT[tx]
  const hasDconly = txtp === TxfmType.DCT_DCT ? 1 : 0
  const isRect2 = w * 2 === h || h * 2 === w
  const rnd = (1 << shift) >> 1

  if (eob < hasDconly) {
    let dc = cf[0]
    cf[0] = 0
    if (isRect2)
      dc = (dc * 181 + 128) >> 8
    dc = (dc * 181 + 128) >> 8
    dc = (dc + rnd) >> shift
    dc = (dc * 181 + 128 + 2048) >> 12
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        dst[dstOff + y * stride + x] = clipPixel(dst[dstOff + y * stride + x] + dc, max)
    return
  }

  const firstType = TX1D_TYPES[txtp * 2]
  const secondType = TX1D_TYPES[txtp * 2 + 1]
  const first1dFn = TX1D_FNS[tDim.lw][firstType]
  const second1dFn = TX1D_FNS[tDim.lh][secondType]
  if (!first1dFn || !second1dFn)
    throw new Error(`itxfmAdd: no 1D transform for tx=${tx} txtp=${txtp}`)
  const sh = Math.min(h, 32)
  const sw = Math.min(w, 32)
  const rowClipMin = bitDepth === 8 ? -32768 : (~max) << 7
  const rowClipMax = ~rowClipMin
  const colClipMin = bitDepth === 8 ? -32768 : (~max) << 5
  const colClipMax = ~colClipMin

  let lastNonzeroCol: number
  if (secondType === IDENTITY && firstType !== IDENTITY)
    lastNonzeroCol = Math.min(sh - 1, eob)
  else if (firstType === IDENTITY && secondType !== IDENTITY)
    lastNonzeroCol = eob >> (tDim.lw + 2)
  else
    lastNonzeroCol = LAST_NONZERO_COL_FROM_EOB[tx][eob]

  let c = 0
  for (let y = 0; y <= lastNonzeroCol; y++, c += w) {
    if (isRect2) {
      for (let x = 0; x < sw; x++)
        TMP[c + x] = (cf[y + x * sh] * 181 + 128) >> 8
    }
    else {
      for (let x = 0; x < sw; x++)
        TMP[c + x] = cf[y + x * sh]
    }
    first1dFn(TMP, c, 1, rowClipMin, rowClipMax)
  }
  if (lastNonzeroCol + 1 < sh)
    TMP.fill(0, c, sh * w)

  cf.fill(0, 0, sw * sh)
  for (let i = 0; i < w * sh; i++)
    TMP[i] = iclip((TMP[i] + rnd) >> shift, colClipMin, colClipMax)

  for (let x = 0; x < w; x++)
    second1dFn(TMP, x, w, colClipMin, colClipMax)

  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      dst[dstOff + y * stride + x] = clipPixel(dst[dstOff + y * stride + x] + ((TMP[y * w + x] + 8) >> 4), max)
}

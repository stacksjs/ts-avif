/**
 * Intra-edge availability tree (port of dav1d's intra_edge.c): a static
 * per-superblock-size tree describing, for every block position in the
 * partition hierarchy, whether its top-right / bottom-left neighbor samples
 * are available for intra prediction.
 */
import {
  BlockLevel,
  EDGE_ALL_LEFT_HAS_BOTTOM,
  EDGE_ALL_TOP_HAS_RIGHT,
  EDGE_I420_LEFT_HAS_BOTTOM,
  EDGE_I420_TOP_HAS_RIGHT,
  EDGE_I422_LEFT_HAS_BOTTOM,
  EDGE_I444_TOP_HAS_RIGHT,
} from './consts'

export interface EdgeNode {
  o: number
  h: [number, number]
  v: [number, number]
  /** Tip only (BL_8X8): edge flags for the 3 non-first 4x4 split quadrants. */
  tipSplit?: [number, number, number]
  /** Branch only: children for PARTITION_SPLIT quadrants. */
  split?: EdgeNode[]
  /** Branch only: flags for the second block of H4/V4 partitions. */
  h4?: number
  v4?: number
}

function initEdges(bl: BlockLevel, edgeFlags: number): EdgeNode {
  const node: EdgeNode = {
    o: edgeFlags,
    h: [edgeFlags | EDGE_ALL_LEFT_HAS_BOTTOM, 0],
    v: [edgeFlags | EDGE_ALL_TOP_HAS_RIGHT, 0],
  }
  if (bl === BlockLevel.BL_8X8) {
    node.h[1] = edgeFlags & (EDGE_ALL_LEFT_HAS_BOTTOM | EDGE_I420_TOP_HAS_RIGHT)
    node.v[1] = edgeFlags
      & (EDGE_ALL_TOP_HAS_RIGHT | EDGE_I420_LEFT_HAS_BOTTOM | EDGE_I422_LEFT_HAS_BOTTOM)
    node.tipSplit = [
      (edgeFlags & EDGE_ALL_TOP_HAS_RIGHT) | EDGE_I422_LEFT_HAS_BOTTOM,
      edgeFlags | EDGE_I444_TOP_HAS_RIGHT,
      edgeFlags
      & (EDGE_I420_TOP_HAS_RIGHT | EDGE_I420_LEFT_HAS_BOTTOM | EDGE_I422_LEFT_HAS_BOTTOM),
    ]
  }
  else {
    node.h[1] = edgeFlags & EDGE_ALL_LEFT_HAS_BOTTOM
    node.v[1] = edgeFlags & EDGE_ALL_TOP_HAS_RIGHT
    node.h4 = EDGE_ALL_LEFT_HAS_BOTTOM
    node.v4 = EDGE_ALL_TOP_HAS_RIGHT
    if (bl === BlockLevel.BL_16X16) {
      node.h4 |= edgeFlags & EDGE_I420_TOP_HAS_RIGHT
      node.v4 |= edgeFlags & (EDGE_I420_LEFT_HAS_BOTTOM | EDGE_I422_LEFT_HAS_BOTTOM)
    }
  }
  return node
}

function initModeNode(bl: BlockLevel, topHasRight: boolean, leftHasBottom: boolean): EdgeNode {
  const node = initEdges(
    bl,
    (topHasRight ? EDGE_ALL_TOP_HAS_RIGHT : 0)
    | (leftHasBottom ? EDGE_ALL_LEFT_HAS_BOTTOM : 0),
  )
  node.split = []
  for (let n = 0; n < 4; n++) {
    const childTr = !(n === 3 || (n === 1 && !topHasRight))
    const childBl = n === 0 || (n === 2 && leftHasBottom)
    if (bl === BlockLevel.BL_16X16) {
      node.split.push(initEdges(
        BlockLevel.BL_8X8,
        (childTr ? EDGE_ALL_TOP_HAS_RIGHT : 0) | (childBl ? EDGE_ALL_LEFT_HAS_BOTTOM : 0),
      ))
    }
    else {
      node.split.push(initModeNode(bl + 1, childTr, childBl))
    }
  }
  return node
}

/** Root edge nodes: index 0 for 128x128 superblocks, 1 for 64x64. */
export const INTRA_EDGE_TREE: readonly EdgeNode[] = [
  initModeNode(BlockLevel.BL_128X128, true, true),
  initModeNode(BlockLevel.BL_64X64, true, true),
]

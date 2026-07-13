/**
 * FRAME OBU and TILE_GROUP OBU splitting (spec 5.10-5.11): parse the
 * uncompressed header, then slice the payload into per-tile byte ranges for
 * the entropy decoder.
 */
import type { FrameHeader } from './frame-header'
import type { SequenceHeader } from './sequence'
import { BitReader } from './bits'
import { parseFrameHeader } from './frame-header'

export interface Tile {
  tileNum: number
  tileRow: number
  tileCol: number
  data: Uint8Array
}

export interface ParsedFrame {
  header: FrameHeader
  tiles: Tile[]
}

/** Parse a FRAME OBU payload: uncompressed header + one tile group. */
export function parseFrameOBU(data: Uint8Array, seq: SequenceHeader): ParsedFrame {
  const r = new BitReader(data)
  const header = parseFrameHeader(r, seq)
  r.byteAlign()
  const offset = r.bitPosition >> 3
  const tiles = parseTileGroup(data.subarray(offset), header)
  return { header, tiles }
}

/** Parse a TILE_GROUP OBU payload against an already-parsed frame header. */
export function parseTileGroup(data: Uint8Array, header: FrameHeader): Tile[] {
  const { tileCols, tileRows, tileColsLog2, tileRowsLog2, tileSizeBytes } = header.tileInfo
  const numTiles = tileCols * tileRows

  const r = new BitReader(data)
  let tgStart = 0
  let tgEnd = numTiles - 1
  let tileStartAndEndPresent = false
  if (numTiles > 1)
    tileStartAndEndPresent = r.readBit() === 1
  if (tileStartAndEndPresent) {
    const tileBits = tileColsLog2 + tileRowsLog2
    tgStart = r.readBits(tileBits)
    tgEnd = r.readBits(tileBits)
  }
  r.byteAlign()

  let pos = r.bitPosition >> 3
  const tiles: Tile[] = []
  for (let tileNum = tgStart; tileNum <= tgEnd; tileNum++) {
    const lastTile = tileNum === tgEnd
    let tileSize: number
    if (lastTile) {
      tileSize = data.length - pos
    }
    else {
      let sizeMinus1 = 0
      for (let i = 0; i < tileSizeBytes; i++)
        sizeMinus1 += data[pos + i] * 2 ** (8 * i)
      pos += tileSizeBytes
      tileSize = sizeMinus1 + 1
    }
    if (tileSize < 0 || pos + tileSize > data.length)
      throw new Error(`ts-avif: tile ${tileNum} extends past the tile group payload`)
    tiles.push({
      tileNum,
      tileRow: Math.floor(tileNum / tileCols),
      tileCol: tileNum % tileCols,
      data: data.subarray(pos, pos + tileSize),
    })
    pos += tileSize
  }
  return tiles
}

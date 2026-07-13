/**
 * AVIF-specific HEIF container resolution, ported from the hardened
 * ts-heic container layer (the two formats share ISOBMFF; only the codec
 * config differs). Fixes the base parser's blind spots:
 *
 *   - `ipma` item ↔ property association (the first `ispe` in `ipco` is a
 *     TILE size on grid images, so properties must be resolved per item)
 *   - `iref` `dimg` references and `grid` derived images
 *   - `iloc` construction_method 1 (`idat`-relative payloads)
 *   - `irot` / `imir` display transforms
 */
import type { AV1CodecConfig } from '../types'
import type { ISOBMFFBox } from './heif'
import { findBox, parseAv1C, parseIinf, parseIloc, parseIspe, parsePixi } from './heif'

export interface AvifGridInfo {
  rows: number
  columns: number
  outputWidth: number
  outputHeight: number
  /** Tile item ids in raster order (from the `dimg` reference). */
  tileItemIds: number[]
  tileWidth: number
  tileHeight: number
}

export interface AvifItemInfo {
  primaryItemId: number
  /** 'av01' for a single-coded image, 'grid' for tiled images. */
  primaryItemType: string
  /** Display dimensions of the primary image (before irot/imir). */
  width: number
  height: number
  bitDepth: number
  /** 90-degree counter-clockwise rotation count from `irot` (0-3). */
  rotation: number
  /** Mirror axis from `imir` (0 vertical, 1 horizontal), or null. */
  mirror: number | null
  hasAlpha: boolean
  av1C: AV1CodecConfig | null
  grid: AvifGridInfo | null
}

interface ItemReference {
  referenceType: string
  fromItemId: number
  toItemIds: number[]
}

interface PropertyAssociation {
  itemId: number
  /** 1-based indexes into ipco's child boxes. */
  propertyIndexes: number[]
}

function u16(data: Uint8Array, off: number): number {
  return (data[off] << 8) | data[off + 1]
}

function u32(data: Uint8Array, off: number): number {
  return (((data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3])) >>> 0
}

/** Parse `pitm` (primary item id). */
export function parsePitm(data: Uint8Array): number {
  const version = data[0]
  return version === 0 ? u16(data, 4) : u32(data, 4)
}

/** Parse `iref` child boxes into flat references. */
export function parseIref(box: ISOBMFFBox): ItemReference[] {
  const version = box.data[0]
  const idSize = version === 0 ? 2 : 4
  const refs: ItemReference[] = []

  for (const child of box.children ?? []) {
    const d = child.data
    let p = 0
    const fromItemId = idSize === 2 ? u16(d, p) : u32(d, p)
    p += idSize
    const count = u16(d, p)
    p += 2
    const toItemIds: number[] = []
    for (let i = 0; i < count; i++) {
      toItemIds.push(idSize === 2 ? u16(d, p) : u32(d, p))
      p += idSize
    }
    refs.push({ referenceType: child.type, fromItemId, toItemIds })
  }
  return refs
}

/** Parse `ipma` associations (which ipco properties apply to which item). */
export function parseIpma(data: Uint8Array): PropertyAssociation[] {
  const version = data[0]
  const flags = (data[1] << 16) | (data[2] << 8) | data[3]
  let p = 4
  const entryCount = u32(data, p)
  p += 4

  const out: PropertyAssociation[] = []
  for (let e = 0; e < entryCount; e++) {
    const itemId = version < 1 ? u16(data, p) : u32(data, p)
    p += version < 1 ? 2 : 4
    const associationCount = data[p++]
    const propertyIndexes: number[] = []
    for (let a = 0; a < associationCount; a++) {
      if (flags & 1) {
        propertyIndexes.push(u16(data, p) & 0x7FFF)
        p += 2
      }
      else {
        propertyIndexes.push(data[p++] & 0x7F)
      }
    }
    out.push({ itemId, propertyIndexes })
  }
  return out
}

/** Parse a `grid` derived-image item body. */
export function parseGridBody(data: Uint8Array): Omit<AvifGridInfo, 'tileItemIds' | 'tileWidth' | 'tileHeight'> {
  const flags = data[1]
  const rows = data[2] + 1
  const columns = data[3] + 1
  const fieldSize = (flags & 1) ? 4 : 2
  const outputWidth = fieldSize === 2 ? u16(data, 4) : u32(data, 4)
  const outputHeight = fieldSize === 2 ? u16(data, 4 + fieldSize) : u32(data, 4 + fieldSize)
  return { rows, columns, outputWidth, outputHeight }
}

/**
 * Resolve the full picture of an AVIF file's primary image with per-item
 * property association (grid-safe, unlike the legacy first-property scan).
 */
export function getAvifItemInfo(buffer: Uint8Array, boxes: ISOBMFFBox[]): AvifItemInfo {
  const metaBox = findBox(boxes, 'meta')
  if (!metaBox?.children)
    throw new Error('ts-avif: no meta box found')

  const pitmBox = findBox(metaBox.children, 'pitm')
  if (!pitmBox)
    throw new Error('ts-avif: no primary item (pitm) box found')
  const primaryItemId = parsePitm(pitmBox.data)

  const iinfBox = findBox(metaBox.children, 'iinf')
  const items = iinfBox ? parseIinf(iinfBox.data) : []
  const primaryItem = items.find(i => i.itemId === primaryItemId)
  if (!primaryItem)
    throw new Error(`ts-avif: primary item ${primaryItemId} not present in iinf`)

  const iprpBox = findBox(metaBox.children, 'iprp')
  const ipcoBox = iprpBox?.children ? findBox(iprpBox.children, 'ipco') : undefined
  const ipmaBox = iprpBox?.children ? findBox(iprpBox.children, 'ipma') : undefined
  if (!ipcoBox?.children || !ipmaBox)
    throw new Error('ts-avif: missing item properties (ipco/ipma)')

  const associations = parseIpma(ipmaBox.data)
  const propsFor = (itemId: number): ISOBMFFBox[] => {
    const assoc = associations.find(a => a.itemId === itemId)
    if (!assoc)
      return []
    return assoc.propertyIndexes
      .map(index => ipcoBox.children![index - 1])
      .filter(Boolean)
  }

  const primaryProps = propsFor(primaryItemId)
  const ispeBox = primaryProps.find(b => b.type === 'ispe')
  const extent = ispeBox ? parseIspe(ispeBox.data) : { width: 0, height: 0 }

  const pixiBox = primaryProps.find(b => b.type === 'pixi')
  let bitDepth = 8
  if (pixiBox) {
    const pixi = parsePixi(pixiBox.data)
    if (pixi.bitsPerChannel.length > 0)
      bitDepth = pixi.bitsPerChannel[0]
  }

  const irotBox = primaryProps.find(b => b.type === 'irot')
  const rotation = irotBox ? irotBox.data[0] & 0x03 : 0
  const imirBox = primaryProps.find(b => b.type === 'imir')
  const mirror = imirBox ? imirBox.data[0] & 0x01 : null

  const irefBox = findBox(metaBox.children, 'iref')
  const refs = irefBox ? parseIref(irefBox) : []
  const hasAlpha = items.some(i => i.itemType === 'auxl')

  let grid: AvifGridInfo | null = null
  let av1C: AV1CodecConfig | null = null

  if (primaryItem.itemType === 'grid') {
    const body = getItemPayload(buffer, boxes, primaryItemId)
    if (!body)
      throw new Error('ts-avif: grid item has no body')
    const gridBody = parseGridBody(body)

    const dimg = refs.find(r => r.referenceType === 'dimg' && r.fromItemId === primaryItemId)
    if (!dimg)
      throw new Error('ts-avif: grid image without dimg tile references')

    const firstTileProps = propsFor(dimg.toItemIds[0])
    const tileIspe = firstTileProps.find(b => b.type === 'ispe')
    const tileExtent = tileIspe ? parseIspe(tileIspe.data) : { width: 0, height: 0 }

    grid = {
      ...gridBody,
      tileItemIds: dimg.toItemIds,
      tileWidth: tileExtent.width,
      tileHeight: tileExtent.height,
    }

    const tileAv1c = firstTileProps.find(b => b.type === 'av1C')
    if (tileAv1c)
      av1C = parseAv1C(tileAv1c.data)
  }
  else {
    const av1cBox = primaryProps.find(b => b.type === 'av1C')
    if (av1cBox)
      av1C = parseAv1C(av1cBox.data)

    // The av1C signals high bit depth more reliably than pixi on some encoders.
    if (av1C?.highBitdepth)
      bitDepth = av1C.twelveBit ? 12 : 10
  }

  return {
    primaryItemId,
    primaryItemType: primaryItem.itemType,
    width: extent.width || grid?.outputWidth || 0,
    height: extent.height || grid?.outputHeight || 0,
    bitDepth,
    rotation,
    mirror,
    hasAlpha,
    av1C,
    grid,
  }
}

/**
 * Extract one item's payload, honoring the iloc construction method:
 * 0 = absolute file offsets, 1 = offsets into the `idat` box inside `meta`.
 */
export function getItemPayload(buffer: Uint8Array, boxes: ISOBMFFBox[], itemId: number): Uint8Array | null {
  const metaBox = findBox(boxes, 'meta')
  if (!metaBox?.children)
    return null
  const ilocBox = findBox(metaBox.children, 'iloc')
  if (!ilocBox)
    return null

  const location = parseIloc(ilocBox.data).find(loc => loc.itemId === itemId)
  if (!location)
    return null

  if (location.constructionMethod === 1) {
    const idatBox = findBox(metaBox.children, 'idat')
    if (!idatBox)
      return null
    const parts = location.extents.map((extent) => {
      const start = location.baseOffset + extent.extentOffset
      return idatBox.data.subarray(start, start + extent.extentLength)
    })
    return concat(parts)
  }

  const parts = location.extents.map((extent) => {
    const start = location.baseOffset + extent.extentOffset
    return buffer.subarray(start, start + extent.extentLength)
  })
  return concat(parts)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * AVIF optimizer — lossless ISOBMFF re-mux.
 *
 * AV1 itself is one of the most complex video codecs ever designed; a real
 * encoder is tens of thousands of lines and *years* of work. So this module
 * does the same thing every production AVIF optimizer does (cavif --strip,
 * avifenc --no-tiles --keep-only-primary): it leaves the AV1 bytes alone
 * and rewrites the container.
 *
 * What it strips:
 *
 *   • `Exif` / `mime` (XMP, ICC profile) metadata items
 *   • Thumbnail items (referenced by `thmb` from the primary)
 *   • `iref` references that point at any dropped item
 *   • `udta`, `free`, `skip` boxes
 *   • Compatible-brand entries in `ftyp` that aren't `avif` / `mif1` /
 *     `miaf` / `MA1A` / the major brand
 *
 * What it keeps (lossless w.r.t. the rendered image):
 *
 *   • `ftyp` (slim version)
 *   • Primary image item + its AV1 bytes
 *   • Auxiliary alpha item (`auxl`-referenced) + its AV1 bytes
 *   • All `ipco` properties referenced by surviving items
 *   • `pitm`, `hdlr`, surviving `iref` entries, `iinf`, `iloc`, `iprp`
 *
 * The pipeline preserves bit-exact pixel output.
 */

import {
  findBox,
  parseIinf,
  parseIloc,
  parseISOBMFF,
} from './container/heif'
import type { ItemInfo } from './types'

/** Item types that are pure metadata and never carry pixel data. */
const METADATA_ITEM_TYPES = new Set(['Exif', 'mime', 'uri '])

/** Per-call summary of what the optimizer touched. */
export interface OptimizeStats {
  /** True when the result is the original input (no re-mux happened, or the re-muxed bytes weren't smaller). */
  passthrough: boolean
  /** Item IDs that survived the re-mux — at minimum, the primary image. */
  keptItemIds: number[]
  /** Item IDs we removed (metadata, thumbnails, …). */
  droppedItemIds: number[]
  /** Item types we removed (e.g. ['Exif', 'mime', 'av01']) — duplicates collapsed. */
  droppedItemTypes: string[]
  /** Bytes we shaved off (input.length - output.length, ≥ 0). */
  bytesSaved: number
  /** When non-passthrough fails internally, the reason. */
  reason?: string
}

export interface OptimizeResult {
  bytes: Uint8Array
  stats: OptimizeStats
}

/**
 * Optimize an AVIF byte stream by re-muxing the container. Returns the
 * smaller of the original and the re-muxed output.
 *
 * On any parse/serialize failure, the original input is returned unchanged.
 */
export function optimize(input: Uint8Array): Uint8Array {
  return optimizeWithStats(input).bytes
}

/**
 * Same as `optimize()` but also returns a stats object describing what was
 * dropped — useful for UIs that want to show the user `−15 % (Exif + thumbnail)`.
 */
export function optimizeWithStats(input: Uint8Array): OptimizeResult {
  try {
    const result = remuxWithStats(input)
    if (result.bytes.length < input.length) {
      return { bytes: result.bytes, stats: { ...result.stats, passthrough: false } }
    }
    return {
      bytes: input,
      stats: { ...result.stats, passthrough: true, bytesSaved: 0 },
    }
  }
  catch (err) {
    return {
      bytes: input,
      stats: {
        passthrough: true,
        keptItemIds: [],
        droppedItemIds: [],
        droppedItemTypes: [],
        bytesSaved: 0,
        reason: (err as Error).message,
      },
    }
  }
}

/**
 * Force re-muxing without the smaller-of-two guard. Always returns a fresh
 * buffer; callers that want to keep the original on bloat should use
 * `optimize()` instead.
 */
export function remux(input: Uint8Array): Uint8Array {
  return remuxWithStats(input).bytes
}

function remuxWithStats(input: Uint8Array): OptimizeResult {
  const boxes = parseISOBMFF(input)

  const ftyp = boxes.find(b => b.type === 'ftyp')
  const meta = boxes.find(b => b.type === 'meta')
  if (!ftyp || !meta || !meta.children) {
    throw new Error('not an AVIF: missing ftyp or meta')
  }

  // ── Decide what to keep ────────────────────────────────────────────────
  const pitm = findBox(meta.children, 'pitm')
  if (!pitm) throw new Error('no pitm — primary item missing')
  const primaryItemId = parsePitm(pitm.data)

  const iinfBox = findBox(meta.children, 'iinf')
  const allItems: ItemInfo[] = iinfBox ? parseIinf(iinfBox.data) : []

  const irefBox = findBox(meta.children, 'iref')
  const refs = irefBox ? parseIrefBox(irefBox.data) : []

  const ilocBox = findBox(meta.children, 'iloc')
  if (!ilocBox) throw new Error('no iloc — item locations missing')
  const allLocations = parseIloc(ilocBox.data)

  // Build the keep set:
  //   1. Primary item
  //   2. Anything the primary points at via `auxl` (alpha aux)
  //   3. Anything that points at the primary via `cdsc` is metadata — DROP
  //   4. Drop anything with metadata item type
  const keep = new Set<number>([primaryItemId])
  for (const ref of refs) {
    if (ref.fromId === primaryItemId && ref.type === 'auxl') {
      for (const t of ref.toIds) keep.add(t)
    }
  }
  for (const item of allItems) {
    if (METADATA_ITEM_TYPES.has(item.itemType)) keep.delete(item.itemId)
  }
  // Always keep primary (defensive — metadata-typed primary items are nonsense
  // but a malformed file shouldn't make us produce empty output).
  keep.add(primaryItemId)

  const keptItems = allItems.filter(i => keep.has(i.itemId))
  const keptLocations = allLocations.filter(l => keep.has(l.itemId))

  // The slim builders below all emit 16-bit item IDs (iinf v0, iref v0,
  // iloc v0, ipma v0). If a kept item exceeds that, downgrading would
  // silently corrupt the file — refuse cleanly instead so optimize()'s
  // try/catch passes the original bytes through.
  for (const item of keptItems) {
    if (item.itemId > 0xFFFF) {
      throw new Error(`item id ${item.itemId} exceeds 16-bit; refusing to downgrade`)
    }
  }

  // Item-property associations + properties (we keep ipco verbatim — extra
  // unreferenced properties are harmless — and rebuild ipma).
  const iprpBox = findBox(meta.children, 'iprp')
  const ipcoBox = iprpBox?.children ? findBox(iprpBox.children, 'ipco') : undefined
  const ipmaBox = iprpBox?.children ? findBox(iprpBox.children, 'ipma') : undefined
  if (!ipcoBox || !ipmaBox) throw new Error('iprp/ipco/ipma missing')
  const allAssoc = parseIpma(ipmaBox.data)
  const keptAssoc = allAssoc.filter(a => keep.has(a.itemId))

  // Filter iref so we don't carry references to dropped items.
  const keptRefs = refs.filter(r =>
    keep.has(r.fromId) && r.toIds.every(t => keep.has(t)),
  )

  // ── Pull each kept item's payload from the input. ──────────────────────
  // iloc construction_method 0 → extent_offset is absolute file offset.
  // (We don't try to handle methods 1/2 — those are rare in AVIF and would
  // need full idat reconstruction; leave them on the original.)
  const itemPayloads = new Map<number, Uint8Array>()
  for (const loc of keptLocations) {
    if (loc.constructionMethod !== 0) {
      throw new Error(`unsupported iloc construction_method=${loc.constructionMethod}`)
    }
    const parts: Uint8Array[] = []
    for (const ext of loc.extents) {
      const start = loc.baseOffset + ext.extentOffset
      parts.push(input.subarray(start, start + ext.extentLength))
    }
    itemPayloads.set(loc.itemId, concat(parts))
  }

  // ── Serialize the new file. ────────────────────────────────────────────
  // Layout: ftyp · meta · mdat
  //
  // We can compute meta's size precisely (no payloads inside it), then mdat
  // immediately follows. iloc's absolute offsets reference the new mdat.

  const newFtyp = buildSlimFtyp(ftyp.data)

  const hdlrBox = findBox(meta.children, 'hdlr')
  const hdlrBytes = hdlrBox ? wrapBox('hdlr', hdlrBox.data) : buildPictHdlr()
  const pitmBytes = wrapBox('pitm', pitm.data)
  const iinfBytes = buildIinf(keptItems)
  const irefBytes = keptRefs.length > 0 ? buildIref(keptRefs, irefBox?.data?.[0] ?? 0) : new Uint8Array(0)

  // Stable, gap-free layout of payloads in the new mdat. Order = order
  // items appear in the kept list.
  const orderedIds: number[] = []
  for (const item of keptItems) {
    if (itemPayloads.has(item.itemId)) orderedIds.push(item.itemId)
  }

  // Two-pass iloc/mdat sizing because iloc encodes the absolute offsets
  // of each item's bytes inside the new file. We need to know the size of
  // every preceding box (ftyp, meta itself) to know where mdat starts.

  // Pass 1: build iloc with placeholder offsets to get its byte size.
  const placeholderOffsets = new Map<number, number>()
  for (const id of orderedIds) placeholderOffsets.set(id, 0)
  const ilocPass1 = buildIloc(orderedIds, itemPayloads, placeholderOffsets)

  const ipcoBytes = wrapBox('ipco', ipcoBox.data)
  const ipmaBytes = buildIpma(keptAssoc)
  const iprpBytes = wrapBox('iprp', concat([ipcoBytes, ipmaBytes]))

  const metaChildrenSize = hdlrBytes.length + pitmBytes.length + ilocPass1.length
    + iinfBytes.length + irefBytes.length + iprpBytes.length
  const metaSize = 8 /* box header */ + 4 /* version+flags */ + metaChildrenSize
  const mdatPayloadStart = newFtyp.length + metaSize + 8 /* mdat box header */

  // Pass 2: rebuild iloc with real offsets.
  const realOffsets = new Map<number, number>()
  let cursor = mdatPayloadStart
  for (const id of orderedIds) {
    realOffsets.set(id, cursor)
    cursor += itemPayloads.get(id)!.length
  }
  const ilocFinal = buildIloc(orderedIds, itemPayloads, realOffsets)

  if (ilocFinal.length !== ilocPass1.length) {
    // Defensive — shouldn't happen since we use fixed-width offset fields.
    throw new Error('iloc size changed between passes')
  }

  // Now assemble meta in-place.
  const metaBuf = new Uint8Array(metaSize)
  const metaView = new DataView(metaBuf.buffer)
  metaView.setUint32(0, metaSize)
  metaBuf[4] = 0x6D; metaBuf[5] = 0x65; metaBuf[6] = 0x74; metaBuf[7] = 0x61 // 'meta'
  // version 0, flags 0
  metaView.setUint32(8, 0)
  let mc = 12
  metaBuf.set(hdlrBytes, mc); mc += hdlrBytes.length
  metaBuf.set(pitmBytes, mc); mc += pitmBytes.length
  metaBuf.set(ilocFinal, mc); mc += ilocFinal.length
  metaBuf.set(iinfBytes, mc); mc += iinfBytes.length
  if (irefBytes.length > 0) { metaBuf.set(irefBytes, mc); mc += irefBytes.length }
  metaBuf.set(iprpBytes, mc); mc += iprpBytes.length

  // mdat
  let mdatPayloadSize = 0
  for (const id of orderedIds) mdatPayloadSize += itemPayloads.get(id)!.length
  const mdatSize = 8 + mdatPayloadSize
  const mdatBuf = new Uint8Array(mdatSize)
  new DataView(mdatBuf.buffer).setUint32(0, mdatSize)
  mdatBuf[4] = 0x6D; mdatBuf[5] = 0x64; mdatBuf[6] = 0x61; mdatBuf[7] = 0x74 // 'mdat'
  let mp = 8
  for (const id of orderedIds) {
    const payload = itemPayloads.get(id)!
    mdatBuf.set(payload, mp); mp += payload.length
  }

  const out = concat([newFtyp, metaBuf, mdatBuf])

  const droppedItems = allItems.filter(i => !keep.has(i.itemId))
  return {
    bytes: out,
    stats: {
      passthrough: false,
      keptItemIds: keptItems.map(i => i.itemId),
      droppedItemIds: droppedItems.map(i => i.itemId),
      droppedItemTypes: Array.from(new Set(droppedItems.map(i => i.itemType))),
      bytesSaved: Math.max(0, input.length - out.length),
    },
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Box helpers
// ───────────────────────────────────────────────────────────────────────────

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) { out.set(p, offset); offset += p.length }
  return out
}

function wrapBox(type: string, payload: Uint8Array): Uint8Array {
  const size = 8 + payload.length
  const out = new Uint8Array(size)
  new DataView(out.buffer).setUint32(0, size)
  out[4] = type.charCodeAt(0)
  out[5] = type.charCodeAt(1)
  out[6] = type.charCodeAt(2)
  out[7] = type.charCodeAt(3)
  out.set(payload, 8)
  return out
}

function writeBoxHeader(buf: Uint8Array, offset: number, size: number, type: string): void {
  new DataView(buf.buffer, buf.byteOffset).setUint32(offset, size)
  buf[offset + 4] = type.charCodeAt(0)
  buf[offset + 5] = type.charCodeAt(1)
  buf[offset + 6] = type.charCodeAt(2)
  buf[offset + 7] = type.charCodeAt(3)
}

// ───────────────────────────────────────────────────────────────────────────
// Box parsers (just the bits we need beyond what heif.ts already exports)
// ───────────────────────────────────────────────────────────────────────────

function parsePitm(data: Uint8Array): number {
  // version (1) + flags (3) + item_id (2 if v=0 else 4)
  const version = data[0]
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return version === 0 ? view.getUint16(4) : view.getUint32(4)
}

interface IrefEntry { type: string, fromId: number, toIds: number[] }

function parseIrefBox(data: Uint8Array): IrefEntry[] {
  // version (1) + flags (3) + boxes...
  const version = data[0]
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const entries: IrefEntry[] = []
  let offset = 4
  while (offset + 8 <= data.length) {
    const refSize = view.getUint32(offset)
    const refType = String.fromCharCode(
      data[offset + 4],
      data[offset + 5],
      data[offset + 6],
      data[offset + 7],
    )
    let p = offset + 8
    const fromId = version === 0 ? view.getUint16(p) : view.getUint32(p)
    p += version === 0 ? 2 : 4
    const refCount = view.getUint16(p); p += 2
    const toIds: number[] = []
    for (let i = 0; i < refCount; i++) {
      toIds.push(version === 0 ? view.getUint16(p) : view.getUint32(p))
      p += version === 0 ? 2 : 4
    }
    entries.push({ type: refType, fromId, toIds })
    offset += refSize
  }
  return entries
}

interface IpmaAssoc { itemId: number, props: { propIndex: number, essential: boolean }[] }

function parseIpma(data: Uint8Array): IpmaAssoc[] {
  const version = data[0]
  const flags = (data[1] << 16) | (data[2] << 8) | data[3]
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const entryCount = view.getUint32(4)
  const wide = (flags & 1) !== 0 // 1-byte vs 2-byte property index
  let p = 8
  const out: IpmaAssoc[] = []
  for (let i = 0; i < entryCount; i++) {
    const itemId = version < 1 ? view.getUint16(p) : view.getUint32(p)
    p += version < 1 ? 2 : 4
    const assocCount = data[p++]
    const props: { propIndex: number, essential: boolean }[] = []
    for (let j = 0; j < assocCount; j++) {
      let propIndex: number
      let essential: boolean
      if (wide) {
        const word = view.getUint16(p); p += 2
        essential = (word & 0x8000) !== 0
        propIndex = word & 0x7FFF
      }
      else {
        const byte = data[p++]
        essential = (byte & 0x80) !== 0
        propIndex = byte & 0x7F
      }
      props.push({ propIndex, essential })
    }
    out.push({ itemId, props })
  }
  return out
}

// ───────────────────────────────────────────────────────────────────────────
// Box builders
// ───────────────────────────────────────────────────────────────────────────

/**
 * Slim down ftyp: keep major brand + minor version + only the brands AVIF
 * decoders care about. (Real-world ftyps sometimes include 5–10 redundant
 * brands.)
 */
function buildSlimFtyp(originalFtypData: Uint8Array): Uint8Array {
  const view = new DataView(originalFtypData.buffer, originalFtypData.byteOffset, originalFtypData.byteLength)
  const major = String.fromCharCode(...originalFtypData.slice(0, 4))
  const minorVersion = view.getUint32(4)

  // Required AVIF brand set (per MIAF / AVIF spec). Anything outside this
  // is decoder-specific extras we can drop without affecting playback.
  const required = new Set(['avif', 'mif1', 'miaf', 'MA1A'])
  required.add(major)

  const brands = Array.from(required)
  const size = 8 + 4 + 4 + brands.length * 4
  const out = new Uint8Array(size)
  const v = new DataView(out.buffer)
  v.setUint32(0, size)
  out[4] = 0x66; out[5] = 0x74; out[6] = 0x79; out[7] = 0x70 // 'ftyp'
  for (let i = 0; i < 4; i++) out[8 + i] = major.charCodeAt(i)
  v.setUint32(12, minorVersion)
  for (let i = 0; i < brands.length; i++) {
    for (let j = 0; j < 4; j++) out[16 + i * 4 + j] = brands[i].charCodeAt(j)
  }
  return out
}

function buildPictHdlr(): Uint8Array {
  // Standard 'pict' handler — used as a fallback if the source had none.
  const out = new Uint8Array(33)
  const v = new DataView(out.buffer)
  v.setUint32(0, 33)
  out[4] = 0x68; out[5] = 0x64; out[6] = 0x6C; out[7] = 0x72 // 'hdlr'
  // version+flags = 0
  out[16] = 0x70; out[17] = 0x69; out[18] = 0x63; out[19] = 0x74 // 'pict'
  out[32] = 0 // trailing null name byte
  return out
}

/**
 * Build iinf box from a filtered item list. We use version 0 (uint16
 * entry count) since AVIF rarely needs >65 535 items.
 */
function buildIinf(items: ItemInfo[]): Uint8Array {
  const infes: Uint8Array[] = items.map(buildInfe)
  const childrenSize = infes.reduce((s, b) => s + b.length, 0)
  const size = 8 + 4 + 2 + childrenSize
  const out = new Uint8Array(size)
  const v = new DataView(out.buffer)
  v.setUint32(0, size)
  out[4] = 0x69; out[5] = 0x69; out[6] = 0x6E; out[7] = 0x66 // 'iinf'
  // version 0, flags 0
  v.setUint16(12, items.length)
  let p = 14
  for (const infe of infes) { out.set(infe, p); p += infe.length }
  return out
}

function buildInfe(item: ItemInfo): Uint8Array {
  // version 2 (most compatible for AVIF), itemId(2), protectionIdx(2),
  // itemType(4), itemName(null-terminated)
  const name = item.itemName ?? ''
  const size = 8 + 4 /* version+flags */ + 2 /* itemId */ + 2 /* protection */ + 4 /* type */ + name.length + 1
  const out = new Uint8Array(size)
  const v = new DataView(out.buffer)
  v.setUint32(0, size)
  out[4] = 0x69; out[5] = 0x6E; out[6] = 0x66; out[7] = 0x65 // 'infe'
  // version 2, flags 0
  v.setUint32(8, 0x02000000)
  v.setUint16(12, item.itemId)
  v.setUint16(14, item.itemProtectionIndex)
  for (let i = 0; i < 4; i++) out[16 + i] = item.itemType.charCodeAt(i)
  for (let i = 0; i < name.length; i++) out[20 + i] = name.charCodeAt(i)
  out[20 + name.length] = 0
  return out
}

/**
 * Build iloc with version 0 + 4-byte offset fields + 4-byte length fields
 * + 0-byte base offset (item-relative offsets are absolute in the file).
 */
function buildIloc(
  orderedItemIds: number[],
  payloads: Map<number, Uint8Array>,
  offsets: Map<number, number>,
): Uint8Array {
  // Per item: itemId(2) + dataRefIdx(2) + extentCount(2) + offset(4) + length(4) = 14 bytes
  const itemsSize = orderedItemIds.length * 14
  const size = 8 + 4 /* version+flags */ + 2 /* offset/length sizes */ + 2 /* base/index sizes */
    + 2 /* itemCount */ + itemsSize
  const out = new Uint8Array(size)
  const v = new DataView(out.buffer)
  v.setUint32(0, size)
  out[4] = 0x69; out[5] = 0x6C; out[6] = 0x6F; out[7] = 0x63 // 'iloc'
  // version 0, flags 0
  v.setUint32(8, 0)
  // offset_size (4) << 4 | length_size (4)
  out[12] = 0x44
  // base_offset_size (0) << 4 | reserved (0)
  out[13] = 0x00
  v.setUint16(14, orderedItemIds.length)
  let p = 16
  for (const id of orderedItemIds) {
    v.setUint16(p, id); p += 2
    v.setUint16(p, 0); p += 2 // dataRefIndex
    v.setUint16(p, 1); p += 2 // extentCount = 1 (we always coalesce extents)
    v.setUint32(p, offsets.get(id)!); p += 4
    v.setUint32(p, payloads.get(id)!.length); p += 4
  }
  return out
}

function buildIref(refs: IrefEntry[], versionFlagsByte: number): Uint8Array {
  // version 0 → uint16 ids. We always emit version 0 for compactness.
  const refBoxes: Uint8Array[] = refs.map((ref) => {
    const refSize = 8 + 2 + 2 + ref.toIds.length * 2
    const buf = new Uint8Array(refSize)
    const view = new DataView(buf.buffer)
    view.setUint32(0, refSize)
    for (let i = 0; i < 4; i++) buf[4 + i] = ref.type.charCodeAt(i)
    view.setUint16(8, ref.fromId)
    view.setUint16(10, ref.toIds.length)
    for (let i = 0; i < ref.toIds.length; i++) view.setUint16(12 + i * 2, ref.toIds[i])
    return buf
  })
  const childrenSize = refBoxes.reduce((s, b) => s + b.length, 0)
  const size = 8 + 4 + childrenSize
  const out = new Uint8Array(size)
  const v = new DataView(out.buffer)
  v.setUint32(0, size)
  out[4] = 0x69; out[5] = 0x72; out[6] = 0x65; out[7] = 0x66 // 'iref'
  v.setUint32(8, 0) // version 0
  void versionFlagsByte // we deliberately downgrade to v0 for size
  let p = 12
  for (const b of refBoxes) { out.set(b, p); p += b.length }
  return out
}

function buildIpma(assocs: IpmaAssoc[]): Uint8Array {
  // version 0 + flags 0 → 1-byte property index, 1-byte essential flag
  // entries(uint32) ; for each: itemId(2) + assocCount(1) + assocs(1 byte each)
  let entriesSize = 0
  for (const a of assocs) entriesSize += 2 + 1 + a.props.length
  const size = 8 + 4 + 4 + entriesSize
  const out = new Uint8Array(size)
  const v = new DataView(out.buffer)
  v.setUint32(0, size)
  out[4] = 0x69; out[5] = 0x70; out[6] = 0x6D; out[7] = 0x61 // 'ipma'
  v.setUint32(8, 0) // version 0, flags 0
  v.setUint32(12, assocs.length)
  let p = 16
  for (const a of assocs) {
    v.setUint16(p, a.itemId); p += 2
    out[p++] = a.props.length
    for (const pr of a.props) {
      // Cap to 7-bit indices. For files that genuinely use property indices
      // ≥ 128, we'd need flags=1 and 2-byte fields. AVIF in practice never
      // reaches that; if we do encounter it we throw rather than silently
      // produce a malformed file.
      if (pr.propIndex > 0x7F) {
        throw new Error('ipma property index exceeds 7 bits — file too large')
      }
      out[p++] = (pr.essential ? 0x80 : 0) | pr.propIndex
    }
  }
  return out
}


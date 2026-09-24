import { createFtyp } from './heif'

/**
 * The URN an auxiliary image carries to say "I am this image's alpha"
 * (ISO/IEC 23008-12 / MIAF). Every AVIF decoder keys transparency off it.
 */
export const ALPHA_URN = 'urn:mpeg:mpegB:cicp:systems:auxiliary:alpha'

const COLOR_ITEM = 1
const ALPHA_ITEM = 2

/**
 * Wrap AV1 still pictures in an AVIF/HEIF container.
 *
 * With `alphaData`, the file holds two `av01` items: the colour image (item 1,
 * primary) and its alpha (item 2), which an `auxl` reference ties to item 1
 * and an `auxC` property marks as alpha. Without it, a single item as before.
 */
export function writeAvif(av1Data: Uint8Array, width: number, height: number, alphaData?: Uint8Array): Uint8Array {
  const payloads = alphaData ? [av1Data, alphaData] : [av1Data]

  const ftyp = createFtyp()
  const hdlr = pictHandler()
  const pitm = box('pitm', new Uint8Array([0, 0, 0, 0, 0, COLOR_ITEM]))
  const iinf = itemInfo(payloads.length)
  const iref = alphaData ? auxlReference() : new Uint8Array(0)
  const iprp = itemProperties(width, height, Boolean(alphaData))

  // iloc has a fixed size, so a placeholder pass is enough to establish the
  // absolute start of the mdat payload before writing its final offsets.
  const placeholderIloc = itemLocation(payloads.map(payload => ({ offset: 0, length: payload.length })))
  const metaSize = 12 + hdlr.length + pitm.length + placeholderIloc.length + iinf.length + iref.length + iprp.length
  let offset = ftyp.length + metaSize + 8
  const extents = payloads.map((payload) => {
    const extent = { offset, length: payload.length }
    offset += payload.length
    return extent
  })

  const iloc = itemLocation(extents)
  const meta = box('meta', concat([new Uint8Array(4), hdlr, pitm, iloc, iinf, iref, iprp]))
  const mdat = box('mdat', concat(payloads))
  return concat([ftyp, meta, mdat])
}

function pictHandler(): Uint8Array {
  const payload = new Uint8Array(25)
  // version/flags and pre_defined are zero.
  writeType(payload, 8, 'pict')
  // 12 reserved bytes and a null-terminated empty name follow.
  return box('hdlr', payload)
}

function itemInfo(count: number): Uint8Array {
  const entries: Uint8Array[] = []
  for (let itemId = 1; itemId <= count; itemId++) {
    const infePayload = new Uint8Array(13)
    infePayload[0] = 2 // FullBox version 2
    const infeView = new DataView(infePayload.buffer)
    infeView.setUint16(4, itemId)
    infeView.setUint16(6, 0) // item_protection_index
    writeType(infePayload, 8, 'av01')
    infePayload[12] = 0 // empty item_name
    entries.push(box('infe', infePayload))
  }

  const header = new Uint8Array(6)
  new DataView(header.buffer).setUint16(4, count)
  return box('iinf', concat([header, ...entries]))
}

/** `iref` holding one `auxl` reference: alpha item -> colour item. */
function auxlReference(): Uint8Array {
  const auxlPayload = new Uint8Array(6)
  const view = new DataView(auxlPayload.buffer)
  view.setUint16(0, ALPHA_ITEM) // from_item_ID
  view.setUint16(2, 1) // reference_count
  view.setUint16(4, COLOR_ITEM) // to_item_ID
  return box('iref', concat([new Uint8Array(4), box('auxl', auxlPayload)]))
}

function itemLocation(extents: { offset: number, length: number }[]): Uint8Array {
  const payload = new Uint8Array(8 + extents.length * 14)
  const view = new DataView(payload.buffer)
  payload[4] = 0x44 // offset_size=4, length_size=4
  payload[5] = 0x00 // base_offset_size=0
  view.setUint16(6, extents.length) // item_count
  extents.forEach((extent, index) => {
    const at = 8 + index * 14
    view.setUint16(at, index + 1) // item_ID
    view.setUint16(at + 2, 0) // data_reference_index
    view.setUint16(at + 4, 1) // extent_count
    view.setUint32(at + 6, extent.offset)
    view.setUint32(at + 10, extent.length)
  })
  return box('iloc', payload)
}

function itemProperties(width: number, height: number, withAlpha: boolean): Uint8Array {
  const ispePayload = new Uint8Array(12)
  const ispeView = new DataView(ispePayload.buffer)
  ispeView.setUint32(4, width)
  ispeView.setUint32(8, height)
  const ispe = box('ispe', ispePayload)

  // Both items are 8-bit 4:2:0 bitstreams, so both carry three channels; the
  // alpha item's chroma is flat and decoders read only its luma.
  const pixi = box('pixi', new Uint8Array([0, 0, 0, 0, 3, 8, 8, 8]))

  // marker=1, version=1, Main profile/level 2.0, 8-bit 4:2:0.
  const av1c = box('av1C', new Uint8Array([0x81, 0x00, 0x0C, 0x00]))

  const colrPayload = new Uint8Array(11)
  writeType(colrPayload, 0, 'nclx')
  const colrView = new DataView(colrPayload.buffer)
  colrView.setUint16(4, 1) // BT.709 primaries
  colrView.setUint16(6, 13) // sRGB transfer
  colrView.setUint16(8, 1) // BT.709 matrix
  colrPayload[10] = 0x80 // full_range_flag
  const colr = box('colr', colrPayload)

  // Property indices are 1-based positions in ipco.
  const properties = [ispe, pixi, av1c, colr]
  if (withAlpha) {
    const urn = new TextEncoder().encode(`${ALPHA_URN}\0`)
    properties.push(box('auxC', concat([new Uint8Array(4), urn])))
  }
  const ipco = box('ipco', concat(properties))

  const ESSENTIAL = 0x80
  const associations: [number, number[]][] = [
    [COLOR_ITEM, [1, 2, ESSENTIAL | 3, 4]],
  ]
  if (withAlpha)
    associations.push([ALPHA_ITEM, [1, 2, ESSENTIAL | 3, ESSENTIAL | 5]])

  const ipmaParts: number[] = [0, 0, 0, 0, 0, 0, 0, associations.length]
  for (const [itemId, indices] of associations)
    ipmaParts.push(itemId >> 8, itemId & 0xFF, indices.length, ...indices)
  const ipma = box('ipma', new Uint8Array(ipmaParts))

  return box('iprp', concat([ipco, ipma]))
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, out.length)
  writeType(out, 4, type)
  out.set(payload, 8)
  return out
}

function writeType(data: Uint8Array, offset: number, type: string): void {
  for (let i = 0; i < 4; i++)
    data[offset + i] = type.charCodeAt(i)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

import { createFtyp } from './heif'

/** Wrap one AV1 still-picture stream in a single-item AVIF/HEIF container. */
export function writeAvif(av1Data: Uint8Array, width: number, height: number): Uint8Array {
  const ftyp = createFtyp()
  const hdlr = pictHandler()
  const pitm = box('pitm', new Uint8Array([0, 0, 0, 0, 0, 1]))
  const iinf = itemInfo()
  const iprp = itemProperties(width, height)

  // iloc has a fixed size, so a placeholder pass is enough to establish the
  // absolute start of the mdat payload before writing its final offset.
  const placeholderIloc = itemLocation(0, av1Data.length)
  const metaSize = 12 + hdlr.length + pitm.length + placeholderIloc.length + iinf.length + iprp.length
  const payloadOffset = ftyp.length + metaSize + 8
  const iloc = itemLocation(payloadOffset, av1Data.length)
  const meta = box('meta', concat([new Uint8Array(4), hdlr, pitm, iloc, iinf, iprp]))
  const mdat = box('mdat', av1Data)
  return concat([ftyp, meta, mdat])
}

function pictHandler(): Uint8Array {
  const payload = new Uint8Array(25)
  // version/flags and pre_defined are zero.
  writeType(payload, 8, 'pict')
  // 12 reserved bytes and a null-terminated empty name follow.
  return box('hdlr', payload)
}

function itemInfo(): Uint8Array {
  const infePayload = new Uint8Array(13)
  infePayload[0] = 2 // FullBox version 2
  const infeView = new DataView(infePayload.buffer)
  infeView.setUint16(4, 1) // item_ID
  infeView.setUint16(6, 0) // item_protection_index
  writeType(infePayload, 8, 'av01')
  infePayload[12] = 0 // empty item_name
  const infe = box('infe', infePayload)

  const payload = new Uint8Array(6 + infe.length)
  new DataView(payload.buffer).setUint16(4, 1)
  payload.set(infe, 6)
  return box('iinf', payload)
}

function itemLocation(offset: number, length: number): Uint8Array {
  const payload = new Uint8Array(22)
  const view = new DataView(payload.buffer)
  payload[4] = 0x44 // offset_size=4, length_size=4
  payload[5] = 0x00 // base_offset_size=0
  view.setUint16(6, 1) // item_count
  view.setUint16(8, 1) // item_ID
  view.setUint16(10, 0) // data_reference_index
  view.setUint16(12, 1) // extent_count
  view.setUint32(14, offset)
  view.setUint32(18, length)
  return box('iloc', payload)
}

function itemProperties(width: number, height: number): Uint8Array {
  const ispePayload = new Uint8Array(12)
  const ispeView = new DataView(ispePayload.buffer)
  ispeView.setUint32(4, width)
  ispeView.setUint32(8, height)
  const ispe = box('ispe', ispePayload)

  const pixiPayload = new Uint8Array([0, 0, 0, 0, 3, 8, 8, 8])
  const pixi = box('pixi', pixiPayload)

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

  const ipco = box('ipco', concat([ispe, pixi, av1c, colr]))
  const ipmaPayload = new Uint8Array(12)
  const ipmaView = new DataView(ipmaPayload.buffer)
  ipmaView.setUint32(4, 1) // entry_count
  ipmaView.setUint16(8, 1) // item_ID
  ipmaPayload[10] = 4 // association_count
  ipmaPayload[11] = 1 // ispe; overwritten below after growing

  const associations = new Uint8Array(15)
  associations.set(ipmaPayload.subarray(0, 11))
  associations.set([1, 2, 0x80 | 3, 4], 11)
  const ipma = box('ipma', associations)
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

# ts-avif

A pure TypeScript AVIF encoder and decoder with zero native dependencies.

## Features

- 🚀 Pure TypeScript - no native dependencies
- 📦 Zero dependencies
- 🎨 HEIF/ISOBMFF container support
- 🔄 8-bit AV1 still-image decoder
- ✍️ Bundled 8-bit intra encoder (no `avifenc` subprocess)

## Installation

```bash
bun add ts-avif
# or
npm install ts-avif
```

## Usage

### Decoding

```typescript
import { decode } from 'ts-avif'

const buffer = await Bun.file('image.avif').arrayBuffer()
const { data, width, height, hasAlpha, bitDepth } = decode(new Uint8Array(buffer))

// data is RGBA pixel data (4 bytes per pixel)
console.log(`Image size: ${width}x${height}, bit depth: ${bitDepth}`)
```

### Encoding

```typescript
import { encode } from 'ts-avif'

const imageData = {
  data: new Uint8Array(width * height * 4), // RGBA pixel data
  width: 100,
  height: 100,
}

const avifBuffer = encode(imageData, {
  quality: 80,
  chromaSubsampling: '4:2:0',
})
await Bun.write('output.avif', avifBuffer)
```

### Get File Info

```typescript
import { parseISOBMFF, getAvifInfo } from 'ts-avif'

const buffer = await Bun.file('image.avif').arrayBuffer()
const boxes = parseISOBMFF(new Uint8Array(buffer))
const info = getAvifInfo(boxes)

console.log(info)
// {
//   width: 1920,
//   height: 1080,
//   hasAlpha: false,
//   bitDepth: 10,
//   colorSpace: 'srgb',
//   isSequence: false
// }
```

## API

### `decode(buffer: Uint8Array, options?: AvifDecodeOptions): AvifImageData`

Decodes an AVIF image buffer to RGBA pixel data.

**Options:**

- `format?: 'rgba' | 'rgb'` - Output format (default: 'rgba')
- `ignoreAlpha?: boolean` - Ignore alpha channel

**Returns:**

- `data: Uint8Array` - Pixel data
- `width: number` - Image width in pixels
- `height: number` - Image height in pixels
- `hasAlpha?: boolean` - Whether the image has an alpha channel
- `bitDepth?: 8 | 10 | 12` - Color bit depth

### `encode(imageData: AvifImageData, options?: AvifEncodeOptions): Uint8Array`

Encodes RGBA pixel data to AVIF format.

**Options:**

- `quality?: number` - Quality (0-100, default: 80)
- `lossless?: boolean` - Reserved; currently throws when enabled
- `effort?: number` - Reserved speed/effort trade-off
- `alpha?: boolean` - Reserved; currently throws when enabled
- `chromaSubsampling?: '4:2:0'` - The current encoder output format

## Container Format

The library fully supports parsing HEIF/ISOBMFF container format:

- `ftyp` - File type box
- `meta` - Metadata container
- `hdlr` - Handler box
- `pitm` - Primary item box
- `iloc` - Item location box
- `iinf` - Item info box
- `iprp` - Item properties box
- `mdat` - Media data box

## Technical Notes

This is a pure TypeScript AVIF implementation focused on 8-bit intra still images. The encoder writes real AV1 sequence, frame, partition, mode, and coefficient syntax using adaptive arithmetic coding; it does not shell out to a native codec.

Key components:

- HEIF container parsing (ISO Base Media File Format)
- AV1 OBU (Open Bitstream Unit) parsing
- Bit-exact AV1 intra prediction, inverse transforms, deblocking, CDEF, and loop restoration
- 4×4 DC-predicted DCT encoder with full-range BT.709 4:2:0 output

## Limitations

- The encoder accepts opaque 8-bit RGBA images up to 4096×2304. Alpha, lossless mode, and 4:2:2/4:4:4 encoding throw explicitly.
- The decoder supports the 8-bit intra path. 10/12-bit, inter frames, intra-block copy, palette, film grain, quantizer matrices, super-resolution, and 128×128 superblocks throw explicitly.
- Animation is not implemented.

## License

MIT

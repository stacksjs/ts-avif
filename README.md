# ts-avif

A pure TypeScript AVIF encoder and decoder with zero native dependencies.

## Features

- 🚀 Pure TypeScript - no native dependencies
- 📦 Zero dependencies
- 🎨 HEIF/ISOBMFF container support
- 🔄 AV1 still image codec
- 📐 Alpha channel support

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
  lossless: false,
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
- `lossless?: boolean` - Use lossless encoding
- `effort?: number` - Speed/effort trade-off (0-10, default: 6)
- `alpha?: boolean` - Enable alpha channel
- `chromaSubsampling?: '4:2:0' | '4:2:2' | '4:4:4'` - Chroma subsampling

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

This is a pure TypeScript implementation of AVIF decoding and encoding. AV1 is a complex codec, and this implementation focuses on still image support (AVIF).

Key components:
- HEIF container parsing (ISO Base Media File Format)
- AV1 OBU (Open Bitstream Unit) parsing
- AV1 sequence header and frame decoding framework

## Limitations

- Full AV1 decoding is complex; this is a foundation implementation
- Animation support is not yet implemented
- Some advanced AV1 features may not be fully supported

## License

MIT

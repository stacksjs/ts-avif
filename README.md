# ts-avif

Pure TypeScript AVIF encoding and decoding with zero runtime dependencies.

`ts-avif` reads and writes AVIF still images without native bindings, WebAssembly, or subprocesses. It includes an AV1 intra decoder, a compact intra encoder, HEIF/ISOBMFF container tools, metadata inspection, and lossless container optimization.

> [!IMPORTANT]
> The codec currently targets opaque, 8-bit, intra-only still images. See [Codec support](#codec-support) for the exact feature set.

## Install

```bash
npm install @stacksjs/ts-avif
```

```bash
bun add @stacksjs/ts-avif
```

```bash
pnpm add @stacksjs/ts-avif
```

## Quick start

### Decode an AVIF image

```ts
import { readFile } from 'node:fs/promises'
import { decode } from '@stacksjs/ts-avif'

const input = await readFile('input.avif')
const image = decode(input)

console.log(image.width, image.height)
console.log(image.data) // RGBA, four bytes per pixel
```

Request packed RGB output when an alpha byte is not needed:

```ts
const image = decode(input, { format: 'rgb' })
// image.data contains three bytes per pixel
```

### Encode RGBA pixels

```ts
import { writeFile } from 'node:fs/promises'
import { encode } from '@stacksjs/ts-avif'

const width = 640
const height = 480
const rgba = new Uint8Array(width * height * 4)

// Fill rgba with opaque pixel data.

const output = encode(
  { data: rgba, width, height },
  { quality: 82 },
)

await writeFile('output.avif', output)
```

The encoder accepts opaque 8-bit RGBA input and produces a full-range BT.709, 4:2:0 AVIF image. `quality` ranges from `0` to `100` and defaults to `80`.

For promise-based pipelines, `encodeAsync()` exposes the same operation and options:

```ts
import { encodeAsync } from '@stacksjs/ts-avif'

const output = await encodeAsync({ data: rgba, width, height })
```

### Read metadata without decoding pixels

```ts
import { getAvifMetadata } from '@stacksjs/ts-avif'

const metadata = getAvifMetadata(input)

console.log({
  width: metadata.width,
  height: metadata.height,
  bitDepth: metadata.bitDepth,
  hasAlpha: metadata.hasAlpha,
  rotation: metadata.rotation,
  mirror: metadata.mirror,
  grid: metadata.grid,
})
```

Metadata inspection understands item/property associations, grid descriptors, auxiliary alpha items, and rotation and mirror properties.

### Optimize an existing AVIF

`optimize()` losslessly rewrites the container and returns the smaller of the original and optimized files. Encoded AV1 image data is preserved byte-for-byte.

```ts
import { optimizeWithStats } from '@stacksjs/ts-avif'

const { bytes, stats } = optimizeWithStats(input)

console.log(`Saved ${stats.bytesSaved} bytes`)
console.log(`Removed item types: ${stats.droppedItemTypes.join(', ')}`)
```

The optimizer can remove metadata and thumbnail items, unused references, padding boxes, and redundant compatible brands while retaining the primary image and auxiliary alpha data.

## API

### High-level API

| Export | Description |
| --- | --- |
| `decode(input, options?)` | Decode an AVIF file into RGBA or RGB pixels. |
| `encode(image, options?)` | Encode opaque RGBA pixels into an AVIF file. |
| `encodeAsync(image, options?)` | Promise-returning form of `encode()`. |
| `getAvifMetadata(input)` | Inspect image, item, color-depth, grid, and transform metadata. |
| `optimize(input)` | Losslessly optimize a container, keeping the smaller result. |
| `optimizeWithStats(input)` | Optimize and return details about the result. |
| `remux(input)` | Force a fresh, stripped container without the smaller-result guard. |

### Decode options

```ts
interface AvifDecodeOptions {
  format?: 'rgba' | 'rgb'
  ignoreAlpha?: boolean
}
```

- `format` defaults to `'rgba'`.
- `ignoreAlpha` skips decoding an auxiliary alpha image when present.

### Encode options

```ts
interface AvifEncodeOptions {
  quality?: number
  lossless?: boolean
  effort?: number
  alpha?: boolean
  chromaSubsampling?: '4:2:0' | '4:2:2' | '4:4:4'
}
```

- `quality` accepts `0` through `100` and defaults to `80`.
- `effort` is reserved for future encoder tuning and is currently ignored.
- `lossless: true`, `alpha: true`, and chroma formats other than `4:2:0` currently throw explicit errors.

### Low-level tools

Advanced consumers can work directly with the container and AV1 layers:

- `encodeAV1()` and `decodeAV1()` for low-overhead AV1 OBU streams
- `parseISOBMFF()`, `findBox()`, and `findAllBoxes()` for container inspection
- AVIF item, item-location, property-association, and grid parsers
- `parseOBUs()`, `createOBU()`, and `writeLeb128()` for AV1 OBU handling

All public types are exported from the package entry point.

## Codec support

### Decoder

The decoder supports the 8-bit AV1 intra path used by still images, including:

- Intra prediction and inverse transforms
- Deblocking, CDEF, and loop restoration
- Segmentation and switchable restoration modes
- Auxiliary alpha decoding for supported 8-bit intra streams
- HEIF item lookup with absolute and `idat`-relative extents

Unsupported syntax fails explicitly instead of returning silently corrupted pixels. This currently includes:

- 10-bit and 12-bit samples
- Inter frames and animation
- Intra block copy and palette mode
- Film grain, quantization matrices, and super-resolution
- 128×128 superblocks

### Encoder

The bundled encoder writes real AV1 sequence, frame, partition, mode, transform-coefficient, and adaptive arithmetic syntax. Its current profile is intentionally focused:

- Opaque 8-bit RGBA input
- Full-range BT.709 YUV 4:2:0 output
- Intra-only, single-tile still images
- 4×4 DC-predicted DCT blocks
- Maximum dimensions of 4096×2304

Alpha encoding, lossless encoding, 4:2:2 and 4:4:4 chroma, animation, and more advanced encoder decisions are not yet implemented.

## Container support

The HEIF/ISOBMFF layer handles the AVIF structures needed for image lookup, metadata, encoding, and optimization, including `ftyp`, `meta`, `pitm`, `iloc`, `iinf`, `iref`, `iprp`, `ipco`, `ipma`, `idat`, and `mdat`.

## Development

```bash
bun install
bun test
bun run typecheck
bun run lint
bun run build
```

The decoder is covered by bit-exact fixtures generated from compiled AV1 kernels, alongside full-file decode and encode/decode integration tests.

## Credits

Codec behavior and interoperability were validated with the [dav1d](https://code.videolan.org/videolan/dav1d) and [rav1e](https://github.com/xiph/rav1e) projects. Their work is invaluable to the wider AV1 ecosystem.

## License

MIT

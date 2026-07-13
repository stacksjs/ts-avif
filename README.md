# ts-avif

Pure TypeScript AVIF encoding, decoding, inspection, and optimization with zero runtime dependencies.

`ts-avif` works directly with AV1 and HEIF/ISOBMFF data. It does not require native bindings, WebAssembly, command-line codecs, or subprocesses.

## Features

- Decode AVIF still images to RGBA or RGB pixels
- Decode timed AVIF sequences with frame timestamps and durations
- Encode opaque RGBA pixels with the bundled TypeScript AV1 encoder
- Inspect image dimensions, color depth, transforms, grids, and item metadata without decoding pixels
- Decode auxiliary alpha items for supported still images
- Losslessly optimize or remux AVIF containers without re-encoding AV1 payloads
- Work with low-level AV1 OBUs and HEIF boxes when building custom pipelines

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

## Decode an image

```ts
import { readFile } from 'node:fs/promises'
import { decode } from '@stacksjs/ts-avif'

const input = await readFile('photo.avif')
const image = decode(input)

console.log(image.width, image.height, image.bitDepth)
console.log(image.data) // Uint8Array containing RGBA pixels
```

Use packed RGB output when an alpha byte is not needed:

```ts
const image = decode(input, { format: 'rgb' })
// image.data contains width × height × 3 bytes
```

For still images with an auxiliary alpha item, alpha is applied automatically. Pass `{ ignoreAlpha: true }` to skip it.

## Decode an animated AVIF

```ts
import { decodeSequence } from '@stacksjs/ts-avif'

const animation = decodeSequence(input)

console.log(animation.timescale, animation.duration)

for (const frame of animation.frames) {
  console.log(frame.timestamp, frame.duration)
  console.log(frame.width, frame.height, frame.data)
}
```

Timestamps and durations use the returned track timescale. Sequence decoding maintains AV1 reference slots, entropy contexts, hidden frames, and `show_existing_frame` state between samples.

## Encode an image

```ts
import { writeFile } from 'node:fs/promises'
import { encode } from '@stacksjs/ts-avif'

const width = 640
const height = 480
const rgba = new Uint8Array(width * height * 4)

// Fill rgba with opaque pixels.

const output = encode(
  { data: rgba, width, height },
  { quality: 82 },
)

await writeFile('output.avif', output)
```

The encoder is implemented in TypeScript and emits both the AV1 bitstream and AVIF container. `encodeAsync()` provides the same operation for promise-based pipelines:

```ts
import { encodeAsync } from '@stacksjs/ts-avif'

const output = await encodeAsync({ data: rgba, width, height })
```

`quality` accepts values from `0` to `100` and defaults to `80`.

## Inspect metadata

Metadata can be read without entropy-decoding the image:

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

Property lookup follows per-item `ipma` associations, so derived grids and auxiliary items report their own metadata correctly.

## Optimize a container

`optimize()` rewrites container metadata without touching encoded AV1 bytes and returns whichever is smaller: the original file or the optimized result.

```ts
import { optimizeWithStats } from '@stacksjs/ts-avif'

const { bytes, stats } = optimizeWithStats(input)

console.log(`Saved ${stats.bytesSaved} bytes`)
console.log(stats.droppedItemTypes)
```

The optimizer can remove metadata, thumbnails, unused references, padding, and redundant compatible brands while preserving the primary image and auxiliary alpha payloads. Use `remux()` when a fresh stripped container is required even if it is not smaller.

## API

| Export | Description |
| --- | --- |
| `decode(input, options?)` | Decode one AVIF image to RGBA or RGB. |
| `decodeSequence(input, options?)` | Decode every displayed frame in a timed AVIF track. |
| `encode(image, options?)` | Encode opaque RGBA pixels to AVIF. |
| `encodeAsync(image, options?)` | Promise-returning form of `encode()`. |
| `getAvifMetadata(input)` | Inspect image items, properties, grids, and transforms. |
| `optimize(input)` | Losslessly optimize a container and keep the smaller result. |
| `optimizeWithStats(input)` | Optimize and return size and removal details. |
| `remux(input)` | Force a stripped container rewrite. |
| `decodeAV1()` / `decodeAV1Sequence()` | Decode low-overhead AV1 OBU streams directly. |
| `encodeAV1()` | Encode pixels to a low-overhead AV1 OBU stream. |
| `parseISOBMFF()` / `findBox()` | Inspect the container box tree. |
| `parseOBUs()` / `createOBU()` | Inspect or construct AV1 OBUs. |

All public interfaces, animation types, box types, codec configuration types, and OBU types are exported from the package entry point.

### Decode options

```ts
interface AvifDecodeOptions {
  format?: 'rgba' | 'rgb'
  ignoreAlpha?: boolean
}
```

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

The current encoder accepts opaque 8-bit RGBA input up to 4096×2304 and writes full-range BT.709 YUV 4:2:0, single-tile intra images. Alpha encoding, lossless encoding, 4:2:2 or 4:4:4 output, and animated encoding are not implemented. Unsupported encoder options throw instead of being ignored; `effort` is currently reserved for future tuning.

## Decoder support

The decoder implements the AV1 tools used by a broad range of still images and straightforward animated sequences:

- 8-, 10-, and 12-bit samples
- Monochrome and subsampled color planes
- Directional, smooth, Paeth, filter-intra, and chroma-from-luma prediction
- Palette prediction and lossless intra block copy
- AV1 inverse transforms, segmentation, delta quantization, and quantization matrices
- 64×64 and 128×128 superblocks
- Deblocking, CDEF, Wiener and self-guided loop restoration
- Super-resolution and film-grain synthesis
- Zero-motion, translational, and global-motion inter prediction
- Variable transform trees and switchable regular, smooth, sharp, and bilinear inter filters
- Reference-frame refresh, short reference signaling, hidden frames, and existing-frame display
- Timed AVIF sample tables using `stts`, `stsc`, `stsz`, `stco`, and `co64`

This is not intended to be a general-purpose AV1 video decoder. Coded compound inter prediction, inter-intra blending, overlapped motion compensation, and local warped motion currently throw explicit errors when selected. Temporal motion-field projection and animated auxiliary-alpha tracks are also outside the validated sequence subset.

## Container support

The HEIF/ISOBMFF layer understands the AVIF structures needed for image lookup, metadata, sequences, encoding, and optimization, including:

`ftyp`, `meta`, `pitm`, `iloc`, `iinf`, `iref`, `iprp`, `ipco`, `ipma`, `idat`, `mdat`, `moov`, `trak`, `mdia`, `minf`, and `stbl`.

Both absolute item extents and `idat`-relative extents are supported.

## Verification

The codec is tested against compiled reference implementations and bit-exact pixel or kernel oracles. Coverage includes the real `photo-small.avif` deliverable, high-bit-depth reconstruction, inter prediction, global motion, palette and intra block copy, quantization matrices, super-resolution, film grain, CDEF, loop restoration, inverse transforms, and arithmetic coding.

```bash
bun install
bun test
bun run typecheck
bun run lint
bun run build
```

## Credits

Interoperability and reference vectors were validated with [dav1d](https://code.videolan.org/videolan/dav1d), [libaom](https://aomedia.googlesource.com/aom/), and [rav1e](https://github.com/xiph/rav1e). Their codec implementations and conformance work are foundational to the AV1 ecosystem.

## License

MIT

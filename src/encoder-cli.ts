import type { AvifEncodeOptions, AvifImageData } from './types'

/**
 * Shell out to the system `avifenc` binary (libavif) for real AVIF
 * encoding. Returns the encoded bytes, or `null` if the binary
 * isn't available or fails to run.
 *
 * Why bother shelling out? The bundled AV1 path is a stub — it
 * writes a syntactically valid AVIF container (ftyp, meta, mdat)
 * but the AV1 frame payload is placeholder data, so decoders see
 * a 341-byte blank frame regardless of the input pixels. AV1 is a
 * full video codec and writing a competitive still-image encoder
 * from scratch is multi-week work; until that lands, the CLI
 * fallback gives users a real AVIF output the moment they have
 * libavif on PATH (Homebrew `libavif`, apt `libavif-tools`, etc.).
 *
 * Transport: the same PAM (P7) shape we use for cwebp — header +
 * raw RGBA on stdin, encoded bytes on stdout.
 */
export async function encodeViaAvifenc(
  imageData: AvifImageData,
  options: AvifEncodeOptions,
): Promise<Uint8Array | null> {
  const bin = options.avifencPath || 'avifenc'

  const { width, height, data } = imageData
  if (data.byteLength !== width * height * 4)
    throw new Error('ts-avif: imageData.data must be RGBA (width × height × 4 bytes)')

  const header = `P7\nWIDTH ${width}\nHEIGHT ${height}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`
  const headerBytes = new TextEncoder().encode(header)
  const stdin = new Uint8Array(headerBytes.byteLength + data.byteLength)
  stdin.set(headerBytes, 0)
  stdin.set(data, headerBytes.byteLength)

  // avifenc uses temp files by convention. We write the input PAM
  // to a temp file, run `avifenc input.pam output.avif`, and read
  // the output. Bun.write + Bun.file makes this cheap.
  const tmpDir = process.env.TMPDIR || '/tmp'
  const id = Math.random().toString(36).slice(2, 10)
  const inPath = `${tmpDir}/ts-avif-${id}.pam`
  const outPath = `${tmpDir}/ts-avif-${id}.avif`

  try {
    await Bun.write(inPath, stdin)

    // avifenc args:
    //   --quality / -q : 0..100, higher = better
    //   --lossless     : ignore -q, use lossless encoding
    //   --speed        : 0 (slowest, smallest) .. 10 (fastest, biggest)
    //   --yuv          : 420|422|444 chroma sampling
    //   --jobs all     : use all cores
    const args = [bin, '--jobs', 'all']
    if (options.lossless)
      args.push('--lossless')
    else
      args.push('-q', String(options.quality ?? 60))
    if (typeof options.effort === 'number')
      args.push('--speed', String(Math.max(0, Math.min(10, 10 - options.effort))))
    if (options.chromaSubsampling) {
      const yuv = options.chromaSubsampling === '4:4:4'
        ? '444'
        : options.chromaSubsampling === '4:2:2' ? '422' : '420'
      args.push('--yuv', yuv)
    }
    args.push(inPath, outPath)

    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn(args, { stdout: 'ignore', stderr: 'ignore' })
    }
    catch {
      return null
    }
    const exitCode = await proc.exited
    if (exitCode !== 0) return null

    const out = await Bun.file(outPath).bytes()
    return out
  }
  finally {
    // Best-effort cleanup of both temp files. Failure here is
    // fine — /tmp gets reaped by the OS regardless.
    await Promise.all([
      Bun.file(inPath).unlink?.()?.catch?.(() => {}),
      Bun.file(outPath).unlink?.()?.catch?.(() => {}),
    ])
  }
}

let avifencAvailable: boolean | null = null
export async function hasAvifenc(binPath?: string): Promise<boolean> {
  if (binPath) {
    try {
      const proc = Bun.spawn([binPath, '--version'], { stdout: 'ignore', stderr: 'ignore' })
      return (await proc.exited) === 0
    }
    catch {
      return false
    }
  }
  if (avifencAvailable !== null) return avifencAvailable
  try {
    const proc = Bun.spawn(['avifenc', '--version'], { stdout: 'ignore', stderr: 'ignore' })
    avifencAvailable = (await proc.exited) === 0
  }
  catch {
    avifencAvailable = false
  }
  return avifencAvailable
}

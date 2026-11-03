import { nativeImage } from 'electron'
import type { ImageAttachment, NormalizeImageResult } from '@shared/types'
import { checkImageBytes, isPngBytes } from '@shared/imaging'

// images:normalize — the rescue path for clipboard images Chromium
// cannot decode in an <img> (macOS screenshots and Snagit pastes often
// arrive as TIFF; Finder copies can carry BMP/HEIC). nativeImage decodes
// through the platform's own codecs (ImageIO on macOS), so anything the
// OS can read becomes a PNG attachment here. Every failure is a returned
// { ok: false, error } — this never throws across IPC.

const MAX_EDGE = 2048 // px on the long edge, same cap as the renderer path

export function normalizeImage(bytes: Uint8Array): NormalizeImageResult {
  const bad = checkImageBytes(bytes)
  if (bad) return { ok: false, error: bad }
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(bytes))
    if (img.isEmpty()) return { ok: false, error: 'The system image decoder could not read those bytes.' }
    const { width, height } = img.getSize()
    if (!width || !height) return { ok: false, error: 'The system image decoder returned an empty image.' }
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height))
    const out =
      scale < 1
        ? img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' })
        : img
    const png = out.toPNG()
    if (!isPngBytes(png)) return { ok: false, error: 'The converted image failed validation.' }
    const attachment: ImageAttachment = { mime: 'image/png', dataBase64: png.toString('base64') }
    // Report the SOURCE size (pre-downscale): the renderer dedupes
    // clipboard format twins by their original pixel dimensions.
    return { ok: true, attachment, width, height }
  } catch (e: any) {
    return { ok: false, error: `Image conversion failed: ${e?.message ?? e}` }
  }
}

// Pure image helpers shared by the renderer (clipboard/drop candidate
// classification), the main process (images:normalize input/output
// guards), and the Node test harness. No Electron or DOM imports.

// Image formats Chromium's <img>/canvas can decode directly. Clipboard
// candidates sniffing as one of these are tried on the renderer canvas
// path first; anything else (TIFF, BMP on some platforms, HEIC) falls
// back to the main process's nativeImage conversion.
export const BROWSER_DECODABLE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|tiff?|bmp|heic|heif|avif)$/i

// Upper bound for the images:normalize IPC — a clipboard image larger
// than this is a malfunction (or an attack), not a screenshot.
export const MAX_NORMALIZE_BYTES = 32 * 1024 * 1024

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function hasSig(bytes: Uint8Array, sig: number[], off = 0): boolean {
  if (bytes.length < off + sig.length) return false
  for (let i = 0; i < sig.length; i++) if (bytes[off + i] !== sig[i]) return false
  return true
}

function asciiAt(bytes: Uint8Array, off: number, s: string): boolean {
  if (bytes.length < off + s.length) return false
  for (let i = 0; i < s.length; i++) if (bytes[off + i] !== s.charCodeAt(i)) return false
  return true
}

// Classify image bytes by their magic numbers. Clipboard data cannot be
// trusted to declare a type: Electron hands over screenshot PNGs with an
// empty DataTransferItem.type, and macOS apps may offer TIFF only. The
// bytes are the ground truth. Returns a mime string or null when the
// buffer matches no known image signature.
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (!bytes || bytes.length < 2) return null
  if (hasSig(bytes, PNG_SIG)) return 'image/png'
  if (hasSig(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (asciiAt(bytes, 0, 'GIF8')) return 'image/gif'
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'image/webp'
  // TIFF: little-endian "II*\0" or big-endian "MM\0*"
  if (hasSig(bytes, [0x49, 0x49, 0x2a, 0x00]) || hasSig(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff'
  if (hasSig(bytes, [0x42, 0x4d])) return 'image/bmp' // "BM"
  // HEIC/HEIF: ISO-BMFF "ftyp" box with a heic/mif1 brand
  if (asciiAt(bytes, 4, 'ftyp') && (asciiAt(bytes, 8, 'heic') || asciiAt(bytes, 8, 'mif1'))) return 'image/heic'
  return null
}

// Input guard for images:normalize. Returns a readable error string, or
// null when the bytes are acceptable.
export function checkImageBytes(bytes: Uint8Array): string | null {
  if (!bytes || bytes.length === 0) return 'No image data was received.'
  if (bytes.length > MAX_NORMALIZE_BYTES)
    return `That image is too large to convert (${(bytes.length / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_NORMALIZE_BYTES / 1024 / 1024} MB).`
  return null
}

// Output guard for images:normalize: the converted result must really be
// a PNG before it is handed back as one.
export function isPngBytes(bytes: Uint8Array): boolean {
  return hasSig(bytes, PNG_SIG)
}

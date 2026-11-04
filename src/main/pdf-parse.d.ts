// Local type declaration for the pdf-parse implementation module. The
// package root (pdf-parse/index.js) runs a debug self-test against a
// bundled sample file when imported in some contexts, so the app imports
// the lib subpath directly — which ships without its own types.
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string
    numpages: number
    numrender: number
    info: unknown
    metadata: unknown
    version: string
  }
  // pdf.js accepts any Uint8Array view of the file bytes; see the pdf
  // case in extract.ts for why an exact unpooled copy is passed.
  function pdfParse(dataBuffer: Uint8Array, options?: Record<string, unknown>): Promise<PdfParseResult>
  export default pdfParse
}

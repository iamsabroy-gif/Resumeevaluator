/**
 * pdf-parse ships no types, and we import its lib entry point directly rather
 * than the package index (see extractResumeText.ts for why).
 */
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: Record<string, unknown>;
  }
  function pdfParse(buffer: Buffer): Promise<PdfParseResult>;
  export default pdfParse;
}

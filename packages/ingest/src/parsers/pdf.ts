import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Text from a PDF. Government orders are overwhelmingly published as PDFs, so this is the main path
 * from "a GO was issued" to "we know what it says".
 *
 * Only text-layer PDFs are handled. A scanned GO — common for older orders and some district offices —
 * has no text layer and comes back empty; `needsOcr` says so rather than pretending the document is
 * blank. OCR (Tesseract with the Telugu, Hindi and other Indic models) is a separate, heavier stage that
 * is not bundled here.
 */
export interface PdfText {
  text: string;
  pages: number;
  needsOcr: boolean;
}

export async function pdfText(bytes: Uint8Array): Promise<PdfText> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  const merged = (Array.isArray(text) ? text.join('\n') : text).replace(/\s+/g, ' ').trim();
  // Fewer than ~20 characters per page means there is no real text layer.
  return {
    text: merged,
    pages: totalPages,
    needsOcr: merged.length < 20 * Math.max(1, totalPages),
  };
}

/**
 * src/ingestion/__tests__/classifyPdfCompressed.test.ts
 *
 * Regression guard for the most expensive defect found in the extraction
 * pipeline (2026-08-11).
 *
 * `classifyPdfBytes` required BOTH `/Font` AND visible text-show operators
 * (`BT ... Tj`) before calling a PDF `text_pdf`. Those operators live inside the
 * content stream, and PDFs Flate-compress content by default — so the regex
 * matched 0 of 25 real House/Executive filings sampled from production. With it
 * permanently false, typed filings fell through to `scanned_pdf`.
 *
 * Measured impact on that sample: 19 of 25 filings marked `scanned_pdf` in
 * production had a full extractable text layer (pdftotext recovered 681-11,381
 * characters). Each was routed to a paid vision read plus 2-3 more paid reads in
 * the agreement cascade, to obtain text the free local extractor already had.
 *
 * The bias is deliberate and asymmetric: HousePdfExtractor runs text extraction
 * first and only falls back to vision when it yields no usable rows
 * (src/extractors/types.ts), so a wrong `text_pdf` costs one free attempt while
 * a wrong `scanned_pdf` costs several paid model calls.
 */
import { describe, it, expect } from 'vitest';
import { classifyPdfBytes } from '../classifier.ts';

const enc = (s: string) => new TextEncoder().encode(s);

describe('classifyPdfBytes — compressed content streams', () => {
  it('treats an embedded font as a text layer even when operators are compressed', () => {
    // The real-world shape: font resources visible, text operators hidden
    // inside a FlateDecode stream, and a page rendered via an XObject.
    const pdf = enc(
      '%PDF-1.4\n'
      + '<< /Type /Page /Resources << /Font << /F1 5 0 R >> >> >>\n'
      + '<< /Filter /FlateDecode /Length 900 >>\nstream\n\x78\x9c\xbd\x56\x4d\x6f\n endstream\n'
      + '<< /Type /XObject /Subtype /Image /Width 1700 >>\n',
    );
    expect(classifyPdfBytes(pdf)).toBe('text_pdf');
  });

  it('still classifies a genuine image-only scan as scanned_pdf', () => {
    const pdf = enc(
      '%PDF-1.4\n'
      + '<< /Type /XObject /Subtype /Image /Width 1700 /Height 2200 '
      + '/ColorSpace /DeviceGray /Filter /CCITTFaxDecode >>\n'
      + 'stream\n\x00\x01\x02 endstream\n',
    );
    expect(classifyPdfBytes(pdf)).toBe('scanned_pdf');
  });

  it('classifies an uncompressed text PDF as text_pdf (unchanged behaviour)', () => {
    const pdf = enc(
      '%PDF-1.4\n<< /Font << /F1 1 0 R >> >>\nstream\nBT /F1 12 Tf (Treasury Bill) Tj ET\nendstream\n',
    );
    expect(classifyPdfBytes(pdf)).toBe('text_pdf');
  });

  it('classifies a PDF with neither fonts nor images as scanned_pdf', () => {
    expect(classifyPdfBytes(enc('%PDF-1.4\n<< /Type /Catalog >>\n'))).toBe('scanned_pdf');
  });

  it('does not require text-show operators, which compression makes invisible', () => {
    // Exactly the case that regressed: fonts present, zero visible operators.
    const pdf = enc('%PDF-1.7\n<< /Resources << /Font << /F2 9 0 R >> >> >>\n');
    expect(classifyPdfBytes(pdf)).toBe('text_pdf');
  });
});

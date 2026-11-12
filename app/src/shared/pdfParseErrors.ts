/**
 * Expected pdf.js / unpdf parse failures for House PTR and OGE 278-T files.
 *
 * extractPdfText already fail-softs (empty text, vision fallback).  pdf.js
 * still rejects leftover worker promises after "Indexing all PDF objects",
 * which #2226's global unhandledrejection listener then captured as
 * CONGRESS-TRADE-1C.  Those must stay out of Sentry.
 */

const EXPECTED_PDF_EXCEPTION_NAMES = new Set([
  'XRefEntryException',
  'XRefParseException',
  'InvalidPDFException',
  'MissingPDFException',
]);

const EXPECTED_PDF_MESSAGE_RE =
  /bad \(uncompressed\) xref entry|invalid xref|missing pdf header|invalid pdf structure/i;

/** Belt-and-suspenders for SDK auto-capture (CONGRESS-TRADE-1C). */
export const SENTRY_PDF_IGNORE_ERRORS: Array<string | RegExp> = [
  'XRefEntryException',
  'XRefParseException',
  'InvalidPDFException',
  'MissingPDFException',
  /Bad \(uncompressed\) XRef entry/i,
];

function asErrorShape(reason: unknown): { name: string; message: string } {
  if (reason == null) return { name: '', message: '' };
  if (typeof reason === 'string') return { name: '', message: reason };
  if (typeof reason !== 'object') return { name: '', message: String(reason) };
  const rec = reason as { name?: unknown; message?: unknown };
  return {
    name: typeof rec.name === 'string' ? rec.name : '',
    message: typeof rec.message === 'string' ? rec.message : '',
  };
}

/** True for malformed-PDF noise that extractors already treat as empty text. */
export function isExpectedPdfParseNoise(reason: unknown): boolean {
  const { name, message } = asErrorShape(reason);
  if (EXPECTED_PDF_EXCEPTION_NAMES.has(name)) return true;
  return EXPECTED_PDF_MESSAGE_RE.test(name) || EXPECTED_PDF_MESSAGE_RE.test(message);
}

/**
 * True when a Sentry event is the same pdf.js XRef / invalid-PDF noise.
 * Used by beforeSend so SDK auto-capture cannot reopen CONGRESS-TRADE-1C.
 */
export function sentryEventLooksLikePdfParseNoise(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const rec = event as Record<string, unknown>;
  const exception = rec.exception;
  if (exception && typeof exception === 'object') {
    const values = (exception as { values?: unknown }).values;
    if (Array.isArray(values)) {
      for (const value of values) {
        if (!value || typeof value !== 'object') continue;
        const item = value as { type?: unknown; value?: unknown };
        if (
          isExpectedPdfParseNoise({
            name: typeof item.type === 'string' ? item.type : '',
            message: typeof item.value === 'string' ? item.value : '',
          })
        ) {
          return true;
        }
      }
    }
  }
  if (typeof rec.message === 'string' && EXPECTED_PDF_MESSAGE_RE.test(rec.message)) {
    return true;
  }
  return false;
}

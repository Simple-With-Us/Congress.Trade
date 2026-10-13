/**
 * Human verification gate for vision / OCR extractions that must not auto-publish.
 */
import type { Filing, TxSource } from '../shared/types.ts';
import { filingDocClass, isHousePaperScanDocId } from './extractRouting.ts';

function isLocalVisionExtractor(extractor: string | null | undefined): boolean {
  const compact = (extractor || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return compact.includes('local_grok')
    || compact.includes('local_mac')
    || compact.includes('mac_vision');
}

export const NEEDS_HAND_CHECK_MAC_VISION = 'needs_hand_check:mac_vision';
export const NEEDS_HAND_CHECK_SCANNED_VISION = 'needs_hand_check:scanned_vision';

export function isScannedOrHandwrittenFiling(filing: Filing): boolean {
  const docKind = (filing.docKind || '').trim().toLowerCase();
  if (docKind === 'scanned_pdf') return true;
  const docClass = filingDocClass(filing);
  if (docClass === 'clean_scan' || docClass === 'hard_scan') return true;
  if (isHousePaperScanDocId(filing.docId)) return true;
  return false;
}

export function isVisionOrOcrExtraction(
  extractor: string | null | undefined,
  source: TxSource,
): boolean {
  if (source === 'manual' || source === 'seed_dataset' || source === 'competitor_backfill') {
    return false;
  }
  if (source === 'local_mac' || source === 'server_cpu') return true;
  if (isLocalVisionExtractor(extractor)) return true;
  const compact = (extractor || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return compact.includes('vision')
    || compact.includes('openrouter')
    || compact.includes('anthropic')
    || compact.includes('mistral')
    || compact.includes('llamaparse')
    || compact.includes('tesseract')
    || compact.includes('ocr')
    || compact.includes('grok');
}

/** True when pipeline auto-publish must not run; only human/manual confirm may publish. */
export function requiresHandCheckBeforePublish(
  filing: Filing,
  extractor: string | null | undefined,
  source: TxSource,
): boolean {
  if (source === 'manual') return false;
  if (source === 'local_mac' || isLocalVisionExtractor(extractor)) return true;
  if (!isScannedOrHandwrittenFiling(filing)) return false;
  return isVisionOrOcrExtraction(extractor, source);
}

export function handCheckReviewReason(
  filing: Filing,
  extractor: string | null | undefined,
  source: TxSource,
): string {
  if (source === 'local_mac' || isLocalVisionExtractor(extractor)) {
    return NEEDS_HAND_CHECK_MAC_VISION;
  }
  return NEEDS_HAND_CHECK_SCANNED_VISION;
}

export function mergeHandCheckIntoReviewReason(
  baseReason: string,
  handCheckToken: string,
): string {
  if (!baseReason?.trim()) return handCheckToken;
  if (baseReason.includes(handCheckToken)) return baseReason;
  return `${handCheckToken},${baseReason}`;
}

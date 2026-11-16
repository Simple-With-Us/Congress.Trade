/**
 * Grid-form trade / notification date plausibility and conservative digit repair.
 * Kept separate from row geometry, cover skip, and asset cleanup so parallel
 * grid-form work can land without merge conflicts.
 */

/** Max calendar days from trade to notification on these PTR scans. */
export const GRID_FORM_MAX_TRADE_TO_NOTIFICATION_DAYS = 45;

/** Single-digit OCR confusions allowed for one-step repair (never chained). */
const DIGIT_CONFUSIONS: Record<string, readonly string[]> = {
  '0': ['6'],
  '1': ['7'],
  '3': ['8'],
  '6': ['0'],
  '7': ['1'],
  '8': ['3'],
};

const DATE_RE = /^\D{0,2}(\d{1,2})\s*[/l1I|]\s*(\d{1,2})\s*[/l1I|]\s*(\d{2,4})\D{0,3}$/;

export interface GridFormDateContext {
  /** Filing `filedDate` when the extractor has it. */
  filedDate?: string | null;
}

export interface GridFormRowDateInput {
  tradeDate: string | null;
  notifDate: string | null;
  tradeRaw?: string | null;
  notifRaw?: string | null;
}

export interface GridFormRowDateResult {
  tradeDate: string | null;
  notifDate: string | null;
  /** False when dates are present but fail plausibility and no unique repair applied. */
  dateConfidenceOk: boolean;
  repaired: boolean;
}

function isoToUtcDay(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? Math.floor(t / 86_400_000) : null;
}

function daysBetween(a: string | null, b: string | null): number | null {
  const da = isoToUtcDay(a);
  const db = isoToUtcDay(b);
  if (da === null || db === null) return null;
  return db - da;
}

export function parseGridFormLooseDate(text: string): string | null {
  const match = DATE_RE.exec(text.replace(/\s+/g, ''));
  if (!match) return null;
  let month = Number(match[1]);
  const day = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  if (month === 16 || month === 18 || month === 19 || month === 20 || month === 30 || month === 40) month = 10;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1990 || year > 2100) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

function filingYear(filedDate: string | null | undefined): number | null {
  if (!filedDate) return null;
  const y = Number(filedDate.slice(0, 4));
  return Number.isFinite(y) ? y : null;
}

function yearConsistentWithFiling(iso: string | null, filedDate: string | null | undefined): boolean {
  if (!iso) return true;
  const fy = filingYear(filedDate);
  if (fy === null) return true;
  const y = Number(iso.slice(0, 4));
  return y === fy || y === fy - 1;
}

export function gridFormDatesPlausible(
  tradeDate: string | null,
  notifDate: string | null,
  context: GridFormDateContext,
): boolean {
  const filed = context.filedDate ?? null;
  if (tradeDate && notifDate && tradeDate > notifDate) return false;
  if (tradeDate && filed && tradeDate > filed) return false;
  if (notifDate && filed && notifDate > filed) return false;
  const lag = daysBetween(tradeDate, notifDate);
  if (lag !== null && lag > GRID_FORM_MAX_TRADE_TO_NOTIFICATION_DAYS) return false;
  if (lag !== null && lag < 0) return false;
  if (!yearConsistentWithFiling(tradeDate, filed)) return false;
  if (!yearConsistentWithFiling(notifDate, filed)) return false;
  return true;
}

function singleDigitRepairCandidates(raw: string | null | undefined): string[] {
  const base = (raw ?? '').trim();
  if (!base) return [];
  const out = new Set<string>();
  for (let i = 0; i < base.length; i += 1) {
    const ch = base[i];
    if (ch < '0' || ch > '9') continue;
    const alts = DIGIT_CONFUSIONS[ch];
    if (!alts) continue;
    for (const alt of alts) {
      out.add(`${base.slice(0, i)}${alt}${base.slice(i + 1)}`);
    }
  }
  return [...out];
}

function uniquePlausibleIsoFromRaw(
  raw: string | null | undefined,
  currentIso: string | null,
  role: 'trade' | 'notif',
  otherTrade: string | null,
  otherNotif: string | null,
  context: GridFormDateContext,
): string | null {
  const candidates = new Set<string>();
  for (const variant of singleDigitRepairCandidates(raw)) {
    const iso = parseGridFormLooseDate(variant);
    if (!iso || iso === currentIso) continue;
    const trade = role === 'trade' ? iso : otherTrade;
    const notif = role === 'notif' ? iso : otherNotif;
    if (!gridFormDatesPlausible(trade, notif, context)) continue;
    candidates.add(iso);
  }
  if (candidates.size !== 1) return null;
  return [...candidates][0];
}

/**
 * When the OCR read fails plausibility, try at most one single-digit flip per
 * column. Accept only a unique repair; never invent a date from thin air.
 */
export function refineGridFormRowDates(
  input: GridFormRowDateInput,
  context: GridFormDateContext = {},
): GridFormRowDateResult {
  let tradeDate = input.tradeDate;
  let notifDate = input.notifDate;
  let repaired = false;

  if (gridFormDatesPlausible(tradeDate, notifDate, context)) {
    return { tradeDate, notifDate, dateConfidenceOk: true, repaired: false };
  }

  const tryTrade = uniquePlausibleIsoFromRaw(
    input.tradeRaw,
    tradeDate,
    'trade',
    tradeDate,
    notifDate,
    context,
  );
  const tryNotif = uniquePlausibleIsoFromRaw(
    input.notifRaw,
    notifDate,
    'notif',
    tradeDate,
    notifDate,
    context,
  );

  if (tryTrade && tryNotif) {
    // Two independent unique repairs is ambiguous — keep the OCR read.
    return { tradeDate, notifDate, dateConfidenceOk: false, repaired: false };
  }
  if (tryTrade) {
    tradeDate = tryTrade;
    repaired = true;
  } else if (tryNotif) {
    notifDate = tryNotif;
    repaired = true;
  }

  if (repaired && gridFormDatesPlausible(tradeDate, notifDate, context)) {
    return { tradeDate, notifDate, dateConfidenceOk: true, repaired: true };
  }

  return { tradeDate: input.tradeDate, notifDate: input.notifDate, dateConfidenceOk: false, repaired: false };
}

/**
 * src/prices/instrumentCapabilities.ts
 * OWNER: prices
 *
 * Capability boundary for minute-level PIT pricing. Equities (long) and crypto
 * can be priced from Socratic.Trade 1-minute bars. Options and Kalshi-style
 * event contracts cannot — equity bars would be a lie for those instruments.
 *
 * This is the Congress.Trade half of the Options / Kalshi / equities / crypto
 * settings split. Broker-account settings live in Socratic.Trade; CT only
 * decides which disclosed instruments may enter the exact-time price pipeline.
 */

import { canonicalizeAssetType } from '../shared/assetTypes.ts';

export type InstrumentClass = 'equities_long' | 'crypto' | 'option' | 'event_contract' | 'other';

export type MinutePricingPolicy = 'minute' | 'none';

export interface InstrumentCapability {
  class: InstrumentClass;
  label: string;
  minutePricing: MinutePricingPolicy;
  eodPricing: boolean;
  sessions: 'regular_hours' | 'crypto_24_7' | 'none';
  note: string;
}

export const INSTRUMENT_CAPABILITIES: Record<InstrumentClass, InstrumentCapability> = {
  equities_long: {
    class: 'equities_long',
    label: 'Equities (long)',
    minutePricing: 'minute',
    eodPricing: true,
    sessions: 'regular_hours',
    note: 'Minute-level point-in-time prints via the Socratic.Trade peer (1-minute bars). EOD closes feed longer-horizon scores versus the S&P.',
  },
  crypto: {
    class: 'crypto',
    label: 'Crypto',
    minutePricing: 'minute',
    eodPricing: true,
    sessions: 'crypto_24_7',
    note: '24/7 minute bars when the peer has them. Never priced from equity regular-hours prints.',
  },
  option: {
    class: 'option',
    label: 'Options',
    minutePricing: 'none',
    eodPricing: false,
    sessions: 'none',
    note: 'Excluded from equity minute PIT and EOD performance. An AAPL call is not the AAPL common.',
  },
  event_contract: {
    class: 'event_contract',
    label: 'Event Contracts (Kalshi)',
    minutePricing: 'none',
    eodPricing: false,
    sessions: 'none',
    note: 'Prediction-market contracts are not equity bars. No Kalshi probability feed in this slice — skip honestly rather than substitute a stock print.',
  },
  other: {
    class: 'other',
    label: 'Other instruments',
    minutePricing: 'none',
    eodPricing: false,
    sessions: 'none',
    note: 'Bonds, real estate, private funds, and unlabeled rows are not minute-priced.',
  },
};

/** Settings-pane order. `other` is last so the four product classes read first. */
export const INSTRUMENT_CAPABILITY_LIST: InstrumentCapability[] = [
  INSTRUMENT_CAPABILITIES.equities_long,
  INSTRUMENT_CAPABILITIES.crypto,
  INSTRUMENT_CAPABILITIES.option,
  INSTRUMENT_CAPABILITIES.event_contract,
  INSTRUMENT_CAPABILITIES.other,
];

const EVENT_CONTRACT_RE =
  /\b(kalshi|polymarket|predictit|event\s*contracts?|prediction\s*markets?)\b/i;

export interface InstrumentHints {
  ticker?: string | null;
  isOption?: boolean | number | null;
  assetType?: string | null;
  assetTypeName?: string | null;
  assetName?: string | null;
}

export function isEventContractInstrument(hints: InstrumentHints): boolean {
  const hay = [hints.assetType, hints.assetTypeName, hints.assetName, hints.ticker]
    .map((v) => (v ?? '').trim())
    .filter(Boolean)
    .join(' ');
  return EVENT_CONTRACT_RE.test(hay);
}

function truthyFlag(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1;
}

export function classifyInstrument(hints: InstrumentHints): InstrumentClass {
  if (truthyFlag(hints.isOption)) return 'option';
  if (isEventContractInstrument(hints)) return 'event_contract';

  const canonical = canonicalizeAssetType(hints.assetType, hints.assetTypeName, {
    isOption: truthyFlag(hints.isOption),
    assetName: hints.assetName,
  });
  if (canonical.category === 'option') return 'option';
  if (canonical.category === 'crypto') return 'crypto';
  if (canonical.category === 'public_equity' || canonical.category === 'fund') return 'equities_long';

  const hasTypeSignal = Boolean(
    (hints.assetType && hints.assetType.trim()) ||
      (hints.assetTypeName && hints.assetTypeName.trim()) ||
      (hints.assetName && hints.assetName.trim()),
  );
  // Competitor-only latency matches often have a ticker and no disclosure type.
  // A short ticker is treated as equities so we still capture minute prints.
  if (!hasTypeSignal || canonical.category === 'unknown') {
    const ticker = (hints.ticker || '').trim();
    if (ticker && ticker.length <= 8) return 'equities_long';
  }
  return 'other';
}

export function capabilityForInstrument(hints: InstrumentHints): InstrumentCapability {
  return INSTRUMENT_CAPABILITIES[classifyInstrument(hints)];
}

/**
 * True when this instrument may enter the minute-level snapshot pipeline.
 * Ticker length > 8 is the existing absurd-ticker guard (Kalshi market tickers
 * are long; equity symbols are not).
 */
export function canCaptureMinutePricing(hints: InstrumentHints): boolean {
  const ticker = (hints.ticker || '').trim().toUpperCase();
  if (!ticker || ticker.length > 8) return false;
  return capabilityForInstrument({ ...hints, ticker }).minutePricing === 'minute';
}

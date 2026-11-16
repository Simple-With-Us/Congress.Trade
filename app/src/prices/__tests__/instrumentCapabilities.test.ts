import { describe, expect, it } from 'vitest';
import {
  INSTRUMENT_CAPABILITY_LIST,
  canCaptureMinutePricing,
  capabilityForInstrument,
  classifyInstrument,
  isEventContractInstrument,
} from '../instrumentCapabilities.ts';

describe('classifyInstrument', () => {
  it('treats a short ticker with no type as equities (long)', () => {
    expect(classifyInstrument({ ticker: 'AAPL' })).toBe('equities_long');
    expect(canCaptureMinutePricing({ ticker: 'AAPL' })).toBe(true);
  });

  it('classifies House ST / ETFs as equities (long)', () => {
    expect(classifyInstrument({ ticker: 'AAPL', assetType: 'ST' })).toBe('equities_long');
    expect(classifyInstrument({ ticker: 'SPY', assetType: 'EF' })).toBe('equities_long');
  });

  it('classifies crypto from House CT or crypto labels', () => {
    expect(classifyInstrument({ ticker: 'BTC', assetType: 'CT' })).toBe('crypto');
    expect(classifyInstrument({ ticker: 'ETH', assetTypeName: 'Cryptocurrency' })).toBe('crypto');
    expect(canCaptureMinutePricing({ ticker: 'BTC', assetType: 'CT' })).toBe(true);
  });

  it('classifies options from the isOption flag or OP type, even when the ticker is an equity symbol', () => {
    expect(classifyInstrument({ ticker: 'AAPL', isOption: true })).toBe('option');
    expect(classifyInstrument({ ticker: 'AAPL', isOption: 1 })).toBe('option');
    expect(classifyInstrument({ ticker: 'AAPL', assetType: 'OP' })).toBe('option');
    expect(canCaptureMinutePricing({ ticker: 'AAPL', isOption: true })).toBe(false);
  });

  it('classifies Kalshi / prediction-market labels as event contracts', () => {
    expect(isEventContractInstrument({ assetName: 'Kalshi Fed decision' })).toBe(true);
    expect(classifyInstrument({ ticker: 'FED', assetName: 'Kalshi event contract' })).toBe('event_contract');
    expect(classifyInstrument({ assetTypeName: 'Prediction market' })).toBe('event_contract');
    expect(canCaptureMinutePricing({ ticker: 'FED', assetName: 'Polymarket contract' })).toBe(false);
  });

  it('refuses minute pricing for bonds and unlabeled long tickers', () => {
    expect(classifyInstrument({ ticker: 'GS', assetType: 'GS', assetName: 'US Treasury Bill' })).toBe('other');
    expect(canCaptureMinutePricing({ ticker: 'GS', assetType: 'GS', assetName: 'US Treasury Bill' })).toBe(false);
    expect(canCaptureMinutePricing({ ticker: 'THIS-IS-NOT-A-TICKER' })).toBe(false);
    expect(canCaptureMinutePricing({ ticker: null })).toBe(false);
  });
});

describe('INSTRUMENT_CAPABILITY_LIST', () => {
  it('exposes the four product classes plus other, with event contracts having no minute PIT', () => {
    const byClass = Object.fromEntries(INSTRUMENT_CAPABILITY_LIST.map((c) => [c.class, c]));
    expect(byClass.equities_long.minutePricing).toBe('minute');
    expect(byClass.crypto.minutePricing).toBe('minute');
    expect(byClass.option.minutePricing).toBe('none');
    expect(byClass.event_contract.minutePricing).toBe('none');
    expect(byClass.event_contract.label).toMatch(/Kalshi/i);
    expect(capabilityForInstrument({ ticker: 'AAPL' }).class).toBe('equities_long');
  });
});

import { describe, expect, it } from 'vitest';
import { boundedLeadSec, detectionWindow } from '../probeRunLog.ts';

describe('detectionWindow', () => {
  it('brackets publication between the previous probe and the discovering probe', () => {
    const w = detectionWindow('2026-08-06T15:00:00Z', '2026-08-06T15:10:00Z');
    expect(w.confidence).toBe('bracketed');
    expect(w.start).toBe('2026-08-06T15:00:00Z');
    expect(w.end).toBe('2026-08-06T15:10:00Z');
    expect(w.widthSec).toBe(600);
  });

  it('is UNBOUNDED with no prior successful probe — a cold lane must not look fast', () => {
    const w = detectionWindow(null, '2026-08-06T15:10:00Z');
    expect(w.confidence).toBe('unbounded');
    expect(w.start).toBeNull();
    expect(w.widthSec).toBeNull();
  });

  it('treats clock skew (prev >= end) as unbounded rather than collapsing to zero width', () => {
    // The Mac scout and the server both write timestamps; a zero-width window is
    // the strongest possible claim and must never be produced by accident.
    const skewed = detectionWindow('2026-08-06T15:10:00Z', '2026-08-06T15:00:00Z');
    expect(skewed.confidence).toBe('unbounded');
    expect(skewed.widthSec).toBeNull();

    const identical = detectionWindow('2026-08-06T15:10:00Z', '2026-08-06T15:10:00Z');
    expect(identical.confidence).toBe('unbounded');
  });

  it('rejects unparseable timestamps instead of emitting NaN', () => {
    const w = detectionWindow('not-a-date', '2026-08-06T15:10:00Z');
    expect(w.confidence).toBe('unbounded');
    expect(w.widthSec).toBeNull();
  });
});

describe('boundedLeadSec', () => {
  it('reports a lead RANGE, using the pessimistic bound as the minimum', () => {
    // CT saw it at 14:00. A competitor probe at 15:00 missed it; 15:10 found it.
    // So they published in (15:00, 15:10] and our lead is between 60 and 70 min.
    const w = detectionWindow('2026-08-06T15:00:00Z', '2026-08-06T15:10:00Z');
    const lead = boundedLeadSec(w, '2026-08-06T14:00:00Z');
    expect(lead.atLeastSec).toBe(3600);
    expect(lead.atMostSec).toBe(4200);
  });

  it('claims NO minimum lead when the window is unbounded', () => {
    // This is the whole point: without a prior probe we cannot claim any lead.
    // Reporting one is the bug that produced the fictional 68.28h figures.
    const w = detectionWindow(null, '2026-08-06T15:10:00Z');
    const lead = boundedLeadSec(w, '2026-08-06T14:00:00Z');
    expect(lead.atLeastSec).toBeNull();
    expect(lead.atMostSec).toBe(4200);
  });

  it('returns negative bounds when the competitor published first', () => {
    const w = detectionWindow('2026-08-06T13:00:00Z', '2026-08-06T13:10:00Z');
    const lead = boundedLeadSec(w, '2026-08-06T14:00:00Z');
    expect(lead.atLeastSec).toBe(-3600);
    expect(lead.atMostSec).toBe(-3000);
  });
});

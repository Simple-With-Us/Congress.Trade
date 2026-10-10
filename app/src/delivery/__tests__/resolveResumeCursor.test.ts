/**
 * src/delivery/__tests__/resolveResumeCursor.test.ts
 *
 * Unit tests for the SSE resume-cursor precedence: explicit ?since= over the
 * EventSource Last-Event-ID header, falling back to undefined ("from start").
 */

import { describe, it, expect } from 'vitest';
import { resolveResumeCursor } from '../rest.ts';

describe('resolveResumeCursor', () => {
  it('returns undefined when neither source is provided', () => {
    expect(resolveResumeCursor(undefined, undefined)).toBeUndefined();
    expect(resolveResumeCursor('', '')).toBeUndefined();
  });

  it('honors the Last-Event-ID header when ?since= is absent', () => {
    expect(resolveResumeCursor(undefined, '42')).toBe(42);
  });

  it('prefers an explicit ?since= over the Last-Event-ID header', () => {
    expect(resolveResumeCursor('100', '42')).toBe(100);
  });

  it('treats an explicit since=0 as a real value (catch-up from cursor 0)', () => {
    expect(resolveResumeCursor('0', '42')).toBe(0);
  });

  it('falls back to the header when ?since= is non-numeric', () => {
    expect(resolveResumeCursor('abc', '42')).toBe(42);
  });

  it('ignores a non-numeric Last-Event-ID', () => {
    expect(resolveResumeCursor(undefined, 'not-a-number')).toBeUndefined();
  });
});

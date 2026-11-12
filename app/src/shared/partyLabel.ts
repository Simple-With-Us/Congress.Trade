/**
 * src/shared/partyLabel.ts
 *
 * One shared party-label formatter for every filer branch (House, Senate,
 * executive). Party is stored inconsistently depending on where it came
 * from: congress-legislators enrichment (runPhotoEnrichment, admin/routes.ts)
 * writes the spelled-out term the legislators dataset carries ("Democrat" /
 * "Republican" / "Independent"), while curated executive filers
 * (shared/executiveIdentity.ts CURATED_EXECUTIVES) hardcode a bare 'R' | 'D'
 * letter. Any surface that displays `filers.party` verbatim therefore shows
 * "Republican" next to "R" in the same table (e.g. the People directory —
 * see delivery/rest.ts GET /members). Route every such display through this
 * formatter instead of the raw column.
 */

/**
 * Normalize any party representation seen across ingestion sources to one
 * full-word label. Matches on the first letter after trimming, so it accepts
 * bare codes ('R', 'D', 'I') and already-spelled values ("Republican",
 * "Democratic", "Independent") alike and returns a single canonical spelling.
 * Anything that doesn't start with d/r/i is returned unchanged (never
 * invents a label for data this formatter doesn't recognize) and empty/
 * null input returns null so callers can render their own placeholder.
 */
export function formatPartyLabel(raw: string | null | undefined): string | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const first = trimmed.charAt(0).toUpperCase();
  if (first === 'D') return 'Democrat';
  if (first === 'R') return 'Republican';
  if (first === 'I') return 'Independent';
  return trimmed;
}

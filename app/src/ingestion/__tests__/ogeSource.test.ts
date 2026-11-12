import { describe, expect, it } from 'vitest';
import {
  fetchOgeExecutiveFilings,
  ogeDocId,
  ogeFiledDateFromName,
  parseOgeIndex,
  pollOgeExecutive,
} from '../ogeSource.ts';

/** Anchor markup lifted from the LIVE OGE President/VP index view (Domino
 *  renders single-quoted hrefs with raw spaces in filenames). */
const FIXTURE = `
<a href='/201/Presiden.nsf/PAS+Index/AA799A2729B4D1BE85258D430031A320/$FILE/Donald J. Trump 10.17.2025 278-T.pdf'>278-T</a>
<a href='/201/Presiden.nsf/PAS+Index/18353894FE440B3685258D430031A337/$FILE/Donald J. Trump 10.20.2025 278-T (2).pdf'>278-T</a>
<a href='/201/Presiden.nsf/PAS+Index/268353939B7DACB585258D81003471B1/$FILE/Donald-J-Trump 1.14.2026-278T.pdf'>278-T</a>
<a href='/201/Presiden.nsf/PAS+Index/322B8A28DB21CC9285258CFD002C0D0B/$FILE/Donald J. Trump 9.3.25 278-T.pdf'>278-T</a>
<a href='/201/Presiden.nsf/PAS+Index/4EC9A8E6DD078F2985258CA9002C9377/$FILE/Trump, Donald J. 2025 Annual 278.pdf'>Annual</a>
<a href='/201/Presiden.nsf/PAS+Index/69AEAA9D7455ACD585258E27002DDEE1/$FILE/Donald-J-Trump-2026-278ANNUAL.pdf'>Annual</a>
<a href='/201/Presiden.nsf/PAS+Index/66A69EB879848CF885258CC9002C8582/$FILE/Howard-Lutnick-06.17.2025-278T.pdf'>278-T</a>
<a href='/201/Presiden.nsf/PAS+Index/AA799A2729B4D1BE85258D430031A320/$FILE/Donald J. Trump 10.17.2025 278-T.pdf'>dup</a>
`;

describe('parseOgeIndex', () => {
  const filings = parseOgeIndex(FIXTURE);

  it('extracts all 278-T reports including curated PAS cabinet filers (no annuals, deduped)', () => {
    expect(filings).toHaveLength(5);
    expect(filings.every((f) => f.chamber === 'executive')).toBe(true);

    const trumpFilings = filings.filter((f) => f.filerId === 'EXEC-DJT');
    expect(trumpFilings).toHaveLength(4);
    expect(trumpFilings.every((f) => f.filerName === 'Donald J. Trump')).toBe(true);

    const lutnickFiling = filings.find((f) => f.filerName === 'Howard Lutnick');
    expect(lutnickFiling).toBeDefined();
    // Curated PAS cabinet slot (stable id), not dynamic EXEC-HOWARD-LUTNICK.
    expect(lutnickFiling?.filerId).toBe('EXEC-LUTNICK');
    expect(lutnickFiling?.party).toBe('R');
    expect(lutnickFiling?.filedDate).toBe('2025-06-17');

    const raw = JSON.stringify(filings);
    expect(raw).not.toContain('Annual');
  });

  it('carries curated party + official-portrait metadata for curated executive filers', () => {
    const trumpFilings = filings.filter((f) => f.filerId === 'EXEC-DJT');
    expect(trumpFilings.every((f) => f.party === 'R')).toBe(true);
    expect(trumpFilings.every((f) => f.photoUrl ===
      'https://upload.wikimedia.org/wikipedia/commons/thumb/1/16/Official_Presidential_Portrait_of_President_Donald_J._Trump_%282025%29.jpg/500px-Official_Presidential_Portrait_of_President_Donald_J._Trump_%282025%29.jpg',
    )).toBe(true);
  });

  it('builds direct, space-encoded download URLs on the OGE origin', () => {
    expect(filings[0].sourceUrl).toBe(
      'https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index/AA799A2729B4D1BE85258D430031A320/$FILE/Donald%20J.%20Trump%2010.17.2025%20278-T.pdf',
    );
  });

  it('derives stable doc ids and filed dates (incl. 2-digit years)', () => {
    expect(filings[0].docId).toBe('E-2025-donald-j-trump-10-17-2025-278-t');
    expect(filings[0].filedDate).toBe('2025-10-17');
    // "(2)" variant stays a distinct doc
    expect(filings[1].docId).not.toBe(filings[0].docId);
    // dotted 2-digit year
    expect(filings[3].filedDate).toBe('2025-09-03');
    expect(filings[2].filedDate).toBe('2026-01-14');
  });
});

describe('filename helpers', () => {
  it('parses both 4- and 2-digit year forms', () => {
    expect(ogeFiledDateFromName('Trump, Donald J.-05.08.2026-278T(2).pdf')).toBe('2026-05-08');
    expect(ogeFiledDateFromName('Donald J. Trump 9.3.25 278-T.pdf')).toBe('2025-09-03');
    expect(ogeFiledDateFromName('no-date-here.pdf')).toBeNull();
  });

  it('doc ids are slugged, bounded, and year-prefixed', () => {
    const id = ogeDocId('Trump, Donald J.-05.08.2026-278T(2).pdf');
    expect(id).toBe('E-2026-trump-donald-j-05-08-2026-278t-2');
    expect(id.length).toBeLessThanOrEqual(87);
  });
});

describe('pollOgeExecutive enablement (cadence lives in decideSourcePoll)', () => {
  const NOW = new Date('2026-07-18T12:00:00.000Z');

  function envWith(envVars: Record<string, string> = {}): any {
    return {
      ...envVars,
      OGE_WATCH_ENABLED: envVars.OGE_WATCH_ENABLED ?? 'true',
      CONFIG_KV: {
        async get() { return null; },
        async put() {},
      },
    };
  }

  function countingFetch(): { fetchImpl: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('<html>no matching filings</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  it('does not apply a flat 6h or 15m interval gate — leftover Infisical 21600 is unused', async () => {
    const env = envWith({ OGE_POLL_INTERVAL_SEC: '21600' });
    const { fetchImpl, calls } = countingFetch();

    const out = await pollOgeExecutive(env, NOW, fetchImpl);

    expect(out).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('skips when the watcher is disabled', async () => {
    const env = envWith({ OGE_WATCH_ENABLED: 'false' });
    const { fetchImpl, calls } = countingFetch();

    const out = await pollOgeExecutive(env, NOW, fetchImpl);

    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('force fetches even when the watcher is disabled', async () => {
    const env = envWith({ OGE_WATCH_ENABLED: 'false' });
    const { fetchImpl, calls } = countingFetch();

    const out = await pollOgeExecutive(env, NOW, fetchImpl, { force: true });

    expect(out).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});

describe('OGE fetch order (server-first, relay fallback)', () => {
  const INDEX = 'https://extapps2.oge.gov/201/Presiden.nsf/index';
  const RELAY = 'https://scout.jays.services';

  function env(): any {
    return {
      OGE_INDEX_URL: INDEX,
      OGE_RELAY_URL: RELAY,
    };
  }

  it('attempts direct extapps2 before the Mac relay', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input).includes('/fetch-oge')) throw new Error('relay should not run when direct succeeds');
      return new Response('<html>no matching filings</html>', { status: 200 });
    }) as typeof fetch;

    const out = await fetchOgeExecutiveFilings(env(), fetchImpl);

    expect(out).toEqual([]);
    expect(calls).toEqual([INDEX]);
  });

  it('falls back to the relay when direct fails', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/fetch-oge')) {
        return new Response(JSON.stringify({ body: '<html>no matching filings</html>' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('blocked', { status: 403 });
    }) as typeof fetch;

    const out = await fetchOgeExecutiveFilings(env(), fetchImpl);

    expect(out).toEqual([]);
    expect(calls[0]).toBe(INDEX);
    expect(calls[1]).toBe(`${RELAY}/fetch-oge`);
  });
});

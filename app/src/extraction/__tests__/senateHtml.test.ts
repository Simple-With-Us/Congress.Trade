import { describe, it, expect } from 'vitest';
import {
  SenateHtmlExtractor,
  normalizeTxType,
  normalizeOwner,
  normalizeTicker,
  normalizeDate,
  detectOption,
  detectCapGains,
} from '../senateHtml.ts';
import { normalizeOcrAssetName } from '../ocrSanity.ts';
import type { ExtractorInput } from '../../extractors/types.ts';
import type { Filing } from '../../shared/types.ts';

const filing = (over: Partial<Filing> = {}): Filing => ({
  docId: 'doc1',
  chamber: 'senate',
  filerId: 'F1',
  filingType: 'P',
  filedDate: '2024-07-01',
  sourceUrl: 'https://efdsearch.senate.gov/x',
  rawObjectKey: 'raw/senate/doc1.html',
  ingestStatus: 'classified',
  docKind: 'senate_html',
  extractor: null,
  modelVersion: null,
  confidence: null,
  firstSeenAt: '2024-07-01T00:00:00.000Z',
  sourceUpdatedAt: null,
  error: null,
  ...over,
});

// A canonical Senate eFD electronic-PTR table.
const SENATE_HTML = `
<html><body>
<table class="table report-data">
  <thead>
    <tr>
      <th>#</th><th>Transaction Date</th><th>Owner</th><th>Ticker</th>
      <th>Asset Name</th><th>Asset Type</th><th>Type</th><th>Amount</th><th>Comment</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>1</td><td>06/14/2024</td><td>Spouse</td><td>AAPL</td>
      <td>Apple Inc.</td><td>Stock</td><td>Purchase</td><td>$1,001 - $15,000</td><td>--</td>
    </tr>
    <tr>
      <td>2</td><td>06/20/2024</td><td>Self</td><td>MSFT</td>
      <td>Microsoft Corp - Call Option</td><td>Option</td><td>Sale (Full)</td><td>$15,001 - $50,000</td><td>--</td>
    </tr>
  </tbody>
</table>
</body></html>`;

describe('SenateHtmlExtractor', () => {
  it('canHandle only senate_html', () => {
    const ex = new SenateHtmlExtractor();
    expect(ex.canHandle(filing())).toBe(true);
    expect(ex.canHandle(filing({ docKind: 'text_pdf' }))).toBe(false);
  });

  it('parses the electronic PTR table into ParsedTx rows', async () => {
    const ex = new SenateHtmlExtractor();
    const input: ExtractorInput = { filing: filing(), html: SENATE_HTML };
    const result = await ex.extract(input);

    expect(result.extractor).toBe('senateHtml');
    expect(result.confidence).toBeGreaterThanOrEqual(0.95);
    expect(result.transactions).toHaveLength(2);

    const [r1, r2] = result.transactions;

    expect(r1.txDate).toBe('2024-06-14');
    expect(r1.owner).toBe('spouse');
    expect(r1.ticker).toBe('AAPL');
    expect(r1.assetName).toContain('Apple');
    expect(r1.assetType).toBe('Stock');
    expect(r1.assetTypeName).toBe('Stock');
    expect(r1.txType).toBe('B');
    expect(r1.amountMin).toBe(1001);
    expect(r1.amountMax).toBe(15000);
    expect(r1.isOption).toBe(false);

    expect(r2.owner).toBe('self');
    expect(r2.ticker).toBe('MSFT');
    expect(r2.txType).toBe('S');
    expect(r2.amountMin).toBe(15001);
    expect(r2.amountMax).toBe(50000);
    expect(r2.isOption).toBe(true);
  });

  it('splits eFD Company:/Description: detail lines out of assetName', async () => {
    // Shape of Senate PTR e67780bf (Blumenthal, filed 2026-10-26): private
    // partnership rows carry muted detail lines inside the Asset Name cell.
    const html = `<table class="table report-data"><thead><tr>
      <th>#</th><th>Transaction Date</th><th>Owner</th><th>Ticker</th>
      <th>Asset Name</th><th>Asset Type</th><th>Type</th><th>Amount</th><th>Comment</th>
    </tr></thead><tbody><tr>
      <td>8</td><td>09/21/2026</td><td>Spouse</td><td>--</td>
      <td>
        GCP Captivate Secondary LP
        <div class="text-muted"><em>Company:</em> Captivate Network
          &nbsp;(New York, NY)
        </div>
        <div class="text-muted"><em>Description:</em>&nbsp;Media Company</div>
      </td>
      <td>Other</td><td>Sale (Full)</td><td>$500,001 - $1,000,000</td>
      <td>Underlying Asset of Peter L. Malkin Family 2000 LLC</td>
    </tr></tbody></table>`;
    const result = await new SenateHtmlExtractor().extract({ filing: filing(), html });
    expect(result.transactions).toHaveLength(1);
    const [r] = result.transactions;
    expect(r.assetName).toBe('GCP Captivate Secondary LP');
    expect(r.description).toBe('Company: Captivate Network (New York, NY); Description: Media Company');
    expect(r.txType).toBe('S');
    expect(r.amountMin).toBe(500001);
    expect(r.rawText).toContain('Company:');
    expect(normalizeOcrAssetName(r.assetName).nameHolds).toEqual([]);
    // The split must not mutate the tree that is serialized into raw.
    expect(result.raw).toContain('Company:');
    expect(result.raw).toContain('Description:');
    expect(result.raw).toContain('Media Company');
  });

  it('does not restore the polluted name when the cell holds only muted detail lines', async () => {
    const html = `<table class="table report-data"><thead><tr>
      <th>#</th><th>Transaction Date</th><th>Owner</th><th>Ticker</th>
      <th>Asset Name</th><th>Asset Type</th><th>Type</th><th>Amount</th><th>Comment</th>
    </tr></thead><tbody><tr>
      <td>9</td><td>09/21/2026</td><td>Spouse</td><td>--</td>
      <td>
        <div class="text-muted"><em>Company:</em> Only Detail Co (Austin, TX)</div>
        <div class="text-muted"><em>Description:</em> Partnership</div>
      </td>
      <td>Other</td><td>Sale (Full)</td><td>$1,001 - $15,000</td><td>--</td>
    </tr></tbody></table>`;
    const result = await new SenateHtmlExtractor().extract({ filing: filing(), html });
    expect(result.transactions).toHaveLength(1);
    const [r] = result.transactions;
    expect(r.assetName).not.toContain(':');
    expect(r.description).toBe('Company: Only Detail Co (Austin, TX); Description: Partnership');
  });

  it('returns low confidence when no transaction table is present', async () => {
    const ex = new SenateHtmlExtractor();
    const result = await ex.extract({ filing: filing(), html: '<html><body><p>nope</p></body></html>' });
    expect(result.transactions).toHaveLength(0);
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe('field normalizers', () => {
  it('maps tx-type labels to P/S/E', () => {
    expect(normalizeTxType('Purchase')).toBe('B');
    expect(normalizeTxType('Sale (Partial)')).toBe('S');
    expect(normalizeTxType('Exchange')).toBe('E');
    expect(normalizeTxType('P')).toBe('B');
    expect(normalizeTxType('')).toBeNull();
  });

  it('maps owner codes incl. Child -> dependent', () => {
    expect(normalizeOwner('Spouse')).toBe('spouse');
    expect(normalizeOwner('Joint')).toBe('joint');
    expect(normalizeOwner('Child')).toBe('dependent');
    expect(normalizeOwner('Self')).toBe('self');
    expect(normalizeOwner('')).toBeNull();
  });

  it('cleans tickers and drops placeholders', () => {
    expect(normalizeTicker(' aapl ')).toBe('AAPL');
    expect(normalizeTicker('JPM^J')).toBe('JPM^J');
    expect(normalizeTicker('--')).toBeNull();
    expect(normalizeTicker('N/A')).toBeNull();
  });

  it('converts MM/DD/YYYY to ISO', () => {
    expect(normalizeDate('06/14/2024')).toBe('2024-06-14');
    expect(normalizeDate('2024-06-14')).toBe('2024-06-14');
    expect(normalizeDate('')).toBeNull();
  });

  it('detects options and cap-gains flag', () => {
    expect(detectOption('Apple Inc Call Option')).toBe(true);
    expect(detectOption('Apple Inc')).toBe(false);
    expect(detectCapGains('Yes', '')).toBe(true);
    expect(detectCapGains('No', '')).toBe(false);
  });
});

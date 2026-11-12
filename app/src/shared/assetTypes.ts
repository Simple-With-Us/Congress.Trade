/**
 * Shared instrument-type canonicalization.
 *
 * Keep raw disclosure values in transactions.asset_type / asset_type_name, then
 * compute this layer at read/export time so House bracket codes and Senate eFD
 * labels can roll up together without erasing provenance.
 */

import type { AssetTypeCategory } from '@jaywedgeworth22/congress-trading-shared';
export type { AssetTypeCategory };

export type AssetTypeSource = 'house_code' | 'label' | 'option_flag' | 'missing' | 'unknown';

export interface CanonicalAssetType {
  rawType: string | null;
  rawName: string | null;
  code: string | null;
  label: string;
  category: AssetTypeCategory;
  categoryLabel: string;
  source: AssetTypeSource;
}

export const HOUSE_ASSET_TYPE_NAMES: Record<string, string> = {
  '4K': '401K and Other Non-Federal Retirement Accounts',
  '5C': '529 College Savings Plan',
  '5F': '529 Portfolio',
  '5P': '529 Prepaid Tuition Plan',
  AB: 'Asset-Backed Securities',
  BA: 'Bank Accounts, Money Market Accounts and CDs',
  BK: 'Brokerage Accounts',
  CO: 'Collectibles',
  CS: 'Corporate Securities (Bonds and Notes)',
  CT: 'Cryptocurrency',
  DB: 'Defined Benefit Pension',
  DO: 'Debts Owed to the Filer',
  DS: 'Delaware Statutory Trust',
  EF: 'Exchange Traded Funds (ETF)',
  EQ: 'Excepted/Qualified Blind Trust',
  ET: 'Exchange Traded Notes',
  FA: 'Farms',
  FE: 'Foreign Exchange Position (Currency)',
  FN: 'Fixed Annuity',
  FU: 'Futures',
  GS: 'Government Securities and Agency Debt',
  HE: 'Hedge Funds & Private Equity Funds (EIF)',
  HN: 'Hedge Funds & Private Equity Funds (non-EIF)',
  IC: 'Investment Club',
  IH: 'IRA (Held in Cash)',
  IP: 'Intellectual Property & Royalties',
  IR: 'IRA',
  MA: 'Managed Accounts (e.g., SMA and UMA)',
  MF: 'Mutual Funds',
  MO: 'Mineral/Oil/Solar Energy Rights',
  OI: 'Ownership Interest (Holding Investments)',
  OL: 'Ownership Interest (Engaged in a Trade or Business)',
  OP: 'Options',
  OT: 'Other',
  PE: 'Pensions',
  PM: 'Precious Metals',
  PS: 'Stock (Not Publicly Traded)',
  RE: 'Real Estate Invest. Trust (REIT)',
  RF: 'REIT (EIF)',
  RN: 'REIT (non-EIF)',
  RP: 'Real Property',
  RS: 'Restricted Stock Units (RSUs)',
  SA: 'Stock Appreciation Right',
  ST: 'Stocks (including ADRs)',
  TR: 'Trust',
  VA: 'Variable Annuity',
  VI: 'Variable Insurance',
  WU: 'Whole/Universal Insurance',
};

export const HOUSE_ASSET_TYPE_CATEGORIES: Record<string, AssetTypeCategory> = {
  '4K': 'retirement_or_529',
  '5C': 'retirement_or_529',
  '5F': 'retirement_or_529',
  '5P': 'retirement_or_529',
  AB: 'fixed_income_asset_backed',
  BA: 'cash',
  BK: 'cash',
  CO: 'commodity_collectible',
  CS: 'fixed_income_corporate',
  CT: 'crypto',
  DB: 'retirement_or_529',
  DO: 'receivable',
  DS: 'trust',
  EF: 'fund',
  EQ: 'trust',
  ET: 'fund',
  FA: 'commodity_collectible',
  FE: 'derivative',
  FN: 'insurance_annuity',
  FU: 'derivative',
  GS: 'fixed_income_government',
  HE: 'private_fund',
  HN: 'private_fund',
  IC: 'business_interest',
  IH: 'retirement_or_529',
  IP: 'intellectual_property',
  IR: 'retirement_or_529',
  MA: 'fund',
  MF: 'fund',
  MO: 'commodity_collectible',
  OI: 'business_interest',
  OL: 'business_interest',
  OP: 'option',
  OT: 'other',
  PE: 'retirement_or_529',
  PM: 'commodity_collectible',
  PS: 'private_equity',
  RE: 'real_estate',
  RF: 'real_estate',
  RN: 'real_estate',
  RP: 'real_estate',
  RS: 'derivative',
  SA: 'derivative',
  ST: 'public_equity',
  TR: 'trust',
  VA: 'insurance_annuity',
  VI: 'insurance_annuity',
  WU: 'insurance_annuity',
};

export const ASSET_TYPE_CATEGORY_LABELS: Record<AssetTypeCategory, string> = {
  public_equity: 'Public Equity',
  private_equity: 'Private Equity',
  option: 'Options',
  fund: 'Funds / ETFs / REITs',
  fixed_income_government: 'Government / Municipal Debt',
  fixed_income_corporate: 'Corporate Debt',
  fixed_income_asset_backed: 'Asset-Backed Securities',
  cash: 'Cash / Bank Accounts',
  retirement_or_529: 'Retirement / 529 Accounts',
  real_estate: 'Real Estate',
  private_fund: 'Private Funds',
  business_interest: 'Business Interests',
  crypto: 'Crypto',
  insurance_annuity: 'Insurance / Annuities',
  trust: 'Trusts',
  commodity_collectible: 'Commodities / Collectibles',
  derivative: 'Derivatives / Rights',
  intellectual_property: 'Intellectual Property',
  receivable: 'Receivables',
  other_security: 'Other Securities',
  other: 'Other',
  unknown: 'Unknown',
};

const LABEL_CATEGORY_ALIASES: Record<string, AssetTypeCategory> = {
  '401k and other non federal retirement accounts': 'retirement_or_529',
  '401k and other non-federal retirement accounts': 'retirement_or_529',
  '529 college savings plan': 'retirement_or_529',
  '529 portfolio': 'retirement_or_529',
  '529 prepaid tuition plan': 'retirement_or_529',
  'asset backed securities': 'fixed_income_asset_backed',
  'asset-backed securities': 'fixed_income_asset_backed',
  'bank accounts money market accounts and cds': 'cash',
  'brokerage accounts': 'cash',
  cash: 'cash',
  cd: 'cash',
  cds: 'cash',
  collectibles: 'commodity_collectible',
  'corporate bond': 'fixed_income_corporate',
  'corporate bonds': 'fixed_income_corporate',
  'corporate debt': 'fixed_income_corporate',
  'corporate securities bonds and notes': 'fixed_income_corporate',
  cryptocurrency: 'crypto',
  crypto: 'crypto',
  'defined benefit pension': 'retirement_or_529',
  'debts owed to the filer': 'receivable',
  'delaware statutory trust': 'trust',
  'exchange traded funds etf': 'fund',
  etf: 'fund',
  'exchange traded notes': 'fund',
  etn: 'fund',
  'excepted qualified blind trust': 'trust',
  farms: 'commodity_collectible',
  'foreign exchange position currency': 'derivative',
  'fixed annuity': 'insurance_annuity',
  futures: 'derivative',
  'government securities and agency debt': 'fixed_income_government',
  'municipal security': 'fixed_income_government',
  muni: 'fixed_income_government',
  'government municipal debt': 'fixed_income_government',
  'hedge funds private equity funds eif': 'private_fund',
  'hedge funds private equity funds non eif': 'private_fund',
  'private fund': 'private_fund',
  'private funds': 'private_fund',
  'investment club': 'business_interest',
  'ira held in cash': 'retirement_or_529',
  ira: 'retirement_or_529',
  'intellectual property royalties': 'intellectual_property',
  'managed accounts e g sma and uma': 'fund',
  'managed accounts sma and uma': 'fund',
  'mutual funds': 'fund',
  'mutual fund': 'fund',
  'mineral oil solar energy rights': 'commodity_collectible',
  'ownership interest holding investments': 'business_interest',
  'ownership interest engaged in a trade or business': 'business_interest',
  option: 'option',
  options: 'option',
  'stock option': 'option',
  'other securities': 'other_security',
  other: 'other',
  pensions: 'retirement_or_529',
  pension: 'retirement_or_529',
  'precious metals': 'commodity_collectible',
  'stock not publicly traded': 'private_equity',
  'non public stock': 'private_equity',
  'non-public stock': 'private_equity',
  'real estate invest trust reit': 'real_estate',
  reit: 'real_estate',
  'reit eif': 'real_estate',
  'reit non eif': 'real_estate',
  'real property': 'real_estate',
  'restricted stock units rsus': 'derivative',
  rsu: 'derivative',
  rsus: 'derivative',
  'stock appreciation right': 'derivative',
  stock: 'public_equity',
  stocks: 'public_equity',
  'stocks including adrs': 'public_equity',
  equity: 'public_equity',
  trust: 'trust',
  'variable annuity': 'insurance_annuity',
  'variable insurance': 'insurance_annuity',
  'whole universal insurance': 'insurance_annuity',
};

const UNKNOWN_LABELS = new Set(['', 'unknown', 'pdf disclosed filing', 'n/a', 'n a', 'na', '--', '-']);

export function houseAssetTypeCodePattern(): string {
  return Object.keys(HOUSE_ASSET_TYPE_NAMES).sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
}

export function assetTypeCategoryLabel(category: AssetTypeCategory): string {
  return ASSET_TYPE_CATEGORY_LABELS[category] ?? ASSET_TYPE_CATEGORY_LABELS.unknown;
}

export function isAssetTypeCategory(value: string | null | undefined): value is AssetTypeCategory {
  return !!value && Object.prototype.hasOwnProperty.call(ASSET_TYPE_CATEGORY_LABELS, value);
}

/**
 * Infer a House bracket code when the model left assetType blank but the
 * disclosed asset name / raw text still carries a clear type signal.
 * Examples: "3M Company Common Stock (MMM)" → ST; trailing "[ST]" → ST.
 * Never invent a code from a weak signal — return null when unsure.
 */
export function inferHouseAssetTypeCode(
  rawType: string | null | undefined,
  opts?: {
    assetTypeName?: string | null;
    assetName?: string | null;
    rawText?: string | null;
    isOption?: boolean | null;
  },
): { code: string; label: string } | null {
  const existing = cleanNullable(rawType)?.toUpperCase() ?? null;
  if (existing && HOUSE_ASSET_TYPE_NAMES[existing]) {
    return { code: existing, label: HOUSE_ASSET_TYPE_NAMES[existing] };
  }

  const typeNameKey = normalizeAssetTypeKey(opts?.assetTypeName ?? rawType);
  // Explicit type labels beat the isOption flag (a stock row can also mark
  // option-like footnotes; prefer the disclosed label when present).
  if (typeNameKey === 'stock option' || typeNameKey === 'option' || typeNameKey === 'options') {
    return { code: 'OP', label: HOUSE_ASSET_TYPE_NAMES.OP };
  }
  if (typeNameKey === 'stock' || typeNameKey === 'stocks' || typeNameKey === 'stocks including adrs') {
    return { code: 'ST', label: HOUSE_ASSET_TYPE_NAMES.ST };
  }

  const haystack = [opts?.assetTypeName, opts?.assetName, opts?.rawText]
    .map((v) => cleanNullable(v) ?? '')
    .filter(Boolean)
    .join(' \n ');
  if (!haystack) {
    if (opts?.isOption) return { code: 'OP', label: HOUSE_ASSET_TYPE_NAMES.OP };
    return null;
  }

  const bracket = /\[([A-Z0-9]{2,3})\]/.exec(haystack.toUpperCase());
  if (bracket && HOUSE_ASSET_TYPE_NAMES[bracket[1]]) {
    return { code: bracket[1], label: HOUSE_ASSET_TYPE_NAMES[bracket[1]] };
  }

  // House PDFs often put the type only in the asset line ("… Common Stock").
  if (/\bcommon\s+stocks?\b/i.test(haystack) || /\bstocks?\s*\(including\s+adrs?\)/i.test(haystack)) {
    return { code: 'ST', label: HOUSE_ASSET_TYPE_NAMES.ST };
  }
  if (/\bexchange[\s-]?traded\s+fund\b|\betf\b/i.test(haystack)) {
    return { code: 'EF', label: HOUSE_ASSET_TYPE_NAMES.EF };
  }
  if (/\bmutual\s+fund\b/i.test(haystack)) {
    return { code: 'MF', label: HOUSE_ASSET_TYPE_NAMES.MF };
  }

  if (opts?.isOption) return { code: 'OP', label: HOUSE_ASSET_TYPE_NAMES.OP };
  return null;
}

export function canonicalizeAssetType(
  rawType: string | null | undefined,
  rawName?: string | null,
  opts?: {
    isOption?: boolean | null;
    assetName?: string | null;
    rawText?: string | null;
  },
): CanonicalAssetType {
  const inferred = inferHouseAssetTypeCode(rawType, {
    assetTypeName: rawName,
    assetName: opts?.assetName,
    rawText: opts?.rawText,
    isOption: opts?.isOption,
  });
  const type = cleanNullable(rawType) ?? inferred?.code ?? null;
  const name = cleanNullable(rawName) ?? (inferred && !cleanNullable(rawName) ? inferred.label : null);
  const upper = type?.toUpperCase() ?? null;

  if (upper && HOUSE_ASSET_TYPE_NAMES[upper]) {
    const category = HOUSE_ASSET_TYPE_CATEGORIES[upper] ?? 'other';
    return {
      rawType: type,
      rawName: name,
      code: upper,
      label: HOUSE_ASSET_TYPE_NAMES[upper],
      category,
      categoryLabel: assetTypeCategoryLabel(category),
      source: 'house_code',
    };
  }

  for (const value of [name, type, opts?.assetName ?? null]) {
    if (isUnknownAssetTypeValue(value)) {
      return canonical('unknown', type, name, value, 'missing');
    }
    const key = normalizeAssetTypeKey(value);
    if (!key) continue;
    const category = LABEL_CATEGORY_ALIASES[key];
    if (category) return canonical(category, type, name, value, 'label');
  }

  if (opts?.isOption) return canonical('option', type, name, type ?? name ?? 'Option', 'option_flag');
  if (!type && !name) return canonical('unknown', null, null, null, 'missing');
  return canonical('other', type, name, type ?? name, 'unknown');
}

export function canonicalAssetTypeCategorySql(
  rawTypeExpr: string,
  rawNameExpr = 'NULL',
  isOptionExpr?: string,
): string {
  const raw = `lower(trim(coalesce(${rawTypeExpr}, '')))`;
  const name = `lower(trim(coalesce(${rawNameExpr}, '')))`;
  const upper = `upper(trim(coalesce(${rawTypeExpr}, '')))`;
  const optionFlag = isOptionExpr ? `WHEN ${isOptionExpr} = 1 THEN 'option'` : '';
  const houseWhen = Object.entries(HOUSE_ASSET_TYPE_CATEGORIES)
    .map(([code, category]) => `WHEN ${upper} = ${sqlQuote(code)} THEN ${sqlQuote(category)}`)
    .join(' ');
  const houseLabelWhen = Object.entries(HOUSE_ASSET_TYPE_CATEGORIES)
    .map(([code, category]) => {
      const label = HOUSE_ASSET_TYPE_NAMES[code].toLowerCase();
      return `WHEN ${raw} = ${sqlQuote(label)} OR ${name} = ${sqlQuote(label)} THEN ${sqlQuote(category)}`;
    })
    .join(' ');
  const labelWhen = Object.entries(LABEL_CATEGORY_ALIASES)
    .map(
      ([label, category]) =>
        `WHEN ${raw} = ${sqlQuote(label)} OR ${name} = ${sqlQuote(label)} THEN ${sqlQuote(category)}`,
    )
    .join(' ');
  const unknownWhen = Array.from(UNKNOWN_LABELS)
    .filter(Boolean)
    .map((label) => `${raw} = ${sqlQuote(label)} OR ${name} = ${sqlQuote(label)}`)
    .join(' OR ');
  const unknownCase = unknownWhen ? `WHEN ${unknownWhen} THEN 'unknown'` : '';
  return `(CASE ${houseWhen} ${houseLabelWhen} ${labelWhen} ${unknownCase} ${optionFlag} WHEN ${raw} = '' AND ${name} = '' THEN 'unknown' ELSE 'other' END)`;
}

function canonical(
  category: AssetTypeCategory,
  rawType: string | null,
  rawName: string | null,
  label: string | null | undefined,
  source: AssetTypeSource,
): CanonicalAssetType {
  const categoryLabel = assetTypeCategoryLabel(category);
  return {
    rawType,
    rawName,
    code: null,
    label: cleanNullable(label) ?? categoryLabel,
    category,
    categoryLabel,
    source,
  };
}

function normalizeAssetTypeKey(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUnknownAssetTypeValue(value: string | null | undefined): boolean {
  if (value == null) return false;
  const raw = value.trim().toLowerCase();
  if (UNKNOWN_LABELS.has(raw)) return true;
  const key = normalizeAssetTypeKey(value);
  return key ? UNKNOWN_LABELS.has(key) : false;
}

function cleanNullable(value: string | null | undefined): string | null {
  const cleaned = (value ?? '').trim();
  return cleaned ? cleaned : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** True when `value` is a House PTR instrument-type code (GS, ST, CS, …). */
export function isHouseAssetTypeCode(value: string | null | undefined): boolean {
  const code = (value ?? '').trim().toUpperCase();
  return code !== '' && Object.prototype.hasOwnProperty.call(HOUSE_ASSET_TYPE_NAMES, code);
}

/**
 * House type codes that also happen to be listed tickers (GS, ST, BA, …).
 * Only treat the ticker as a misfiled type code when the asset *name*
 * describes that instrument class — a real Goldman Sachs row named
 * "Goldman Sachs" keeps ticker GS.
 */
const HOUSE_TYPE_NAME_HINTS: Record<string, RegExp> = {
  GS: /\b(treasury|t[\s-]?bill|t[\s-]?note|t[\s-]?bond|us treas|united states treas|government securit|agency (?:debt|bond)|muni(?:cipal)?)\b/i,
  CS: /\b(note|bond|debenture|corp(?:orate)? securit)\b/i,
  CT: /\b(crypto|bitcoin|ethereum|\bbtc\b|\beth\b)\b/i,
  HN: /\b(l\.?p\.?|llc|partners|private equity|hedge fund|venture)\b/i,
  HE: /\b(l\.?p\.?|llc|partners|private equity|hedge fund|venture)\b/i,
  OT: /\b(option|call|put)\b/i,
  OP: /\b(option|call|put)\b/i,
  BA: /\b(money market|certificate of deposit|\bcd\b|bank account|cash)\b/i,
  MF: /\b(mutual fund)\b/i,
  EF: /\b(etf|exchange traded)\b/i,
};

/**
 * Models routinely copy the House PTR type column (GS/ST/CS/…) into `ticker`.
 * Prod H-2025-20026666: four successful reads of the same T-bill, split into
 * GS|date|B vs TREASURY BILL|date|B because one model used GS as the ticker.
 */
export function tickerIsMisfiledHouseTypeCode(
  ticker: string | null | undefined,
  assetType: string | null | undefined,
  assetName: string | null | undefined,
): boolean {
  const t = (ticker ?? '').trim().toUpperCase();
  if (!isHouseAssetTypeCode(t)) return false;
  const hint = HOUSE_TYPE_NAME_HINTS[t];
  if (hint && hint.test(assetName ?? '')) return true;
  const at = (assetType ?? '').trim().toUpperCase();
  // Same code in both columns AND no conflicting type hint is still a
  // type-column echo when the name is long descriptive text, not a symbol.
  if (at === t && (assetName ?? '').trim().length >= 24) return true;
  return false;
}

/** Purchase/sale letters that leak into assetType from the tx-type column. */
export function assetTypeLooksLikeTxType(value: string | null | undefined): boolean {
  const at = (value ?? '').trim().toUpperCase();
  return at === 'B' || at === 'S' || at === 'E' || at === 'P';
}

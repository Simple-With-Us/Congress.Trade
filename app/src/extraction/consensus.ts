/**
 * src/extraction/consensus.ts
 *
 * Pure, I/O-free consensus voting over the SAME document read by several
 * extraction models. Given each model's ParsedTx[] (the row shape produced by
 * the bake-off's runCandidateOnDoc), this module aligns rows across models on
 * the shared stable row key (ticker|date|type|owner — {@link arbitrationRowKey}) and
 * occurrence within that key, then votes every material field to a majority
 * value so a reviewer sees exactly where the models agree and diverge.
 *
 * Voting contract:
 *   - Rows are matched across models by arbitrationRowKey + occurrence. Duplicate
 *     lots are never collapsed: two disclosure rows with the same ticker/date/type
 *     remain two independently reviewable rows.
 *   - Each material field is voted independently; AMOUNT is voted as the
 *     (amountMin, amountMax) BRACKET PAIR so a min from one model is never mixed
 *     with a max from another.
 *   - A field needs a STRICT majority of the models that saw the row
 *     (votes * 2 > present) to reach a consensus value; anything short of that —
 *     a tie (1-1, 2-2) or a mere plurality — is contested with value = null.
 *   - A row seen by only a minority of the models is contested regardless of
 *     field agreement (a minority reading isn't authoritative).
 *
 * Deterministic: rows are emitted sorted by row key; model lists and dissenters
 * are sorted by model id.
 */

import type { ParsedTx } from '../shared/types.ts';
import { arbitrationRowKey } from '../extractors/types.ts';
import { prepareExtractedRows } from './prepareTx.ts';

/** One model's reading of the document. */
export interface ConsensusRun {
  /** Stable identifier for the model/run, e.g. "gemini:gemini-3.5-flash". */
  model: string;
  /** The rows this model extracted (pre-normalization ParsedTx). */
  rows: ParsedTx[];
}

/** The voted-on fields. AMOUNT is the (min,max) bracket, voted as one unit. */
export type ConsensusFieldName =
  | 'txType'
  | 'transactionDate'
  | 'owner'
  | 'assetName'
  | 'ticker'
  | 'assetType'
  | 'assetTypeName'
  | 'isOption'
  | 'capGainsOver200'
  | 'filingStatus'
  | 'subholding'
  | 'location'
  | 'description'
  | 'supplementalText'
  | 'amount';

/** The amount bracket, voted as a single unit (never mix a min with a max). */
export interface AmountBracket {
  amountMin: number | null;
  amountMax: number | null;
}

/** The value a model produced for a field: scalar, amount bracket, or null. */
export type FieldValue = string | boolean | AmountBracket | null;

/** A single model's value for a field, when it differs from the winner. */
export interface Dissenter {
  model: string;
  value: FieldValue;
}

/** Per-field vote outcome. */
export interface FieldConsensus {
  /** Winning value, or null when there is no strict majority (tie/plurality). */
  value: FieldValue;
  /** Models backing the winner (the largest bloc's size when contested). */
  votes: number;
  /** Models that saw this row — the electorate for the field. */
  total: number;
  /**
   * Present models whose value differs from the winner. When contested (no
   * majority), EVERY present model is listed so all competing values are shown.
   */
  dissenters: Dissenter[];
  /** True iff every present model agreed (votes === total). */
  unanimous: boolean;
}

/** How strongly the models agree on a single reconciled row. */
export type RowConsensus = 'unanimous' | 'majority' | 'contested';

export interface ConsensusRow {
  /** Unique display key. Duplicate lots use `${baseRowKey}#N`. */
  rowKey: string;
  /** ticker-or-name|date|type key shared by every occurrence of this lot. */
  baseRowKey: string;
  /** One-based occurrence within baseRowKey, preserving source row order. */
  occurrence: number;
  /** Model ids that produced this row, sorted. */
  presentIn: string[];
  /** Model ids that did NOT produce this row, sorted. */
  missingFrom: string[];
  fields: Record<ConsensusFieldName, FieldConsensus>;
  rowConsensus: RowConsensus;
}

export interface ConsensusSummary {
  /** Distinct model ids that participated, sorted. */
  models: string[];
  rowsUnanimous: number;
  rowsMajority: number;
  rowsContested: number;
  /** Mean per-row agreement (votes/total) for each field, as a 0–100 percentage. */
  perFieldAgreementPct: Record<ConsensusFieldName, number>;
}

export interface ConsensusResult {
  rows: ConsensusRow[];
  summary: ConsensusSummary;
}

const FIELD_NAMES: ConsensusFieldName[] = [
  'txType',
  'transactionDate',
  'owner',
  'assetName',
  'ticker',
  'assetType',
  'assetTypeName',
  'isOption',
  'capGainsOver200',
  'filingStatus',
  'subholding',
  'location',
  'description',
  'supplementalText',
  'amount',
];

const NORM_CACHE = new Map<string, string>();

/** Collapse a string to its comparison form: trimmed, upper-cased, whitespace-collapsed. */
function normStr(s: string | null | undefined): string {
  if (!s) return '';
  const cached = NORM_CACHE.get(s);
  if (cached !== undefined) return cached;
  const res = s.trim().toUpperCase().replace(/\s+/g, ' ');
  if (NORM_CACHE.size > 10000) NORM_CACHE.clear(); // simple bound
  NORM_CACHE.set(s, res);
  return res;
}

/** Raw display value for a field on a row (what the model actually produced). */
function rawFieldValue(tx: ParsedTx, field: ConsensusFieldName): FieldValue {
  switch (field) {
    case 'txType':
      return tx.txType;
    case 'transactionDate':
      return tx.txDate;
    case 'owner':
      return tx.owner;
    case 'assetName':
      return tx.assetName;
    case 'ticker':
      return tx.ticker;
    case 'assetType':
      return tx.assetType;
    case 'assetTypeName':
      return tx.assetTypeName ?? null;
    case 'isOption':
      return tx.isOption;
    case 'capGainsOver200':
      return tx.capGainsOver200;
    case 'filingStatus':
      return tx.filingStatus ?? null;
    case 'subholding':
      return tx.subholding ?? null;
    case 'location':
      return tx.location ?? null;
    case 'description':
      return tx.description ?? null;
    case 'supplementalText':
      return tx.supplementalText ?? null;
    case 'amount':
      return { amountMin: tx.amountMin, amountMax: tx.amountMax };
  }
}

/** Comparison key for a field value — the bracket pair is keyed as a single unit. */
function fieldVoteKey(tx: ParsedTx, field: ConsensusFieldName): string {
  if (field === 'amount') {
    return `${tx.amountMin ?? ''}|${tx.amountMax ?? ''}`;
  }
  const value = rawFieldValue(tx, field);
  return typeof value === 'boolean' ? String(value) : normStr(value as string | null);
}

/** Stable ascending comparator for model-id strings. */
function byModel(a: { model: string }, b: { model: string }): number {
  return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
}

/** Preserve every lot while grouping each model's rows by arbitration key. */
function groupRunRows(rows: ParsedTx[]): Map<string, ParsedTx[]> {
  const byKey = new Map<string, ParsedTx[]>();
  for (const tx of rows) {
    const key = arbitrationRowKey(tx);
    const group = byKey.get(key) ?? [];
    group.push(tx);
    byKey.set(key, group);
  }
  return byKey;
}

/** Vote one field across the models that saw a row. */
function voteField(
  present: Array<{ model: string; tx: ParsedTx }>,
  field: ConsensusFieldName,
): FieldConsensus {
  const total = present.length;

  // Tally votes by comparison key, remembering each key's raw value + backers.
  // Insertion order follows `present` (the runs order), so the retained raw
  // value is deterministic for identical input.
  const blocs = new Map<string, { rawValue: FieldValue; models: string[] }>();
  for (const { model, tx } of present) {
    const key = fieldVoteKey(tx, field);
    let bloc = blocs.get(key);
    if (!bloc) {
      bloc = { rawValue: rawFieldValue(tx, field), models: [] };
      blocs.set(key, bloc);
    }
    bloc.models.push(model);
  }
  
  const isPlaceholderKey = (k: string) =>
    field === 'amount' && (!k || k === '|' || k === 'N/A' || k === '-' || k === 'UNKNOWN');
  let hasValid = false;
  let invalidVotes = 0;
  for (const [key, bloc] of blocs.entries()) {
    if (!isPlaceholderKey(key)) {
      hasValid = true;
    } else {
      invalidVotes += bloc.models.length;
    }
  }

  // Largest bloc, ties broken by sorted vote key for determinism.
  let top: { rawValue: FieldValue; models: string[] } | null = null;
  let secondVotes = 0;
  
  const sortedBlocs = [...blocs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [key, bloc] of sortedBlocs) {
    if (hasValid && isPlaceholderKey(key)) continue; // exclude from winning
    
    if (!top || bloc.models.length > top.models.length) {
      secondVotes = top ? top.models.length : 0;
      top = { rawValue: bloc.rawValue, models: bloc.models };
    } else if (bloc.models.length > secondVotes) {
      secondVotes = bloc.models.length;
    }
  }
  
  const topVotes = top ? top.models.length : 0;
  const effectiveTotal = hasValid ? total - invalidVotes : total;
  
  const hasMajority = topVotes * 2 > effectiveTotal;
  const uniquePlurality = topVotes >= 2 && topVotes > secondVotes;
  const allowPlurality =
    field === 'assetName'
    || field === 'assetType'
    || field === 'assetTypeName'
    || field === 'subholding'
    || field === 'location'
    || field === 'description'
    || field === 'supplementalText';

  if ((hasMajority || (allowPlurality && uniquePlurality)) && top) {
    const winners = new Set(top.models);
    const dissenters = present
      .filter((p) => !winners.has(p.model))
      .map((p) => ({ model: p.model, value: rawFieldValue(p.tx, field) }))
      .sort(byModel);
    return {
      value: top.rawValue,
      votes: topVotes,
      total: effectiveTotal,
      dissenters,
      unanimous: topVotes === total,
    };
  }

  // No strict majority -> contested: value null, every present value listed.
  const dissenters = present
    .map((p) => ({ model: p.model, value: rawFieldValue(p.tx, field) }))
    .sort(byModel);
  return { value: null, votes: topVotes, total: effectiveTotal, dissenters, unanimous: false };
}

/**
 * Build the reconciled consensus rows + summary from each model's reading of a
 * single document. Pure — no I/O.
 */
const IDENTITY_FIELDS: ConsensusFieldName[] = [
  'txType',
  'transactionDate',
  'owner',
  'ticker',
  'isOption',
  'capGainsOver200',
  'filingStatus',
  'amount',
];

function fieldAuthoritative(field: ConsensusFieldName, fc: FieldConsensus): boolean {
  if (fc.total <= 0) return false;
  if (fc.votes * 2 > fc.total) return true;
  if (field === 'assetName' || field === 'assetType') {
    return fc.value != null && fc.votes >= 2;
  }
  // Soft footnotes never veto a row that already has identity agreement.
  if (
    field === 'assetTypeName'
    || field === 'subholding'
    || field === 'location'
    || field === 'description'
    || field === 'supplementalText'
  ) {
    return true;
  }
  return false;
}

export function buildConsensusRows(runs: ConsensusRun[]): ConsensusResult {
  // Collapse duplicate model ids to a DISTINCT electorate. Two runs sharing a
  // model id (e.g. a misconfigured lineup naming the same provider:model twice)
  // must not double-count a single physical read into a false majority — the
  // present-tally below iterates `models`, and the presence/majority math uses
  // `totalRuns`, so both must be the distinct-model count. When ids collide the
  // last run's rows win (perModel is keyed by id); the earlier duplicate read is
  // dropped rather than corroborating itself.
  const preparedRuns = runs.map((r) => ({ ...r, rows: prepareExtractedRows(r.rows) }));
  const models = [...new Set(preparedRuns.map((r) => r.model))];
  const totalRuns = models.length;

  // Per model: base row key -> every source-order occurrence. A later run with
  // the same model id replaces the earlier run, but occurrences within it stay.
  const perModel = new Map<string, Map<string, ParsedTx[]>>();
  for (const run of preparedRuns) perModel.set(run.model, groupRunRows(run.rows));

  // Every row key seen by any model.
  const allKeys = new Set<string>();
  for (const rowsByKey of perModel.values()) {
    for (const k of rowsByKey.keys()) allKeys.add(k);
  }

  const fieldAgreeSum = Object.fromEntries(FIELD_NAMES.map((f) => [f, 0])) as Record<
    ConsensusFieldName,
    number
  >;
  const fieldAgreeCount = Object.fromEntries(FIELD_NAMES.map((f) => [f, 0])) as Record<
    ConsensusFieldName,
    number
  >;

  const rows: ConsensusRow[] = [];
  let rowsUnanimous = 0;
  let rowsMajority = 0;
  let rowsContested = 0;

  for (const baseRowKey of [...allKeys].sort()) {
    const occurrenceCount = Math.max(
      ...models.map((model) => perModel.get(model)!.get(baseRowKey)?.length ?? 0),
    );

    for (let occurrenceIndex = 0; occurrenceIndex < occurrenceCount; occurrenceIndex += 1) {
      // Which models saw this occurrence (model input order preserves the raw
      // display value selected for otherwise-equivalent vote keys).
      const present: Array<{ model: string; tx: ParsedTx }> = [];
      for (const model of models) {
        const tx = perModel.get(model)!.get(baseRowKey)?.[occurrenceIndex];
        if (tx) present.push({ model, tx });
      }
      const presentSet = new Set(present.map((p) => p.model));
      const presentIn = present.map((p) => p.model).sort();
      const missingFrom = models.filter((m) => !presentSet.has(m)).sort();

      const fields = {} as Record<ConsensusFieldName, FieldConsensus>;
      for (const field of FIELD_NAMES) {
        const fc = voteField(present, field);
        fields[field] = fc;
        if (fc.total > 0) {
          fieldAgreeSum[field] += fc.votes / fc.total;
          fieldAgreeCount[field] += 1;
        }
      }

      // A row must be backed by a strict majority of models to be authoritative.
      const majorityPresence = presentIn.length * 2 > totalRuns;
      // Occurrence order is not a stable cross-model identity. If any model
      // emitted more than one row for this ticker/date/type key, a reversed
      // ordering could attach lot B's amount/details to lot A's source text.
      // Keep every occurrence visible, but make the entire duplicate group
      // fail closed for automatic editor substitution.
      const ambiguousDuplicate = occurrenceCount > 1;
      const allUnanimous = FIELD_NAMES.every((f) => fields[f].unanimous);
      const identityOk = IDENTITY_FIELDS.every((f) => fields[f].votes * 2 > fields[f].total);
      const nameOk = fieldAuthoritative('assetName', fields.assetName)
        && fieldAuthoritative('assetType', fields.assetType);
      const allHaveMajority = identityOk && nameOk;

      let rowConsensus: RowConsensus;
      if (!majorityPresence || ambiguousDuplicate) {
        rowConsensus = 'contested';
      } else if (presentIn.length === totalRuns && allUnanimous) {
        rowConsensus = 'unanimous';
      } else if (allHaveMajority) {
        rowConsensus = 'majority';
      } else {
        rowConsensus = 'contested';
      }

      if (rowConsensus === 'unanimous') rowsUnanimous += 1;
      else if (rowConsensus === 'majority') rowsMajority += 1;
      else rowsContested += 1;

      const occurrence = occurrenceIndex + 1;
      const rowKey = occurrenceCount > 1 ? `${baseRowKey}#${occurrence}` : baseRowKey;
      rows.push({ rowKey, baseRowKey, occurrence, presentIn, missingFrom, fields, rowConsensus });
    }
  }

  const perFieldAgreementPct = Object.fromEntries(
    FIELD_NAMES.map((f) => [
      f,
      fieldAgreeCount[f] > 0
        ? Math.round((fieldAgreeSum[f] / fieldAgreeCount[f]) * 1000) / 10
        : 0,
    ]),
  ) as Record<ConsensusFieldName, number>;

  return {
    rows,
    summary: {
      models: [...new Set(models)].sort(),
      rowsUnanimous,
      rowsMajority,
      rowsContested,
      perFieldAgreementPct,
    },
  };
}

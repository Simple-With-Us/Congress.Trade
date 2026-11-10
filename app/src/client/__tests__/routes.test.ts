import { describe, expect, it } from 'vitest';
import { buildClientRouter } from '../routes.ts';
import { executeQueuedCommand } from '../commands.ts';
import { createSession } from '../../auth/session.ts';
import { spendRowBudget, DAILY_ROW_BUDGET } from '../../security/botDefense.ts';
import { canonicalizeAssetType } from '../../shared/assetTypes.ts';
import type { Env, QueueMessage } from '../../shared/types.ts';
import type { FeedTransactionRow, SubscriptionRow } from '../../delivery/rows.ts';
import type { CommandRow } from '../state.ts';

type PrefRow = {
  user_id: string;
  saved_filters: string;
  watchlist: string;
  notification_settings: string;
  default_window: string | null;
  updated_at: string;
};

type FilerRow = {
  bioguide_id: string;
  chamber: string | null;
  full_name: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  committees: string | null;
  photo_url: string | null;
};

type SecurityRow = {
  ticker: string;
  company_name: string | null;
  sector: string | null;
  industry: string | null;
  asset_class: string | null;
  country: string | null;
  exchange_short: string | null;
  currency: string | null;
  market_cap: number | null;
  market_cap_bucket: string | null;
  current_price: number | null;
  current_price_date: string | null;
};

function userRow(id = 'user_1') {
  return {
    id,
    email: 'mobile@example.com',
    name: 'Mobile User',
    picture: null,
    google_sub: null,
    email_verified: 1,
    created_at: '2026-06-24T00:00:00.000Z',
    last_login_at: null,
    subscription_status: 'active',
    plan: 'monthly',
  };
}

function feedRow(overrides: Partial<FeedTransactionRow> & { __chamber?: string } = {}): FeedTransactionRow {
  return {
    id: 'tx_default',
    doc_id: 'H-default',
    filer_id: 'P000197',
    tx_date: '2026-05-05',
    owner: 'self',
    asset_name: 'Apple Inc.',
    ticker: 'AAPL',
    asset_type: 'ST',
    tx_type: 'B',
    amount_min: 15_001,
    amount_max: 50_000,
    is_option: 0,
    cap_gains_over_200: 0,
    raw_text: 'Apple trade',
    confidence: 0.9,
    source: 'primary',
    row_key: 'default',
    created_at: '2026-06-20T00:00:00.000Z',
    cursor_seq: 1,
    est_value: 32_500.5,
    filer_full_name: 'Nancy Pelosi',
    filer_state: 'CA',
    filer_photo_url: null,
    filing_filed_date: '2026-06-19',
    filing_first_seen_at: '2026-06-20T00:00:00.000Z',
    filing_source_url: 'https://example.com/default.pdf',
    ...overrides,
  };
}

function makeEnv(opts: { quotaRace?: boolean; duplicateCommandRace?: boolean; staleReclaimLostRace?: boolean } = {}) {
  type StoredCommandRow = CommandRow & { result_secret?: string | null; result_claimed_at?: string | null };
  const kv = new Map<string, string>();
  const subscriptions = new Map<string, SubscriptionRow>();
  const commands = new Map<string, StoredCommandRow>();
  const preferences = new Map<string, PrefRow>();
  const filers = new Map<string, FilerRow>();
  const securities = new Map<string, SecurityRow>();
  type PushDeviceRow = {
    id: string;
    user_id: string;
    platform: string;
    token: string;
    app_bundle: string | null;
    env: string | null;
    active: number;
    created_at: string;
    updated_at: string;
  };
  const pushDevices = new Map<string, PushDeviceRow>();
  const feedRows: FeedTransactionRow[] = [];
  const deletedUsers = new Set<string>();
  let duplicateRaceTriggered = false;

  const filterFeedRows = (sql: string, params: unknown[]) => {
    let rows = [...feedRows];
    let i = 0;
    if (/t\.source <> 'seed_dataset'/i.test(sql)) {
      rows = rows.filter((row) => row.source !== 'seed_dataset');
    }
    if (/t\.cursor_seq > \?/i.test(sql)) {
      const since = Number(params[i++] ?? 0);
      rows = rows.filter((row) => Number(row.cursor_seq ?? 0) > since);
    }
    if (/\bt\.source = \?/i.test(sql)) {
      const source = String(params[i++]);
      rows = rows.filter((row) => row.source === source);
    }
    if (/t\.id = \?/i.test(sql)) {
      const id = String(params[i++]);
      rows = rows.filter((row) => row.id === id);
    }
    if (/t\.ticker = \?/i.test(sql)) {
      const ticker = String(params[i++]).toUpperCase();
      rows = rows.filter((row) => row.ticker === ticker);
    }
    if (/t\.filer_id = \?/i.test(sql)) {
      const member = String(params[i++]);
      rows = rows.filter((row) => row.filer_id === member);
    }
    if (/LOWER\(COALESCE\(fl\.full_name/i.test(sql)) {
      const memberName = String(params[i++]).replace(/%/g, '').toLowerCase();
      // Second param: the OR LOWER(COALESCE(fl.display_name, '')) LIKE ?
      // branch (rows.ts buildTxFilters) — same normalized term, consume it
      // so downstream param indices stay aligned.
      if (/OR LOWER\(COALESCE\(fl\.display_name/i.test(sql)) i++;
      rows = rows.filter((row) => String(row.filer_full_name ?? row.filer_id ?? '').toLowerCase().includes(memberName));
    }
    if (/t\.tx_type = \?/i.test(sql)) {
      const txType = String(params[i++]);
      rows = rows.filter((row) => row.tx_type === txType);
    }
    const typeIn = sql.match(/t\.tx_type IN \(([?, ]+)\)/i);
    if (typeIn) {
      const n = (typeIn[1].match(/\?/g) ?? []).length;
      const types = params.slice(i, i + n).map(String);
      i += n;
      rows = rows.filter((row) => types.includes(String(row.tx_type)));
    }
    if (/t\.tx_date >= \?/i.test(sql)) {
      const min = String(params[i++]).slice(0, 10);
      rows = rows.filter((row) => String(row.tx_date ?? '') >= min);
    }
    if (/t\.tx_date <= \?/i.test(sql)) {
      const max = String(params[i++]).slice(0, 10);
      rows = rows.filter((row) => String(row.tx_date ?? '') <= max);
    }
    const chamberIn = sql.match(/COALESCE\(fl\.chamber, f\.chamber\) IN \(([?, ]+)\)/i);
    if (chamberIn) {
      const n = (chamberIn[1].match(/\?/g) ?? []).length;
      const chambers = params.slice(i, i + n).map(String);
      i += n;
      rows = rows.filter((row) => chambers.includes(String((row as FeedTransactionRow & { __chamber?: string }).__chamber)));
    } else if (/COALESCE\(fl\.chamber, f\.chamber\) = \?/i.test(sql)) {
      const chamber = String(params[i++]);
      rows = rows.filter((row) => (row as FeedTransactionRow & { __chamber?: string }).__chamber === chamber);
    }
    if (/t\.amount_min >= \?/i.test(sql)) {
      const minAmount = Number(params[i++]);
      rows = rows.filter((row) => row.amount_min != null && row.amount_min >= minAmount);
    }
    if (/t\.amount_min <= \?/i.test(sql)) {
      const maxAmount = Number(params[i++]);
      rows = rows.filter((row) => row.amount_min != null && row.amount_min <= maxAmount);
    }
    // Instrument-class filter (`?assetClass=`). buildTxFilters appends it last,
    // so its params come last too. The real clause is a several-hundred-branch
    // CASE (see canonicalAssetTypeCategorySql); match its distinctive tail and
    // resolve each row's category with the same shared canonicalizer.
    const assetCategoryIn = sql.match(/ELSE 'other' END\) IN \(([?, ]+)\)/i);
    if (assetCategoryIn) {
      const n = (assetCategoryIn[1].match(/\?/g) ?? []).length;
      const categories = params.slice(i, i + n).map(String);
      i += n;
      rows = rows.filter((row) =>
        categories.includes(
          canonicalizeAssetType(row.asset_type, row.asset_type_name ?? null, {
            isOption: row.is_option === 1,
            assetName: row.asset_name ?? null,
          }).category,
        ),
      );
    }
    // tx_date checks first: the real ORDER BY clause for sort=tx_date is
    // "t.tx_date DESC, t.cursor_seq DESC" (see buildTransactionsQuery), which
    // also matches the plain cursor_seq patterns below — so tx_date must win
    // when present, with cursor_seq only as its tie-breaker.
    if (/ORDER BY[^]*t\.tx_date DESC/i.test(sql)) {
      rows.sort((a, b) => {
        const at = String(a.tx_date ?? '');
        const bt = String(b.tx_date ?? '');
        if (at !== bt) return at < bt ? 1 : -1;
        return Number(b.cursor_seq ?? 0) - Number(a.cursor_seq ?? 0);
      });
    } else if (/ORDER BY[^]*t\.tx_date ASC/i.test(sql)) {
      rows.sort((a, b) => {
        const at = String(a.tx_date ?? '');
        const bt = String(b.tx_date ?? '');
        if (at !== bt) return at < bt ? -1 : 1;
        return Number(a.cursor_seq ?? 0) - Number(b.cursor_seq ?? 0);
      });
    } else if (/ORDER BY[^]*t\.cursor_seq DESC/i.test(sql)) {
      rows.sort((a, b) => Number(b.cursor_seq ?? 0) - Number(a.cursor_seq ?? 0));
    } else if (/ORDER BY[^]*t\.cursor_seq ASC/i.test(sql)) {
      rows.sort((a, b) => Number(a.cursor_seq ?? 0) - Number(b.cursor_seq ?? 0));
    }
    // Page LIMIT is last; an earlier LIMIT is the cheap twin-candidate window (#2062).
    // The latency join's LIMIT 1 is not the page size.
    const pageSql = sql.replace(/LEFT JOIN trade_latency_candidates[\s\S]*$/i, '');
    const limitMatches = [...pageSql.matchAll(/LIMIT\s+(\d+)/gi)];
    const limit = Number(limitMatches.at(-1)?.[1] ?? rows.length);
    const offsetMatch = sql.match(/OFFSET\s+(\d+)/i);
    const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
    return rows.slice(offset, offset + limit);
  };

  const midpoint = (row: FeedTransactionRow) => {
    return Number(row.est_value ?? 0);
  };

  const summaryFor = (rows: FeedTransactionRow[]) => {
    const tradeDates = rows.map((row) => row.tx_date).filter((v): v is string => Boolean(v)).sort();
    const uniqueTickers = new Set(rows.map((row) => row.ticker).filter(Boolean));
    const uniqueAssets = new Set(rows.map((row) => row.ticker || row.asset_name).filter(Boolean));
    const estVolume = rows.reduce((sum, row) => sum + midpoint(row), 0);
    const estNetFlow = rows.reduce((sum, row) => {
      const value = midpoint(row);
      if ((row.tx_type === 'B' || row.tx_type === 'P')) return sum + value;
      if (row.tx_type === 'S') return sum - value;
      return sum;
    }, 0);
    return {
      total_trades: rows.length,
      buy_count: rows.filter((row) => (row.tx_type === 'B' || row.tx_type === 'P')).length,
      sell_count: rows.filter((row) => row.tx_type === 'S').length,
      exchange_count: rows.filter((row) => row.tx_type === 'E').length,
      member_count: new Set(rows.map((row) => row.filer_id).filter(Boolean)).size,
      unique_tickers: uniqueTickers.size,
      unique_assets: uniqueAssets.size,
      est_volume: estVolume,
      est_net_flow: estNetFlow,
      first_trade: tradeDates[0] ?? null,
      last_trade: tradeDates[tradeDates.length - 1] ?? null,
    };
  };

  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async first<T>() {
      if (/FROM users WHERE id = \?/i.test(sql) && this.params[0] === 'user_1' && !deletedUsers.has('user_1')) {
        return userRow() as T;
      }
      if (/FROM user_preferences WHERE user_id = \?/i.test(sql)) {
        return (preferences.get(String(this.params[0])) ?? null) as T | null;
      }
      if (/SELECT result_secret FROM client_commands/i.test(sql)) {
        const row = commands.get(String(this.params[0]));
        return (row && row.user_id === this.params[1] && row.result_secret != null ? { result_secret: row.result_secret } : null) as T | null;
      }
      if (/FROM client_commands WHERE id = \? AND user_id = \?/i.test(sql)) {
        const row = commands.get(String(this.params[0]));
        return (row && row.user_id === this.params[1] ? row : null) as T | null;
      }
      if (/FROM client_commands WHERE user_id = \? AND idempotency_key = \?/i.test(sql)) {
        const found = Array.from(commands.values()).find(
          (row) => row.user_id === this.params[0] && row.idempotency_key === this.params[1],
        );
        return (found ?? null) as T | null;
      }
      if (/FROM subscriptions WHERE id = \?/i.test(sql)) {
        return (subscriptions.get(String(this.params[0])) ?? null) as T | null;
      }
      if (/FROM push_devices\s+WHERE user_id = \? AND platform = \? AND token = \?/i.test(sql)) {
        const found = Array.from(pushDevices.values()).find(
          (row) =>
            row.user_id === this.params[0] &&
            row.platform === this.params[1] &&
            row.token === this.params[2],
        );
        return (found ?? null) as T | null;
      }
      if (/FROM push_devices\s+WHERE id = \? AND user_id = \?/i.test(sql)) {
        const row = pushDevices.get(String(this.params[0]));
        return (row && row.user_id === this.params[1] ? row : null) as T | null;
      }
      if (/SELECT COUNT\(\*\) AS n FROM push_devices\s+WHERE user_id = \? AND active = 1/i.test(sql)) {
        const n = Array.from(pushDevices.values()).filter(
          (row) => row.user_id === this.params[0] && row.active === 1,
        ).length;
        return { n } as T;
      }
      if (
        /FROM push_devices\s+WHERE user_id = \? AND active = 1\s+ORDER BY updated_at ASC/i.test(sql)
      ) {
        const rows = Array.from(pushDevices.values())
          .filter((row) => row.user_id === this.params[0] && row.active === 1)
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
        return (rows[0] ?? null) as T | null;
      }
      if (/COUNT\(\*\) AS total/i.test(sql) && /FROM subscriptions WHERE client_id/i.test(sql)) {
        const owned = Array.from(subscriptions.values()).filter((row) => row.client_id === this.params[0]);
        return { total: owned.length, active: owned.filter((row) => row.active === 1).length } as T;
      }
      if (/FROM filers WHERE LOWER\(bioguide_id\) = LOWER\(\?\)/i.test(sql)) {
        const term = String(this.params[0]).toLowerCase();
        const row = Array.from(filers.values()).find((filer) => filer.bioguide_id.toLowerCase() === term);
        return (row ?? null) as T | null;
      }
      if (/FROM filers WHERE LOWER\(full_name\)/i.test(sql)) {
        const exact = String(this.params[0]).toLowerCase();
        const like = String(this.params[1]).replace(/%/g, '').toLowerCase();
        const row = Array.from(filers.values()).find((filer) => filer.full_name?.toLowerCase() === exact) ??
          Array.from(filers.values()).find((filer) => filer.full_name?.toLowerCase().includes(like));
        return (row ?? null) as T | null;
      }
      if (/FROM securities_ref WHERE ticker = \?/i.test(sql)) {
        return (securities.get(String(this.params[0]).toUpperCase()) ?? null) as T | null;
      }
      if (/COUNT\(\*\) AS total_trades/i.test(sql)) {
        return summaryFor(filterFeedRows(sql, this.params)) as T;
      }
      if (/FROM transactions t/i.test(sql) && /t\.id = \?/i.test(sql)) {
        return (filterFeedRows(sql, this.params)[0] ?? null) as T | null;
      }
      if (/COUNT\(\*\) AS total(?:\s|,|$)/i.test(sql)) {
        return { total: filterFeedRows(sql, this.params).length } as T;
      }
      return null as T | null;
    },
    async all<T>() {
      if (/COUNT\(\*\) AS total_trades/i.test(sql)) {
        return { results: [summaryFor(filterFeedRows(sql, this.params)) as T] };
      }
      if (/COUNT\(\*\) AS total/i.test(sql) && /FROM subscriptions WHERE client_id/i.test(sql)) {
        const owned = Array.from(subscriptions.values()).filter((row) => row.client_id === this.params[0]);
        return { results: [{ total: owned.length, active: owned.filter((row) => row.active === 1).length } as T] };
      }
      if (/COUNT\(\*\) AS total(?:\s|,|$)/i.test(sql)) {
        return { results: [{ total: filterFeedRows(sql, this.params).length } as T] };
      }
      if (/FROM client_commands WHERE user_id = \?/i.test(sql)) {
        return {
          results: Array.from(commands.values()).filter((row) => row.user_id === this.params[0]) as T[],
        };
      }
      if (/FROM subscriptions WHERE client_id = \?/i.test(sql)) {
        return {
          results: Array.from(subscriptions.values()).filter((row) => row.client_id === this.params[0]) as T[],
        };
      }
      if (/SELECT COUNT\(\*\) AS n FROM push_devices WHERE user_id = \? AND active = 1/i.test(sql)) {
        const n = Array.from(pushDevices.values()).filter(
          (row) => row.user_id === this.params[0] && row.active === 1,
        ).length;
        return { results: [{ n } as T] };
      }
      if (
        /FROM push_devices\s+WHERE user_id = \? AND active = 1\s+ORDER BY updated_at ASC/i.test(sql)
      ) {
        const rows = Array.from(pushDevices.values())
          .filter((row) => row.user_id === this.params[0] && row.active === 1)
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
        return { results: (rows[0] ? [rows[0]] : []) as T[] };
      }
      if (/FROM push_devices WHERE user_id = \? AND active = 1/i.test(sql)) {
        return {
          results: Array.from(pushDevices.values()).filter(
            (row) => row.user_id === this.params[0] && row.active === 1,
          ) as T[],
        };
      }
      if (/FROM transactions t/i.test(sql)) {
        return { results: filterFeedRows(sql, this.params) as T[] };
      }
      return { results: [] as T[] };
    },
    async run() {
      if (/INSERT INTO user_preferences/i.test(sql)) {
        const [userId, savedFilters, watchlist, notificationSettings, defaultWindow, updatedAt] = this.params;
        preferences.set(String(userId), {
          user_id: String(userId),
          saved_filters: String(savedFilters),
          watchlist: String(watchlist),
          notification_settings: String(notificationSettings),
          default_window: defaultWindow == null ? null : String(defaultWindow),
          updated_at: String(updatedAt),
        });
      } else if (/INSERT INTO client_commands/i.test(sql)) {
        const [id, userId, , , idempotencyKey] = this.params;
        if (opts.duplicateCommandRace && !duplicateRaceTriggered) {
          // Simulate a peer request's concurrent INSERT for the same
          // (user_id, idempotency_key) committing first, between our SELECT
          // (which saw nothing) and this INSERT — the unique index backstop.
          duplicateRaceTriggered = true;
          commands.set('cmd_peer_race', {
            id: 'cmd_peer_race',
            user_id: String(userId),
            type: 'update_preferences',
            status: 'succeeded',
            idempotency_key: idempotencyKey == null ? null : String(idempotencyKey),
            payload: '{}',
            result: JSON.stringify({ preferences: {} }),
            error: null,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:01.000Z',
            started_at: '2026-01-01T00:00:00.000Z',
            finished_at: '2026-01-01T00:00:01.000Z',
          });
          throw new Error('D1_ERROR: UNIQUE constraint failed: client_commands.idempotency_key');
        }
        const [, , type, status, , payload, createdAt, updatedAt] = this.params;
        commands.set(String(id), {
          id: String(id),
          user_id: String(userId),
          type: String(type),
          status: String(status),
          idempotency_key: idempotencyKey == null ? null : String(idempotencyKey),
          payload: String(payload),
          result: null,
          error: null,
          created_at: String(createdAt),
          updated_at: String(updatedAt),
          started_at: null,
          finished_at: null,
        });
      } else if (/UPDATE client_commands/i.test(sql) && /status IN \('queued', 'running'\)/i.test(sql)) {
        const [updatedAt, startedAt, id, userId, staleBefore] = this.params;
        const row = commands.get(String(id));
        if (
          row &&
          row.user_id === userId &&
          (row.status === 'queued' || row.status === 'running') &&
          String(row.started_at ?? row.created_at) < String(staleBefore)
        ) {
          if (opts.staleReclaimLostRace) {
            row.status = 'succeeded';
            row.result = JSON.stringify({ preferences: { defaultWindow: 'peer' } });
            row.updated_at = String(updatedAt);
            row.finished_at = String(updatedAt);
            return { success: true, meta: { changes: 0 } };
          }
          row.status = 'running';
          row.error = null;
          row.updated_at = String(updatedAt);
          row.started_at = String(startedAt);
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      } else if (/UPDATE client_commands/i.test(sql) && /result_secret = NULL/i.test(sql)) {
        const [claimedAt, id, userId] = this.params;
        const row = commands.get(String(id));
        if (row && row.user_id === userId && row.result_secret != null) {
          row.result_secret = null;
          row.result_claimed_at = String(claimedAt);
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      } else if (/UPDATE client_commands/i.test(sql)) {
        const [status, result, resultSecret, error, updatedAt, runningStatus, startedAt, finishedAt, id, userId] = this.params;
        const row = commands.get(String(id));
        if (row && row.user_id === userId) {
          row.status = String(status);
          if (result != null) row.result = String(result);
          if (resultSecret != null) row.result_secret = String(resultSecret);
          row.error = error == null ? null : String(error);
          row.updated_at = String(updatedAt);
          if (!row.started_at && runningStatus === 'running') row.started_at = String(startedAt);
          if (finishedAt != null) row.finished_at = String(finishedAt);
        }
      } else if (/INSERT INTO subscriptions/i.test(sql)) {
        const [id, clientId, delivery, targetUrl, secret, filters, cursor, active, createdAt] = this.params;
        if (subscriptions.has(String(id))) {
          throw new Error('D1_ERROR: UNIQUE constraint failed: subscriptions.id');
        }
        subscriptions.set(String(id), {
          id: String(id),
          client_id: String(clientId),
          delivery: String(delivery),
          target_url: targetUrl == null ? null : String(targetUrl),
          secret: secret == null ? null : String(secret),
          filters: String(filters ?? '{}'),
          cursor: Number(cursor ?? 0),
          active: active ? 1 : 0,
          created_at: String(createdAt),
        });
      } else if (/UPDATE subscriptions SET active = \? WHERE id = \?/i.test(sql)) {
        if (opts.quotaRace) throw new Error('D1_ERROR: subscription active quota exceeded');
        const row = subscriptions.get(String(this.params[1]));
        if (row) row.active = this.params[0] ? 1 : 0;
      } else if (/UPDATE subscriptions SET /i.test(sql)) {
        // Dynamic filter/target/secret patches from updateSubscription.
        const id = String(this.params[this.params.length - 1]);
        const row = subscriptions.get(id);
        if (row) {
          if (/filters = \?/i.test(sql)) {
            const idx = sql.split('?').length - 2; // last ? is id; filters is earlier
            // Prefer positional: filters usually first when present.
            const filtersIdx = /SET filters = \?/i.test(sql) ? 0 : -1;
            if (filtersIdx >= 0) row.filters = String(this.params[filtersIdx] ?? row.filters);
          }
          if (/target_url = \?/i.test(sql)) {
            // Find param index of target_url among SET clauses.
            const setClause = sql.match(/SET (.+) WHERE/i)?.[1] ?? '';
            const parts = setClause.split(',').map((p) => p.trim());
            let pi = 0;
            for (const part of parts) {
              if (/^target_url = \?$/i.test(part)) {
                row.target_url = this.params[pi] == null ? null : String(this.params[pi]);
              }
              if (/^filters = \?$/i.test(part)) {
                row.filters = String(this.params[pi] ?? row.filters);
              }
              if (/^secret = \?$/i.test(part)) {
                row.secret = this.params[pi] == null ? null : String(this.params[pi]);
              }
              if (/^active = \?$/i.test(part)) {
                row.active = this.params[pi] ? 1 : 0;
              }
              pi += 1;
            }
          } else if (/filters = \?/i.test(sql) && !/target_url/i.test(sql)) {
            row.filters = String(this.params[0] ?? row.filters);
          }
        }
      } else if (/DELETE FROM subscriptions WHERE id = \?/i.test(sql)) {
        subscriptions.delete(String(this.params[0]));
      } else if (/DELETE FROM sse_leases WHERE subscription_id = \?/i.test(sql)) {
        // best-effort; no-op in this mock
      } else if (/INSERT INTO push_devices/i.test(sql)) {
        const [id, userId, platform, token, appBundle, deviceEnv, createdAt, updatedAt] = this.params;
        pushDevices.set(String(id), {
          id: String(id),
          user_id: String(userId),
          platform: String(platform),
          token: String(token),
          app_bundle: appBundle == null ? null : String(appBundle),
          env: deviceEnv == null ? null : String(deviceEnv),
          active: 1,
          created_at: String(createdAt),
          updated_at: String(updatedAt),
        });
      } else if (/UPDATE push_devices\s+SET active = 1/i.test(sql)) {
        const [appBundle, deviceEnv, updatedAt, id] = this.params;
        const row = pushDevices.get(String(id));
        if (row) {
          row.active = 1;
          if (appBundle != null) row.app_bundle = String(appBundle);
          if (deviceEnv != null) row.env = String(deviceEnv);
          row.updated_at = String(updatedAt);
        }
      } else if (/UPDATE push_devices SET active = 0, updated_at = \? WHERE id = \?/i.test(sql)) {
        const [updatedAt, id] = this.params;
        const row = pushDevices.get(String(id));
        if (row) {
          row.active = 0;
          row.updated_at = String(updatedAt);
        }
      } else if (/DELETE FROM users WHERE id = \?/i.test(sql)) {
        deletedUsers.add(String(this.params[0]));
        return { success: true, meta: { changes: 1 } };
      } else if (/DELETE FROM push_devices WHERE user_id = \?/i.test(sql)) {
        let changes = 0;
        for (const [id, row] of pushDevices) {
          if (row.user_id === this.params[0]) {
            pushDevices.delete(id);
            changes += 1;
          }
        }
        return { success: true, meta: { changes } };
      } else if (/DELETE FROM user_preferences WHERE user_id = \?/i.test(sql)) {
        const existed = preferences.delete(String(this.params[0]));
        return { success: true, meta: { changes: existed ? 1 : 0 } };
      } else if (/DELETE FROM apple_subscriptions WHERE user_id = \?/i.test(sql)) {
        return { success: true, meta: { changes: 0 } };
      } else if (/DELETE FROM client_commands WHERE user_id = \? AND id != \?/i.test(sql)) {
        let changes = 0;
        for (const [id, row] of commands) {
          if (row.user_id === this.params[0] && id !== this.params[1]) {
            commands.delete(id);
            changes += 1;
          }
        }
        return { success: true, meta: { changes } };
      } else if (/DELETE FROM client_commands WHERE user_id = \?/i.test(sql)) {
        let changes = 0;
        for (const [id, row] of commands) {
          if (row.user_id === this.params[0]) {
            commands.delete(id);
            changes += 1;
          }
        }
        return { success: true, meta: { changes } };
      } else if (
        /UPDATE push_devices SET active = 0, updated_at = \?\s+WHERE user_id = \? AND platform = \? AND token = \?/i
          .test(sql)
      ) {
        const [updatedAt, userId, platform, token] = this.params;
        let changes = 0;
        for (const row of pushDevices.values()) {
          if (
            row.user_id === userId &&
            row.platform === platform &&
            row.token === token &&
            row.active === 1
          ) {
            row.active = 0;
            row.updated_at = String(updatedAt);
            changes += 1;
          }
        }
        return { success: true, meta: { changes } };
      }
      return { success: true, meta: { changes: 1 } };
    },
  });

  const queuedMessages: QueueMessage[] = [];
  const env = {
    DB: { prepare } as unknown as D1Database,
    CONFIG_KV: {
      get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
    },
    INGEST_QUEUE: {
      send: async (msg: QueueMessage) => {
        queuedMessages.push(msg);
      },
      sendBatch: async () => {},
    },
    DELIVERY_QUEUE: { send: async (_msg: QueueMessage) => {}, sendBatch: async () => {} },
  } as unknown as Env;

  return { env, subscriptions, commands, preferences, filers, securities, feedRows, queuedMessages, pushDevices, deletedUsers };
}

/** Simulate the queue worker: run every captured command.execute message. */
async function drainQueuedCommands(env: Env, queuedMessages: QueueMessage[]): Promise<void> {
  for (const msg of queuedMessages.splice(0)) {
    if (msg.type === 'command.execute') {
      await executeQueuedCommand(env, msg.commandId, msg.userId);
    }
  }
}

async function bearer(env: Env): Promise<string> {
  return `Bearer ${await createSession(env, 'user_1')}`;
}

describe('client API routes', () => {
  it('serves bootstrap and public feed without sign-in', async () => {
    const { env } = makeEnv();
    const app = buildClientRouter();

    const bootstrap = await app.request('http://localhost/bootstrap', {}, env);
    expect(bootstrap.status).toBe(200);
    expect((await bootstrap.json()) as {
      auth: { user: unknown };
      capabilities: Record<string, boolean>;
      endpoints: Record<string, string>;
    }).toMatchObject({
      auth: { user: null },
      capabilities: {
        feed: true,
        sse: true,
        webhooks: false,
        commands: false,
        preferences: false,
      },
      endpoints: {
        feed: '/api/client/v1/feed',
        trade: '/api/client/v1/trade/:id',
        ticker: '/api/client/v1/ticker/:ticker',
        member: '/api/client/v1/member/:memberIdOrName',
        commands: '/api/client/v1/commands',
        preferences: '/api/client/v1/preferences',
        subscriptions: '/api/client/v1/subscriptions',
      },
    });

    const feed = await app.request('http://localhost/feed?limit=5', {}, env);
    expect(feed.status).toBe(200);
    expect((await feed.json()) as { items: unknown[] }).toMatchObject({ items: [], cursor: 0 });
  });

  it('accepts bearer sessions for native clients', async () => {
    const { env } = makeEnv();
    const app = buildClientRouter();
    const res = await app.request('http://localhost/me', { headers: { authorization: await bearer(env) } }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { email: string } }).user.email).toBe('mobile@example.com');
  });

  it('serves latest-first server-filtered feed rows with estimated value', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push(
      feedRow({ id: 'matching-old', cursor_seq: 10, __chamber: 'house' }),
      feedRow({ id: 'matching-new', cursor_seq: 12, est_value: 40_000, __chamber: 'house' }),
      feedRow({ id: 'wrong-chamber', cursor_seq: 13, __chamber: 'senate' }),
      feedRow({ id: 'wrong-amount', cursor_seq: 14, amount_min: 50_001, amount_max: 100_000, __chamber: 'house' }),
    );

    const app = buildClientRouter();
    const res = await app.request(
      'http://localhost/feed?limit=30&sort=published&order=desc&ticker=AAPL&memberName=pelosi&chamber=house&minAmount=15001&maxAmount=50000',
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; transaction: { estValue: number | null } }>;
      total: number;
    };
    expect(body.items.map((item) => item.id)).toEqual(['matching-new', 'matching-old']);
    expect(body.items[0].transaction.estValue).toBe(40_000);
    expect(body.total).toBe(2);
  });

  it('returns source document URLs in phone-shaped feed rows', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push({
      id: 'tx_1',
      doc_id: 'H-2026-20034784',
      filer_id: 'P000197',
      tx_date: '2026-05-05',
      owner: 'spouse',
      asset_name: 'Austin TX ARPT SYS TRAN',
      ticker: null,
      asset_type: 'GS',
      tx_type: 'B',
      amount_min: 50001,
      amount_max: 100000,
      is_option: 0,
      cap_gains_over_200: 0,
      raw_text: 'SP Austin TX ARPT SYS TRAN [GS] P 05/05/2026 05/31/2026 $50,001 - $100,000',
      confidence: 0.9,
      source: 'primary',
      row_key: 'v1:primary:0:example',
      created_at: '2026-06-22T13:01:49.646Z',
      cursor_seq: 7472,
      filer_full_name: 'Scott Peters',
      filer_state: 'CA',
      filer_photo_url: null,
      filing_filed_date: '2026-06-19',
      filing_first_seen_at: '2026-06-22T13:01:15.667Z',
      filing_source_url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034784.pdf',
      __chamber: 'house',
      __member_name: 'Scott Peters',
      __party: null,
      est_value: 75001,
    } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: null });

    const app = buildClientRouter();
    const res = await app.request('http://localhost/feed?limit=1', {}, env);
    expect(res.status).toBe(200);
    expect((await res.json()) as { items: Array<{ filing: { sourceUrl: string } }> }).toMatchObject({
      items: [
        {
          filing: {
            sourceUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034784.pdf',
          },
        },
      ],
    });
  });

  it('surfaces enriched sector and market cap on feed rows', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push({
      id: 'tx_2',
      doc_id: 'H-2026-20034836',
      filer_id: 'P000197',
      tx_date: '2026-05-06',
      owner: 'self',
      asset_name: 'Apple Inc. - Common Stock',
      ticker: 'AAPL',
      asset_type: 'ST',
      tx_type: 'B',
      amount_min: 1001,
      amount_max: 15000,
      is_option: 0,
      cap_gains_over_200: 0,
      raw_text: 'Apple',
      confidence: 0.95,
      source: 'primary',
      row_key: 'v1:primary:0:aapl',
      created_at: '2026-06-22T13:01:49.646Z',
      cursor_seq: 7473,
      filer_full_name: 'Scott Peters',
      filer_state: 'CA',
      filer_photo_url: null,
      filing_filed_date: '2026-06-19',
      filing_first_seen_at: '2026-06-22T13:01:15.667Z',
      filing_source_url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034836.pdf',
      ref_company_name: 'Apple Inc.',
      ref_sector: 'Technology',
      ref_market_cap_bucket: 'mega',
      __chamber: 'house',
      __member_name: 'Scott Peters',
      __party: null,
      est_value: 8000,
    } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: null });

    const app = buildClientRouter();
    const res = await app.request('http://localhost/feed?limit=1', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        asset: {
          ticker: string | null;
          sector: string | null;
        };
      }>;
    };
    expect(body.items[0].asset).toMatchObject({
      ticker: 'AAPL',
      sector: 'Technology',
    });
  });

  it('emits null ticker when a row has no resolved ticker', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push({
      id: 'tx_3',
      doc_id: 'H-2026-20034784',
      filer_id: 'P000197',
      tx_date: '2026-05-05',
      owner: 'spouse',
      asset_name: 'Austin TX ARPT SYS TRAN',
      ticker: null,
      asset_type: 'GS',
      tx_type: 'B',
      amount_min: 50001,
      amount_max: 100000,
      is_option: 0,
      cap_gains_over_200: 0,
      raw_text: 'muni bond',
      confidence: 0.9,
      source: 'primary',
      row_key: 'v1:primary:0:muni',
      created_at: '2026-06-22T13:01:49.646Z',
      cursor_seq: 7474,
      filer_full_name: 'Scott Peters',
      filer_state: 'CA',
      filer_photo_url: null,
      filing_filed_date: '2026-06-19',
      filing_first_seen_at: '2026-06-22T13:01:15.667Z',
      filing_source_url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034784.pdf',
      __chamber: 'house',
      __member_name: 'Scott Peters',
      __party: null,
      est_value: 75001,
    } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: null });

    const app = buildClientRouter();
    const res = await app.request('http://localhost/feed?limit=1', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        asset: {
          ticker: string | null;
        };
      }>;
    };
    expect(body.items[0].asset).toMatchObject({
      ticker: null,
    });
  });

  it('returns a public trade detail envelope with the client trade DTO', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push({
      id: 'tx_detail',
      doc_id: 'H-2026-20034836',
      filer_id: 'P000197',
      tx_date: '2026-05-06',
      owner: 'self',
      asset_name: 'Apple Inc. - Common Stock',
      ticker: 'AAPL',
      asset_type: 'ST',
      tx_type: 'B',
      amount_min: 1001,
      amount_max: 15000,
      is_option: 0,
      cap_gains_over_200: 0,
      raw_text: 'Apple',
      confidence: 0.95,
      source: 'primary',
      row_key: 'v1:primary:0:aapl',
      created_at: '2026-06-22T13:01:49.646Z',
      cursor_seq: 7473,
      filer_full_name: 'Scott Peters',
      filer_state: 'CA',
      filer_photo_url: null,
      filing_filed_date: '2026-06-19',
      filing_first_seen_at: '2026-06-22T13:01:15.667Z',
      filing_source_url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034836.pdf',
      ref_company_name: 'Apple Inc.',
      ref_sector: 'Technology',
      ref_market_cap_bucket: 'mega',
      __chamber: 'house',
      __member_name: 'Scott Peters',
      __party: 'D',
      est_value: 8000,
    } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: string });

    const app = buildClientRouter();
    const res = await app.request('http://localhost/trade/tx_detail', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      item: { id: string; member: { name: string; party: string }; asset: { ticker: string | null } };
      items: unknown[];
      count: number;
      total: number;
    };
    expect(body.item).toMatchObject({
      id: 'tx_detail',
      member: { name: 'Scott Peters', party: 'D' },
      asset: { ticker: 'AAPL' },
    });
    expect(body.items).toHaveLength(1);
    expect(body.count).toBe(1);
    expect(body.total).toBe(1);
  });

  it('returns a public ticker detail envelope with summary and recent trades', async () => {
    const { env, feedRows, securities } = makeEnv();
    securities.set('AAPL', {
      ticker: 'AAPL',
      company_name: 'Apple Inc.',
      sector: 'Technology',
      industry: 'Consumer Electronics',
      asset_class: 'equity',
      country: 'US',
      exchange_short: 'NASDAQ',
      currency: 'USD',
      market_cap: 3000000000000,
      market_cap_bucket: 'mega',
      current_price: 210.25,
      current_price_date: '2026-06-29',
    });
    feedRows.push(
      {
        id: 'tx_aapl_old',
        doc_id: 'H-1',
        filer_id: 'P000197',
        tx_date: '2026-05-01',
        owner: 'self',
        asset_name: 'Apple Inc.',
        ticker: 'AAPL',
        asset_type: 'ST',
        tx_type: 'B',
        amount_min: 1001,
        amount_max: 15000,
        is_option: 0,
        cap_gains_over_200: 0,
        raw_text: 'Apple buy',
        confidence: 0.95,
        source: 'primary',
        row_key: 'old',
        created_at: '2026-06-20T00:00:00.000Z',
        cursor_seq: 10,
        filer_full_name: 'Scott Peters',
        filer_state: 'CA',
        filer_photo_url: null,
        filing_filed_date: '2026-06-19',
        filing_first_seen_at: '2026-06-20T00:00:00.000Z',
        filing_source_url: 'https://example.com/old.pdf',
        __chamber: 'house',
        __member_name: 'Scott Peters',
        __party: 'D',
        est_value: 8000,
      } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: string },
      {
        id: 'tx_aapl_new',
        doc_id: 'H-2',
        filer_id: 'N000188',
        tx_date: '2026-05-03',
        owner: 'spouse',
        asset_name: 'Apple Inc.',
        ticker: 'AAPL',
        asset_type: 'ST',
        tx_type: 'S',
        amount_min: 15001,
        amount_max: 50000,
        is_option: 0,
        cap_gains_over_200: 0,
        raw_text: 'Apple sell',
        confidence: 0.9,
        source: 'primary',
        row_key: 'new',
        created_at: '2026-06-21T00:00:00.000Z',
        cursor_seq: 12,
        filer_full_name: 'Nancy Pelosi',
        filer_state: 'CA',
        filer_photo_url: null,
        filing_filed_date: '2026-06-20',
        filing_first_seen_at: '2026-06-21T00:00:00.000Z',
        filing_source_url: 'https://example.com/new.pdf',
        __chamber: 'house',
        __member_name: 'Nancy Pelosi',
        __party: 'D',
        est_value: 32501,
      } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: string },
      {
        id: 'tx_msft',
        doc_id: 'H-3',
        filer_id: 'P000197',
        tx_date: '2026-05-04',
        owner: 'self',
        asset_name: 'Microsoft Corp.',
        ticker: 'MSFT',
        asset_type: 'ST',
        tx_type: 'B',
        amount_min: 1001,
        amount_max: 15000,
        is_option: 0,
        cap_gains_over_200: 0,
        raw_text: 'Microsoft buy',
        confidence: 0.9,
        source: 'primary',
        row_key: 'msft',
        created_at: '2026-06-22T00:00:00.000Z',
        cursor_seq: 13,
        filer_full_name: 'Scott Peters',
        filer_state: 'CA',
        filer_photo_url: null,
        filing_filed_date: '2026-06-21',
        filing_first_seen_at: '2026-06-22T00:00:00.000Z',
        filing_source_url: 'https://example.com/msft.pdf',
        __chamber: 'house',
        __member_name: 'Scott Peters',
        __party: 'D',
        est_value: 8000,
      } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: string },
    );

    const app = buildClientRouter();
    const res = await app.request('http://localhost/ticker/aapl?limit=1', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ticker: string;
      asset: { companyName: string | null; logoUrl: string | null; currentPrice: number | null };
      summary: { totalTrades: number; buyCount: number; sellCount: number; memberCount: number };
      items: Array<{ id: string; asset: { ticker: string | null } }>;
      count: number;
      total: number;
    };
    expect(body.ticker).toBe('AAPL');
    expect(body.asset).toMatchObject({
      companyName: 'Apple Inc.',
      logoUrl: '/api/logos/ticker?symbol=AAPL',
      currentPrice: 210.25,
    });
    expect(body.summary).toMatchObject({ totalTrades: 2, buyCount: 1, sellCount: 1, memberCount: 2 });
    expect(body.items).toEqual([
      expect.objectContaining({ id: 'tx_aapl_new', asset: expect.objectContaining({ ticker: 'AAPL' }) }),
    ]);
    expect(body.count).toBe(1);
    expect(body.total).toBe(2);
  });

  it('applies shared type= filter to ticker list and summary', async () => {
    const { env, feedRows, securities } = makeEnv();
    securities.set('AAPL', {
      ticker: 'AAPL',
      company_name: 'Apple Inc.',
      sector: 'Technology',
      industry: 'Consumer Electronics',
      asset_class: 'equity',
      country: 'US',
      exchange_short: 'NASDAQ',
      currency: 'USD',
      market_cap: 3_200_000_000_000,
      market_cap_bucket: 'mega',
      current_price: 210.25,
      current_price_date: '2026-06-24',
    });
    feedRows.push(
      feedRow({ id: 'tx_aapl_buy', ticker: 'AAPL', tx_type: 'B', cursor_seq: 20 }),
      feedRow({ id: 'tx_aapl_sell', ticker: 'AAPL', tx_type: 'S', cursor_seq: 21 }),
    );
    const app = buildClientRouter();
    const res = await app.request('http://localhost/ticker/AAPL?type=B', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: { totalTrades: number; buyCount: number; sellCount: number };
      items: Array<{ id: string; transaction: { type: string } }>;
      total: number;
    };
    expect(body.summary).toMatchObject({ totalTrades: 1, buyCount: 1, sellCount: 0 });
    expect(body.total).toBe(1);
    expect(body.items.map((item) => item.id)).toEqual(['tx_aapl_buy']);
  });

  it('returns a public politician detail envelope by member endpoint/name', async () => {
    const { env, feedRows, filers } = makeEnv();
    filers.set('P000197', {
      bioguide_id: 'P000197',
      chamber: 'house',
      full_name: 'Scott Peters',
      party: 'D',
      state: 'CA',
      district: '50',
      committees: JSON.stringify(['Energy and Commerce']),
      photo_url: 'https://example.com/peters.jpg',
    });
    feedRows.push(
      {
        id: 'tx_member_1',
        doc_id: 'H-4',
        filer_id: 'P000197',
        tx_date: '2026-04-01',
        owner: 'self',
        asset_name: 'Apple Inc.',
        ticker: 'AAPL',
        asset_type: 'ST',
        tx_type: 'B',
        amount_min: 1001,
        amount_max: 15000,
        is_option: 0,
        cap_gains_over_200: 0,
        raw_text: 'Apple buy',
        confidence: 0.95,
        source: 'primary',
        row_key: 'member-1',
        created_at: '2026-06-18T00:00:00.000Z',
        cursor_seq: 20,
        filer_full_name: 'Scott Peters',
        filer_state: 'CA',
        filer_photo_url: 'https://example.com/peters.jpg',
        filing_filed_date: '2026-06-18',
        filing_first_seen_at: '2026-06-18T00:00:00.000Z',
        filing_source_url: 'https://example.com/member1.pdf',
        __chamber: 'house',
        __member_name: 'Scott Peters',
        __party: 'D',
        est_value: 8000,
      } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: string },
      {
        id: 'tx_member_2',
        doc_id: 'H-5',
        filer_id: 'P000197',
        tx_date: '2026-04-03',
        owner: 'self',
        asset_name: 'Microsoft Corp.',
        ticker: 'MSFT',
        asset_type: 'ST',
        tx_type: 'S',
        amount_min: 15001,
        amount_max: 50000,
        is_option: 0,
        cap_gains_over_200: 0,
        raw_text: 'Microsoft sell',
        confidence: 0.9,
        source: 'primary',
        row_key: 'member-2',
        created_at: '2026-06-19T00:00:00.000Z',
        cursor_seq: 21,
        filer_full_name: 'Scott Peters',
        filer_state: 'CA',
        filer_photo_url: 'https://example.com/peters.jpg',
        filing_filed_date: '2026-06-19',
        filing_first_seen_at: '2026-06-19T00:00:00.000Z',
        filing_source_url: 'https://example.com/member2.pdf',
        __chamber: 'house',
        __member_name: 'Scott Peters',
        __party: 'D',
        est_value: 32501,
      } as FeedTransactionRow & { __chamber: string; __member_name: string; __party: string },
    );

    const app = buildClientRouter();
    const res = await app.request('http://localhost/member/Scott%20Peters?limit=2', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      member: { id: string; name: string; chamber: string; committees: string[] };
      summary: { totalTrades: number; uniqueTickers: number; uniqueAssets: number };
      items: Array<{ member: { id: string | null } }>;
      total: number;
    };
    expect(body.member).toMatchObject({
      id: 'P000197',
      name: 'Scott Peters',
      chamber: 'house',
      committees: ['Energy and Commerce'],
    });
    expect(body.summary).toMatchObject({ totalTrades: 2, uniqueTickers: 2, uniqueAssets: 2 });
    expect(body.items.map((item) => item.member.id)).toEqual(['P000197', 'P000197']);
    expect(body.total).toBe(2);
  });

  it('lists politician recent trades by trade date, not ingest cursor', async () => {
    // Live Ro Khanna 2026-08-16: lastTrade 2026-07-01, but /member items
    // defaulted to cursor_seq so a reimported Dec-2025 filing floated first.
    const { env, feedRows, filers } = makeEnv();
    filers.set('house-ca17-ro-khanna', {
      bioguide_id: 'house-ca17-ro-khanna',
      chamber: 'house',
      full_name: 'Ro Khanna',
      party: 'D',
      state: 'CA',
      district: '17',
      committees: null,
      photo_url: null,
    });
    feedRows.push(
      feedRow({
        id: 'tx-old-reimport',
        filer_id: 'house-ca17-ro-khanna',
        tx_date: '2025-12-12',
        cursor_seq: 900,
        ticker: null,
        asset_name: 'Bond dump',
        __chamber: 'house',
      }),
      feedRow({
        id: 'tx-actually-recent',
        filer_id: 'house-ca17-ro-khanna',
        tx_date: '2026-07-01',
        cursor_seq: 10,
        ticker: 'NVDA',
        __chamber: 'house',
      }),
    );
    const app = buildClientRouter();
    const res = await app.request('http://localhost/member/house-ca17-ro-khanna?limit=2', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }>; summary: { lastTrade: string | null } };
    expect(body.summary.lastTrade).toBe('2026-07-01');
    expect(body.items.map((item) => item.id)).toEqual(['tx-actually-recent', 'tx-old-reimport']);
  });

  it('peels a percent-encoded query string off the politician path (APICONTRACT-01)', async () => {
    const { env, feedRows, filers } = makeEnv();
    filers.set('house-ca17-ro-khanna', {
      bioguide_id: 'house-ca17-ro-khanna',
      chamber: 'house',
      full_name: 'Ro Khanna',
      party: 'D',
      state: 'CA',
      district: '17',
      committees: null,
      photo_url: null,
    });
    feedRows.push(
      feedRow({
        id: 'tx-recent',
        filer_id: 'house-ca17-ro-khanna',
        tx_date: '2026-07-01',
        cursor_seq: 10,
        ticker: 'NVDA',
        __chamber: 'house',
      }),
    );
    const app = buildClientRouter();
    const res = await app.request(
      'http://localhost/member/house-ca17-ro-khanna%3Fsort%3Dtx_date%26order%3Ddesc',
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { member: { id: string }; items: Array<{ id: string }> };
    expect(body.member.id).toBe('house-ca17-ro-khanna');
    expect(body.items.map((item) => item.id)).toEqual(['tx-recent']);
  });

  // Regression: TestFlight purchase, 2026-08-13. `redeem_apple_purchase` was
  // enqueued on the durable queue and only executed by the background tick —
  // a minute apart at best, five on the free profile — while the iOS client
  // gave up polling after ~18s. Apple had already charged; the app said
  // "Request failed". A command a human is waiting on must come back terminal
  // from the POST itself, with the queue message kept only as the backstop.
  it('finishes a command inline so the caller never waits for the background tick', async () => {
    const { env, preferences, commands, queuedMessages } = makeEnv();
    const app = buildClientRouter();
    const res = await app.request(
      'http://localhost/commands',
      {
        method: 'POST',
        headers: { authorization: await bearer(env), 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'update_preferences',
          payload: { defaultWindow: '30d' },
          idempotencyKey: 'inline-1',
        }),
      },
      env,
    );

    // Terminal in the response body, before anything drains the queue.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { command: { id: string; status: string } };
    expect(body.command.status).toBe('succeeded');
    expect(commands.get(body.command.id)?.status).toBe('succeeded');
    expect(preferences.get('user_1')?.default_window).toBe('30d');

    // The backstop message was still enqueued (this request could have died
    // between the enqueue and the inline run), and replaying it changes
    // nothing — executeQueuedCommand no-ops on a terminal row.
    expect(queuedMessages).toHaveLength(1);
    await drainQueuedCommands(env, queuedMessages);
    expect(commands.get(body.command.id)?.status).toBe('succeeded');
    expect(commands.size).toBe(1);
  });

  it('updates preferences through an authenticated command', async () => {
    const { env, preferences, commands, queuedMessages } = makeEnv();
    const app = buildClientRouter();
    const res = await app.request(
      'http://localhost/commands',
      {
        method: 'POST',
        headers: { authorization: await bearer(env), 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'update_preferences',
          payload: { watchlist: ['aapl', 'msft'], defaultWindow: 'all' },
          idempotencyKey: 'prefs-1',
        }),
      },
      env,
    );
    // The POST finishes the command inline and answers with a terminal row.
    // The durable-queue message is still enqueued as the backstop, and
    // draining it is a no-op because the row is already terminal.
    expect(res.status).toBe(200);
    expect((await res.json()) as { command: { status: string } }).toMatchObject({
      command: { status: 'succeeded' },
    });
    expect(JSON.parse(preferences.get('user_1')?.watchlist ?? '[]')).toEqual(['AAPL', 'MSFT']);
    expect(queuedMessages).toHaveLength(1);
    expect(queuedMessages[0]).toMatchObject({ type: 'command.execute', userId: 'user_1' });

    await drainQueuedCommands(env, queuedMessages);
    expect(JSON.parse(preferences.get('user_1')?.watchlist ?? '[]')).toEqual(['AAPL', 'MSFT']);
    expect(Array.from(commands.values())[0].status).toBe('succeeded');
  });

  it('creates an SSE subscription command and replays by idempotency key', async () => {
    const { env, subscriptions, commands, queuedMessages } = makeEnv();
    const app = buildClientRouter();
    const auth = await bearer(env);
    const req = {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json', 'idempotency-key': 'sub-1' },
      body: JSON.stringify({
        type: 'create_subscription',
        payload: { delivery: 'sse', filters: { tickers: ['aapl'] } },
      }),
    };

    const first = await app.request('http://localhost/commands', req, env);
    expect(first.status).toBe(200);
    const accepted = (await first.json()) as {
      command: { id: string; status: string; result: { subscription: { secret?: string; streamUrl?: string } } };
    };
    expect(accepted.command.status).toBe('succeeded');
    expect(subscriptions.size).toBe(1);
    // Inline success claims the one-time secret on the POST (DELIVERYALERTS-01).
    expect(accepted.command.result.subscription.secret).toMatch(/^whsec_/);
    expect(accepted.command.result.subscription.streamUrl).toContain('/api/stream?subscription=');

    // Redelivery of the backstop message must not create a second subscription.
    await drainQueuedCommands(env, queuedMessages);
    expect(subscriptions.size).toBe(1);
    expect(commands.size).toBe(1);
    // The persisted row stays redacted; the secret is not logged or stored in result.
    const persisted = JSON.parse(Array.from(commands.values())[0].result ?? '{}') as {
      subscription: { secret?: string; streamUrl?: string };
    };
    expect(persisted.subscription.secret).toBeUndefined();
    expect(persisted.subscription.streamUrl).toBeUndefined();

    // Later GET /commands/:id does not disclose the secret again:
    const cmdId = accepted.command.id;
    const firstRead = await app.request(`http://localhost/commands/${cmdId}`, { headers: { authorization: auth } }, env);
    expect(firstRead.status).toBe(200);
    const firstBody = (await firstRead.json()) as { command: { result: { subscription: { secret?: string; streamUrl?: string } } } };
    expect(firstBody.command.result.subscription.secret).toBeUndefined();

    // Second GET /commands/:id still does not disclose:
    const secondRead = await app.request(`http://localhost/commands/${cmdId}`, { headers: { authorization: auth } }, env);
    expect(secondRead.status).toBe(200);
    const secondBody = (await secondRead.json()) as { command: { result: { subscription: { secret?: string } } } };
    expect(secondBody.command.result.subscription.secret).toBeUndefined();

    const replay = await app.request('http://localhost/commands', req, env);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      replayed: boolean;
      command: { status: string; result: { subscription: { secret?: string } } };
    };
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.command.status).toBe('succeeded');
    expect(replayBody.command.result.subscription.secret).toBeUndefined();
    expect(subscriptions.size).toBe(1);
    expect(commands.size).toBe(1);
    expect(queuedMessages).toHaveLength(0);
  });

  it('enforces the same durable quota and bounded filters on client commands', async () => {
    const { env, subscriptions, commands, queuedMessages } = makeEnv();
    for (let i = 0; i < 20; i += 1) {
      subscriptions.set(`sub_${i}`, {
        id: `sub_${i}`, client_id: 'user:user_1', delivery: 'sse', target_url: null,
        secret: `secret_${i}`, filters: '{}', cursor: 0, active: i < 10 ? 1 : 0,
        created_at: '2026-01-01T00:00:00.000Z',
      });
    }
    const app = buildClientRouter();
    const auth = await bearer(env);
    const limited = await app.request('http://localhost/commands', {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'create_subscription', payload: { delivery: 'sse', filters: {} } }),
    }, env);
    // Validation/entitlement failures surface on the command row, not the POST.
    expect(limited.status).toBe(200);
    await drainQueuedCommands(env, queuedMessages);
    expect(Array.from(commands.values()).at(-1)?.status).toBe('failed');
    expect(Array.from(commands.values()).at(-1)?.error).toContain('subscription');

    subscriptions.clear();
    const invalid = await app.request('http://localhost/commands', {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'create_subscription', payload: { delivery: 'sse', filters: { tickers: Array(51).fill('A') } } }),
    }, env);
    expect(invalid.status).toBe(200);
    await drainQueuedCommands(env, queuedMessages);
    expect(Array.from(commands.values()).at(-1)?.status).toBe('failed');
    expect(Array.from(commands.values()).at(-1)?.error).toBeTruthy();
  });

  it('registers an APNs device token via register_device and legacy create_subscription apns', async () => {
    const { env, commands, queuedMessages, pushDevices } = makeEnv();
    const app = buildClientRouter();
    const auth = await bearer(env);
    const token = 'a'.repeat(64);

    const create = await app.request('http://localhost/commands', {
      method: 'POST',
      headers: {
        authorization: auth,
        'content-type': 'application/json',
        'idempotency-key': 'apns-reg-1',
      },
      body: JSON.stringify({
        type: 'register_device',
        payload: { platform: 'apns', token, appBundle: 'trade.congress.ios', env: 'production' },
      }),
    }, env);
    expect(create.status).toBe(200);
    await drainQueuedCommands(env, queuedMessages);
    expect(Array.from(commands.values()).at(-1)?.status).toBe('succeeded');
    expect(pushDevices.size).toBe(1);
    const stored = Array.from(pushDevices.values())[0];
    expect(stored.token).toBe(token);
    expect(stored.platform).toBe('apns');
    expect(stored.active).toBe(1);

    // Idempotent re-register (same token) reactivates / updates, no second row.
    const again = await app.request('http://localhost/commands', {
      method: 'POST',
      headers: {
        authorization: auth,
        'content-type': 'application/json',
        'idempotency-key': 'apns-reg-2',
      },
      body: JSON.stringify({
        type: 'register_device',
        payload: { platform: 'apns', token, appBundle: 'trade.congress.ios' },
      }),
    }, env);
    expect(again.status).toBe(200);
    await drainQueuedCommands(env, queuedMessages);
    expect(pushDevices.size).toBe(1);

    // Legacy iOS path: create_subscription + delivery:apns must not fail validation.
    const legacy = await app.request('http://localhost/commands', {
      method: 'POST',
      headers: {
        authorization: auth,
        'content-type': 'application/json',
        'idempotency-key': 'apns-legacy-1',
      },
      body: JSON.stringify({
        type: 'create_subscription',
        payload: { delivery: 'apns', targetUrl: 'b'.repeat(64), filters: {} },
      }),
    }, env);
    expect(legacy.status).toBe(200);
    await drainQueuedCommands(env, queuedMessages);
    expect(Array.from(commands.values()).at(-1)?.status).toBe('succeeded');
    expect(pushDevices.size).toBe(2);

    // Bad hex token fails cleanly.
    const bad = await app.request('http://localhost/commands', {
      method: 'POST',
      headers: {
        authorization: auth,
        'content-type': 'application/json',
        'idempotency-key': 'apns-bad',
      },
      body: JSON.stringify({
        type: 'register_device',
        payload: { platform: 'apns', token: 'not-a-token' },
      }),
    }, env);
    expect(bad.status).toBe(200);
    await drainQueuedCommands(env, queuedMessages);
    expect(Array.from(commands.values()).at(-1)?.status).toBe('failed');
    expect(Array.from(commands.values()).at(-1)?.error).toMatch(/hex/i);
  });

  it('rejects oversized webhook targets in client create and update commands', async () => {
    const { env, subscriptions, commands, queuedMessages } = makeEnv();
    const app = buildClientRouter();
    const auth = await bearer(env);
    const oversized = `https://example.com/${'x'.repeat(2049)}`;
    const create = await app.request('http://localhost/commands', {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'create_subscription', payload: { delivery: 'webhook', targetUrl: oversized, filters: {} } }),
    }, env);
    expect(create.status).toBe(200);
    await drainQueuedCommands(env, queuedMessages);
    expect(Array.from(commands.values()).at(-1)?.status).toBe('failed');
    expect(Array.from(commands.values()).at(-1)?.error).toBeTruthy();

    subscriptions.set('sub_webhook', {
      id: 'sub_webhook', client_id: 'user:user_1', delivery: 'webhook', target_url: 'https://example.com/hook',
      secret: 'secret', filters: '{}', cursor: 0, active: 1, created_at: '2026-01-01T00:00:00.000Z',
    });
    const update = await app.request('http://localhost/commands', {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'update_subscription', payload: { id: 'sub_webhook', targetUrl: oversized } }),
    }, env);
    expect(update.status).toBe(200);
    await drainQueuedCommands(env, queuedMessages);
    expect(Array.from(commands.values()).at(-1)?.status).toBe('failed');
    expect(Array.from(commands.values()).at(-1)?.error).toBeTruthy();
  });

  it('records the failure when the active-quota trigger wins a client update race', async () => {
    const { env, subscriptions, commands, queuedMessages } = makeEnv({ quotaRace: true });
    subscriptions.set('sub_inactive', {
      id: 'sub_inactive', client_id: 'user:user_1', delivery: 'sse', target_url: null,
      secret: 'secret', filters: '{}', cursor: 0, active: 0,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const app = buildClientRouter();
    const res = await app.request('http://localhost/commands', {
      method: 'POST',
      headers: { authorization: await bearer(env), 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'update_subscription',
        payload: { id: 'sub_inactive', active: true },
      }),
    }, env);
    expect(res.status).toBe(200);
    await drainQueuedCommands(env, queuedMessages);
    const command = Array.from(commands.values()).at(-1);
    expect(command?.status).toBe('failed');
    expect(command?.error).toContain('active subscription limit');
  });

  it('deletes an owned subscription via delete_subscription and rejects foreign ids', async () => {
    const { env, subscriptions, commands, queuedMessages } = makeEnv();
    subscriptions.set('sub_mine', {
      id: 'sub_mine', client_id: 'user:user_1', delivery: 'sse', target_url: null,
      secret: 'secret_mine', filters: '{"tickers":["AAPL"]}', cursor: 0, active: 1,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    subscriptions.set('sub_theirs', {
      id: 'sub_theirs', client_id: 'user:other', delivery: 'sse', target_url: null,
      secret: 'secret_theirs', filters: '{}', cursor: 0, active: 1,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const app = buildClientRouter();
    const auth = await bearer(env);

    const ok = await app.request('http://localhost/commands', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'delete_subscription', payload: { id: 'sub_mine' } }),
    }, env);
    expect(ok.status).toBe(200);
    await drainQueuedCommands(env, queuedMessages);
    const okCmd = Array.from(commands.values()).at(-1);
    expect(okCmd?.status).toBe('succeeded');
    expect(JSON.parse(okCmd?.result ?? '{}')).toMatchObject({ deleted: true, id: 'sub_mine' });
    expect(subscriptions.has('sub_mine')).toBe(false);
    expect(subscriptions.has('sub_theirs')).toBe(true);

    const denied = await app.request('http://localhost/commands', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'delete_subscription', payload: { id: 'sub_theirs' } }),
    }, env);
    expect(denied.status).toBe(200);
    await drainQueuedCommands(env, queuedMessages);
    const deniedCmd = Array.from(commands.values()).at(-1);
    expect(deniedCmd?.status).toBe('failed');
    expect(deniedCmd?.error).toMatch(/subscription not found/i);
    expect(subscriptions.has('sub_theirs')).toBe(true);
  });

  it('pauses and resumes an owned subscription via update_subscription active flag', async () => {
    const { env, subscriptions, commands, queuedMessages } = makeEnv();
    subscriptions.set('sub_toggle', {
      id: 'sub_toggle', client_id: 'user:user_1', delivery: 'webhook',
      target_url: 'https://example.com/hook', secret: 'secret', filters: '{}',
      cursor: 0, active: 1, created_at: '2026-01-01T00:00:00.000Z',
    });
    const app = buildClientRouter();
    const auth = await bearer(env);

    const pause = await app.request('http://localhost/commands', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'update_subscription', payload: { id: 'sub_toggle', active: false } }),
    }, env);
    expect(pause.status).toBe(200);
    await drainQueuedCommands(env, queuedMessages);
    expect(Array.from(commands.values()).at(-1)?.status).toBe('succeeded');
    expect(subscriptions.get('sub_toggle')?.active).toBe(0);

    const resume = await app.request('http://localhost/commands', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'update_subscription', payload: { id: 'sub_toggle', active: true } }),
    }, env);
    expect(resume.status).toBe(200);
    await drainQueuedCommands(env, queuedMessages);
    expect(Array.from(commands.values()).at(-1)?.status).toBe('succeeded');
    expect(subscriptions.get('sub_toggle')?.active).toBe(1);
  });

  it('deletes the signed-in account via delete_account', async () => {
    const { env, subscriptions, commands, pushDevices, deletedUsers, queuedMessages } = makeEnv();
    subscriptions.set('sub_mine', {
      id: 'sub_mine',
      client_id: 'user:user_1',
      delivery: 'sse',
      target_url: null,
      secret: 'whsec_mine',
      filters: '{}',
      cursor: 0,
      active: 1,
      created_at: '2026-08-01T00:00:00.000Z',
    });
    pushDevices.set('dev_1', {
      id: 'dev_1',
      user_id: 'user_1',
      platform: 'apns',
      token: 'a'.repeat(64),
      app_bundle: 'trade.congress.ios',
      env: 'production',
      active: 1,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    });
    const app = buildClientRouter();
    const ok = await app.request('http://localhost/commands', {
      method: 'POST',
      headers: { authorization: await bearer(env), 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'delete_account', payload: {} }),
    }, env);
    expect(ok.status).toBe(200);
    await drainQueuedCommands(env, queuedMessages);
    const command = Array.from(commands.values()).find((row) => row.type === 'delete_account');
    expect(command?.status).toBe('succeeded');
    expect(command?.result && JSON.parse(String(command.result))).toMatchObject({
      deleted: true,
      userId: 'user_1',
    });
    expect(deletedUsers.has('user_1')).toBe(true);
    expect(subscriptions.has('sub_mine')).toBe(false);
    expect(pushDevices.has('dev_1')).toBe(false);
  });

  it('fails unsupported client command types on the command row', async () => {
    const { env, commands, queuedMessages } = makeEnv();
    const app = buildClientRouter();
    const res = await app.request(
      'http://localhost/commands',
      {
        method: 'POST',
        headers: { authorization: await bearer(env), 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'start_checkout',
          payload: {},
          idempotencyKey: 'checkout-1',
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    await drainQueuedCommands(env, queuedMessages);
    const command = Array.from(commands.values()).at(-1);
    expect(command?.status).toBe('failed');
    expect(command?.error).toBe('start_checkout is not implemented yet');
  });

  it('replays the winning row instead of 500ing when a concurrent duplicate command wins the idempotency race', async () => {
    const { env, commands } = makeEnv({ duplicateCommandRace: true });
    const app = buildClientRouter();
    const res = await app.request(
      'http://localhost/commands',
      {
        method: 'POST',
        headers: { authorization: await bearer(env), 'content-type': 'application/json', 'idempotency-key': 'race-1' },
        body: JSON.stringify({ type: 'update_preferences', payload: { defaultWindow: 'all' } }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { replayed: boolean; command: { id: string; status: string } };
    expect(body.replayed).toBe(true);
    expect(body.command.id).toBe('cmd_peer_race');
    expect(body.command.status).toBe('succeeded');
    // Only the peer's row exists — our own losing insert never landed.
    expect(commands.size).toBe(1);
  });

  it('reclaims and re-runs a stale running command instead of replaying a dead status forever', async () => {
    const { env, commands, queuedMessages } = makeEnv();
    commands.set('cmd_stale', {
      id: 'cmd_stale',
      user_id: 'user_1',
      type: 'update_preferences',
      status: 'running',
      idempotency_key: 'stale-1',
      payload: JSON.stringify({ defaultWindow: '30d' }),
      result: null,
      error: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
      started_at: '2020-01-01T00:00:00.000Z',
      finished_at: null,
    });
    const app = buildClientRouter();
    const res = await app.request(
      'http://localhost/commands',
      {
        method: 'POST',
        headers: { authorization: await bearer(env), 'content-type': 'application/json', 'idempotency-key': 'stale-1' },
        body: JSON.stringify({ type: 'update_preferences', payload: { defaultWindow: 'all' } }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { replayed?: boolean; command: { id: string; status: string } };
    expect(body.command.id).toBe('cmd_stale');
    expect(body.command.status).toBe('succeeded');
    expect(body.replayed).toBeUndefined();
    // The same row was reused (reclaimed), not duplicated.
    expect(commands.size).toBe(1);
    await drainQueuedCommands(env, queuedMessages);
    expect(commands.get('cmd_stale')?.status).toBe('succeeded');
  });

  it('replays the winner when a concurrent retry already reclaimed a stale command', async () => {
    const { env, commands, preferences } = makeEnv({ staleReclaimLostRace: true });
    commands.set('cmd_stale_lost', {
      id: 'cmd_stale_lost',
      user_id: 'user_1',
      type: 'update_preferences',
      status: 'running',
      idempotency_key: 'stale-lost-1',
      payload: JSON.stringify({ defaultWindow: '30d' }),
      result: null,
      error: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
      started_at: '2020-01-01T00:00:00.000Z',
      finished_at: null,
    });
    const app = buildClientRouter();
    const res = await app.request(
      'http://localhost/commands',
      {
        method: 'POST',
        headers: { authorization: await bearer(env), 'content-type': 'application/json', 'idempotency-key': 'stale-lost-1' },
        body: JSON.stringify({ type: 'update_preferences', payload: { defaultWindow: 'all' } }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { replayed: boolean; command: { id: string; status: string } };
    expect(body.replayed).toBe(true);
    expect(body.command.id).toBe('cmd_stale_lost');
    expect(body.command.status).toBe('succeeded');
    expect(preferences.size).toBe(0);
  });

  it('replays an already-created subscription when a stale command is retried after side effects landed', async () => {
    const { env, commands, subscriptions, queuedMessages } = makeEnv();
    commands.set('cmd_recover_sub', {
      id: 'cmd_recover_sub',
      user_id: 'user_1',
      type: 'create_subscription',
      status: 'running',
      idempotency_key: 'sub-stale-1',
      payload: JSON.stringify({ delivery: 'sse', filters: { tickers: ['AAPL'] } }),
      result: null,
      error: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
      started_at: '2020-01-01T00:00:00.000Z',
      finished_at: null,
    });
    subscriptions.set('sub_recover_sub', {
      id: 'sub_recover_sub',
      client_id: 'user:user_1',
      delivery: 'sse',
      target_url: null,
      secret: 'whsec_existing',
      filters: JSON.stringify({ tickers: ['AAPL'] }),
      cursor: 0,
      active: 1,
      created_at: '2020-01-01T00:00:05.000Z',
    });
    const app = buildClientRouter();
    const res = await app.request(
      'http://localhost/commands',
      {
        method: 'POST',
        headers: { authorization: await bearer(env), 'content-type': 'application/json', 'idempotency-key': 'sub-stale-1' },
        body: JSON.stringify({ type: 'create_subscription', payload: { delivery: 'sse', filters: { tickers: ['MSFT'] } } }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { command: { id: string; status: string } };
    expect(body.command.id).toBe('cmd_recover_sub');
    // The reclaim re-enqueues the same row; the worker re-runs it and the
    // create path reconciles with the subscription that already landed.
    await drainQueuedCommands(env, queuedMessages);
    const done = commands.get('cmd_recover_sub');
    expect(done?.status).toBe('succeeded');
    const result = JSON.parse(done?.result ?? '{}') as {
      subscription: { id: string; secret?: string; filters: { tickers?: string[] } };
    };
    expect(result.subscription.id).toBe('sub_recover_sub');
    expect(result.subscription.secret).toBeUndefined();
    const posted = body as { command: { result?: { subscription?: { secret?: string } } } };
    expect(posted.command.result?.subscription?.secret).toBe('whsec_existing');
    const read = await app.request('http://localhost/commands/cmd_recover_sub', { headers: { authorization: await bearer(env) } }, env);
    const readBody = (await read.json()) as { command: { result: { subscription: { secret?: string } } } };
    expect(readBody.command.result.subscription.secret).toBeUndefined();
    expect(result.subscription.filters.tickers).toEqual(['AAPL']);
    expect(subscriptions.size).toBe(1);
  });

  it('replays a genuinely in-flight (recent) running command without re-executing it', async () => {
    const { env, commands } = makeEnv();
    const recentTs = new Date().toISOString();
    commands.set('cmd_inflight', {
      id: 'cmd_inflight',
      user_id: 'user_1',
      type: 'update_preferences',
      status: 'running',
      idempotency_key: 'inflight-1',
      payload: '{}',
      result: null,
      error: null,
      created_at: recentTs,
      updated_at: recentTs,
      started_at: recentTs,
      finished_at: null,
    });
    const app = buildClientRouter();
    const res = await app.request(
      'http://localhost/commands',
      {
        method: 'POST',
        headers: { authorization: await bearer(env), 'content-type': 'application/json', 'idempotency-key': 'inflight-1' },
        body: JSON.stringify({ type: 'update_preferences', payload: { defaultWindow: 'all' } }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { replayed: boolean; command: { status: string } };
    expect(body.replayed).toBe(true);
    expect(body.command.status).toBe('running');
    expect(commands.size).toBe(1);
  });
});

describe('client API detail endpoints: row budget + zero-delta polling', () => {
  it('applies the shared daily row budget to trade/ticker/member detail reads', async () => {
    const { env } = makeEnv();
    // Budget enforcement happens before any DB read in each handler, so an
    // otherwise-empty DB is enough to prove the gate is wired up.
    const guardedEnv = { ...env, SCRAPE_GUARD_ENABLED: 'true' } as unknown as Env;
    const ip = '203.0.113.50';
    await spendRowBudget(guardedEnv, ip, DAILY_ROW_BUDGET);

    const app = buildClientRouter();
    const headers = { 'cf-connecting-ip': ip };
    const trade = await app.request('http://localhost/trade/tx_budget', { headers }, guardedEnv);
    expect(trade.status).toBe(429);
    const ticker = await app.request('http://localhost/ticker/AAPL', { headers }, guardedEnv);
    expect(ticker.status).toBe(429);
    const member = await app.request('http://localhost/member/P000197', { headers }, guardedEnv);
    expect(member.status).toBe(429);
  });

  it('omits total on a zero-delta since-poll instead of paying for a full COUNT(*)', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push(feedRow({ id: 'tx_1', cursor_seq: 5, __chamber: 'house' }));
    const app = buildClientRouter();
    // since=100 is past every row's cursor -> zero new rows.
    const res = await app.request('http://localhost/feed?since=100', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total?: number; count: number };
    expect(body.items).toHaveLength(0);
    expect(body.count).toBe(0);
    expect(body.total).toBeUndefined();
  });

  it('still computes total on a since-poll that DOES return new rows', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push(feedRow({ id: 'tx_1', cursor_seq: 5, __chamber: 'house' }));
    const app = buildClientRouter();
    const res = await app.request('http://localhost/feed?since=0', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total?: number };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
  });
});

describe('client API feed: asset-class filter (?assetClass=)', () => {
  /** One row per canonical bucket the dropdown has to tell apart. */
  const mixedAssetRows = () => [
    feedRow({ id: 'stock', cursor_seq: 1, asset_type: 'ST', ticker: 'AAPL', __chamber: 'house' }),
    feedRow({ id: 'etf', cursor_seq: 2, asset_type: 'EF', ticker: 'SPY', __chamber: 'house' }),
    feedRow({ id: 'mutual-fund', cursor_seq: 3, asset_type: 'MF', ticker: null, __chamber: 'house' }),
    feedRow({ id: 'muni-bond', cursor_seq: 4, asset_type: 'GS', ticker: null, __chamber: 'house' }),
    feedRow({ id: 'real-property', cursor_seq: 5, asset_type: 'RP', ticker: null, __chamber: 'house' }),
  ];

  it('narrows the page to public equities, funds, and ETFs', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push(...mixedAssetRows());
    const app = buildClientRouter();

    const res = await app.request('http://localhost/feed?assetClass=equities_funds', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }>; count: number };
    // Cursorless `/feed` is newest-first (PR #1767), so the matching rows come
    // back in descending `cursor_seq`: mutual-fund(3), etf(2), stock(1).
    expect(body.items.map((item) => item.id)).toEqual(['mutual-fund', 'etf', 'stock']);
    expect(body.count).toBe(3);
  });

  it('reports a `total` that reflects the FILTER, not the page size', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push(...mixedAssetRows());
    const app = buildClientRouter();

    // limit=2 with 3 matching rows: a client-side filter over one fetched page
    // could only ever report 2 (or, unfiltered, all 5). The server-side filter
    // must serve a 2-row page while reporting the true match count of 3 — that
    // is the whole reason this filter is not done on the client.
    const res = await app.request('http://localhost/feed?limit=2&assetClass=equities_funds', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }>; count: number; total: number };
    // Newest-first (PR #1767): the 2-row page is the TOP of the match set,
    // mutual-fund(3) and etf(2) — stock(1) is the one that falls off.
    expect(body.items.map((item) => item.id)).toEqual(['mutual-fund', 'etf']);
    expect(body.count).toBe(2);
    expect(body.total).toBe(3);
  });

  it('treats "all" (and an absent param) as no filter at all', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push(...mixedAssetRows());
    const app = buildClientRouter();

    const all = await app.request('http://localhost/feed?assetClass=all', {}, env);
    const allBody = (await all.json()) as { total: number };
    expect(allBody.total).toBe(5);

    const absent = await app.request('http://localhost/feed', {}, env);
    const absentBody = (await absent.json()) as { total: number };
    expect(absentBody.total).toBe(5);
  });

  it('composes with the other server-side filters and their total', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push(
      ...mixedAssetRows(),
      feedRow({ id: 'senate-stock', cursor_seq: 6, asset_type: 'ST', __chamber: 'senate' }),
    );
    const app = buildClientRouter();

    const res = await app.request(
      'http://localhost/feed?chamber=senate&assetClass=equities_funds',
      {},
      env,
    );
    const body = (await res.json()) as { items: Array<{ id: string }>; total: number };
    expect(body.items.map((item) => item.id)).toEqual(['senate-stock']);
    expect(body.total).toBe(1);
  });

  it('carries the canonical category and its label on every trade row', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push(...mixedAssetRows());
    const app = buildClientRouter();

    const res = await app.request('http://localhost/feed', {}, env);
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        asset: {
          type: string | null;
          typeCategory: string | null;
          typeCategoryLabel: string | null;
          logoUrl: string | null;
        };
      }>;
    };
    const byId = new Map(body.items.map((item) => [item.id, item.asset]));
    // Raw disclosure code is preserved as provenance...
    expect(byId.get('stock')?.type).toBe('ST');
    // ...alongside the canonical rollup a client can actually filter/group on.
    expect(byId.get('stock')?.typeCategory).toBe('public_equity');
    expect(byId.get('stock')?.typeCategoryLabel).toBe('Public Equity');
    expect(byId.get('etf')?.typeCategory).toBe('fund');
    expect(byId.get('muni-bond')?.typeCategory).toBe('fixed_income_government');
    expect(byId.get('muni-bond')?.typeCategoryLabel).toBe('Government / Municipal Debt');
    // Same-origin logo proxy path, previously documented but never emitted.
    expect(byId.get('stock')?.logoUrl).toBe('/api/logos/ticker?symbol=AAPL');
    expect(byId.get('muni-bond')?.logoUrl).toBeNull();
  });
});

describe('client API feed: offset-paged snapshots (iOS punch list #2, item 8)', () => {
  it('allows offset up to the public depth cap and rejects beyond it with 400 (mirrors /api/transactions)', async () => {
    const { env } = makeEnv();
    const app = buildClientRouter();

    const atCap = await app.request('http://localhost/feed?offset=2000', {}, env);
    expect(atCap.status).toBe(200);

    const overCap = await app.request('http://localhost/feed?offset=2001', {}, env);
    expect(overCap.status).toBe(400);
    const body = (await overCap.json()) as { error: string };
    expect(body.error).toContain('offset beyond 2000');
  });

  it('returns the page starting at offset, sorted newest-trade-date-first when sort=tx_date&order=desc', async () => {
    const { env, feedRows } = makeEnv();
    // cursor_seq deliberately does NOT correlate with tx_date order, so this
    // only passes if sort=tx_date actually drives the ordering rather than
    // silently falling back to the cursor_seq default (the bug this fixes).
    feedRows.push(
      feedRow({ id: 'tx-newest', cursor_seq: 1, tx_date: '2026-03-03', __chamber: 'house' }),
      feedRow({ id: 'tx-middle', cursor_seq: 3, tx_date: '2026-02-02', __chamber: 'house' }),
      feedRow({ id: 'tx-oldest', cursor_seq: 2, tx_date: '2026-01-01', __chamber: 'house' }),
    );
    const app = buildClientRouter();

    const page1 = await app.request('http://localhost/feed?limit=2&offset=0&sort=tx_date&order=desc', {}, env);
    expect(page1.status).toBe(200);
    const page1Body = (await page1.json()) as { items: Array<{ id: string }>; total: number };
    expect(page1Body.items.map((i) => i.id)).toEqual(['tx-newest', 'tx-middle']);
    expect(page1Body.total).toBe(3);

    const page2 = await app.request('http://localhost/feed?limit=2&offset=2&sort=tx_date&order=desc', {}, env);
    expect(page2.status).toBe(200);
    const page2Body = (await page2.json()) as { items: Array<{ id: string }> };
    expect(page2Body.items.map((i) => i.id)).toEqual(['tx-oldest']);
  });
});

describe('client API feed: default order (oldest-first-seed-rows bug)', () => {
  it('defaults to cursor_seq DESC (newest-first) when neither since nor order is given', async () => {
    // Reproduces the diagnosed defect: the raw builder default is
    // `cursor_seq ASC`, so a plain `GET /feed` used to surface the oldest
    // `seed_dataset` rows first — rows with no owning `filings` row at all,
    // so filedDate/firstSeenAt/sourceUrl all come back null. The route must
    // now default to DESC so a caller with no forward cursor sees recent,
    // fully-populated rows.
    const { env, feedRows } = makeEnv();
    feedRows.push(
      feedRow({
        id: 'seed-oldest',
        cursor_seq: 1,
        source: 'seed_dataset',
        filing_filed_date: null,
        filing_first_seen_at: null,
        filing_source_url: undefined,
      }),
      feedRow({
        id: 'seed-older',
        cursor_seq: 2,
        source: 'seed_dataset',
        filing_filed_date: null,
        filing_first_seen_at: null,
        filing_source_url: undefined,
      }),
      feedRow({ id: 'live-newest', cursor_seq: 3 }),
    );
    const app = buildClientRouter();
    const res = await app.request('http://localhost/feed?limit=2', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; filing: { filedDate: string | null } }>;
    };
    expect(body.items.map((i) => i.id)).toEqual(['live-newest']);
    expect(body.items[0].filing.filedDate).not.toBeNull();
  });

  it('includes seed_dataset rows only when source=all', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push(
      feedRow({
        id: 'seed-older',
        cursor_seq: 2,
        source: 'seed_dataset',
        filing_filed_date: null,
        filing_first_seen_at: null,
        filing_source_url: undefined,
      }),
      feedRow({ id: 'live-newest', cursor_seq: 3 }),
    );
    const app = buildClientRouter();
    const res = await app.request('http://localhost/feed?limit=5&source=all', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(['live-newest', 'seed-older']);
  });

  it('keeps ASC (oldest-of-the-new-batch-first) on a since-cursor poll even without an explicit order', async () => {
    // The forward-cursor paging contract (a client re-feeds the returned max
    // cursor back as `since=`) must keep resuming gap-free — the new DESC
    // default only applies when there is no cursor at all.
    const { env, feedRows } = makeEnv();
    feedRows.push(
      feedRow({ id: 'tx-a', cursor_seq: 10 }),
      feedRow({ id: 'tx-b', cursor_seq: 11 }),
      feedRow({ id: 'tx-c', cursor_seq: 12 }),
    );
    const app = buildClientRouter();
    const res = await app.request('http://localhost/feed?since=5', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(['tx-a', 'tx-b', 'tx-c']);
  });

  it('treats an explicit since=0 the same as any other cursor value (stays ASC)', async () => {
    // since=0 is a legitimate "start of history, but I AM a resumable cursor
    // client" value (parseIntOrUndef("0") -> 0, not undefined) — it must not
    // be treated the same as "no cursor at all".
    const { env, feedRows } = makeEnv();
    feedRows.push(
      feedRow({ id: 'tx-a', cursor_seq: 1 }),
      feedRow({ id: 'tx-b', cursor_seq: 2 }),
    );
    const app = buildClientRouter();
    const res = await app.request('http://localhost/feed?since=0', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(['tx-a', 'tx-b']);
  });

  it('an explicit order always wins over the new no-cursor default', async () => {
    const { env, feedRows } = makeEnv();
    feedRows.push(
      feedRow({ id: 'tx-a', cursor_seq: 1 }),
      feedRow({ id: 'tx-b', cursor_seq: 2 }),
    );
    const app = buildClientRouter();
    const res = await app.request('http://localhost/feed?order=asc', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(['tx-a', 'tx-b']);
  });
});

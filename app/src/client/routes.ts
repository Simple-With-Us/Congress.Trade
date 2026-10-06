/**
 * src/client/routes.ts
 *
 * Shared backend-owned API for the phone-first SwiftUI app.
 * Mounted at /api/client/v1. Public reads stay public; preferences and commands
 * require the existing opaque session via cookie or Authorization bearer.
 */

import { Hono } from 'hono';
import type { ClientCommand, Env, User, ClientCommandType } from '../shared/types.ts';

import { getCurrentUserFromRequest } from '../auth/session.ts';
import { resolveEntitlementAsync } from '../billing/entitlement.ts';
import { normalizeTickerLogoSymbol } from '../ui/tickerLogos.ts';
import { serveDocumentPdf } from '../delivery/rest.ts';
import { describeSubscriptionMembers } from '../delivery/subscriptions.ts';
import { redeemAppleEntitlementAnonymously } from './entitlements.ts';
import {
  claimCommandResultSecret,
  createCommand,
  DuplicateCommandError,
  findCommandByIdempotencyKey,
  getCommand,
  getPreferences,
  isStaleInFlightCommand,
  listCommands,
  reclaimStaleInFlightCommand,
  updateCommandStatus,
  upsertPreferences,
} from './state.ts';
import {
  ClientInputError,
  errorStatus,
  readJson,
  requireUser,
  filtersFromQuery,
  detailLimit,
  asOrder,
  asSort,
  num,
  str,
  baseSummary,
  securityRef,
  memberProfile,
  parseIntOrUndef,
  publicSubscription,
} from './utils.ts';
import {
  getClientTrade,
  getSecurityRef,
  listUserSubscriptions,
  memberSummarySql,
  readClientTradeList,
  resolveMember,
  tickerSummarySql,
} from './queries.ts';
import {
  commandType,
  executeQueuedCommand,
  INLINE_COMMAND_BUDGET_MS,
  mergeClaimedSecret,
  normalizePreferencePatch,
} from './commands.ts';
import { tickerAnalytics, wantsAnalytics } from './tickerAnalytics.ts';
import { checkRowBudget, spendRowBudget, MAX_PUBLIC_TX_OFFSET } from '../security/botDefense.ts';
import { clientIp } from '../shared/rateLimit.ts';
import { get, all } from '../shared/db.ts';
import { resolveFilerCommittees } from '../shared/committeeNames.ts';
import { buildMemberPerformanceQuery } from '../analytics/builders.ts';
import { asWindow } from '../analytics/sql.ts';
import { aggregateMemberDualPerformance } from '../analytics/compute.ts';
import { latestSpxClose } from '../prices/service.ts';
import { currentPriceFreshThrough } from '../prices/staleness.ts';
import type { TradeSummaryRow } from './types.ts';
import type { TxQueryParams } from '../delivery/rows.ts';
import { mergePeeledQuery, peelEncodedQueryFromPathParam } from '../shared/memberPath.ts';

export function buildClientRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  r.get('/bootstrap', async (c) => {
    const user = await getCurrentUserFromRequest(c);
    return c.json({
      serverTime: new Date().toISOString(),
      auth: {
        user: user
          ? { id: user.id, email: user.email, name: user.name, picture: user.picture }
          : null,
        entitlement: await resolveEntitlementAsync(c.env, user),
      },
      capabilities: {
        feed: true,
        sse: true,
        webhooks: Boolean(user),
        commands: Boolean(user),
        preferences: Boolean(user),
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
  });

  r.get('/documents/:docId/pdf', serveDocumentPdf);

  // Unauthenticated by design (Guideline 5.1.1(v)) — see client/entitlements.ts.
  r.post('/entitlements/apple/redeem', redeemAppleEntitlementAnonymously);

  r.get('/me', async (c) => {
    const user = await getCurrentUserFromRequest(c);
    return c.json({ user, entitlement: await resolveEntitlementAsync(c.env, user) });
  });

  r.get('/feed', async (c) => {
    const params = filtersFromQuery(c.req.query());
    // Default to newest-first when the caller has no forward cursor. The raw
    // ordering `buildTransactionsQuery` falls back to is `cursor_seq ASC`
    // (oldest first) so a `since=`-cursor poll can resume gap-free — but that
    // means an unparameterized first call also got oldest-first, and the
    // oldest ~11,820 rows are `seed_dataset` bulk-import rows with no owning
    // `filings` row at all (no filedDate/firstSeenAt/sourceUrl — see
    // mapFeedTransaction). A public endpoint called "feed" defaulting to a
    // wall of filing-less historical rows is the actual defect; the fix is
    // scoped to *default direction only*, not the paging contract itself:
    // - `since` present (including `since=0`, an explicit "start of history"
    //   cursor) => leave `order` as the caller set it (undefined stays ASC in
    //   buildTransactionsQuery) so incremental sync keeps walking forward.
    // - `since` absent AND caller didn't pass `order` => default to `desc` so
    //   a plain `GET /feed` (or `GET /feed?limit=…&ticker=…`, etc.) shows
    //   recent, fully-populated rows. iOS always sends its own explicit
    //   `order` (clients/ios/CongressTrade/Store/CongressTradeStore.swift) and
    //   never sends `since`, so it is unaffected either way; webhook/SSE
    //   delivery (src/delivery/{webhook,sse}.ts) hardcode their own
    //   `cursor_seq ASC` SQL and never go through this parser at all.
    if (params.since === undefined && params.order === undefined) {
      params.order = 'desc';
    }
    // Same public offset depth cap as /api/transactions (src/delivery/rest.ts)
    // — deep offset walks are Premium CSV export's job, not a free scrape path.
    if ((params.offset ?? 0) > MAX_PUBLIC_TX_OFFSET) {
      return c.json(
        {
          error: `offset beyond ${MAX_PUBLIC_TX_OFFSET} is not available on the public feed`,
          hint: 'Premium CSV export: GET /api/export/transactions.csv (authenticated Premium session).',
        },
        400,
      );
    }
    // Same anti-scrape daily row budget as /api/transactions — both pagers
    // walk the identical corpus, so they draw on one shared per-IP budget.
    const ip = clientIp(c.req.raw);
    const budget = await checkRowBudget(c.env, ip);
    if (!budget.ok) {
      return c.json({ error: 'daily feed row budget reached' }, 429, {
        'Retry-After': String(budget.retryAfterSec),
      });
    }
    const list = await readClientTradeList(c.env, params);
    await spendRowBudget(c.env, ip, list.count);
    return c.json({ ...list, nextPollAfterSec: 60 });
  });

  r.get('/trade/:id', async (c) => {
    const id = (c.req.param('id') || '').trim();
    if (!id || id.length > 128) return c.json({ error: 'invalid trade id' }, 400);
    // Same per-IP daily row budget as /feed — a detail endpoint is still a
    // corpus read and must not be a free side-channel around the pager budget.
    const ip = clientIp(c.req.raw);
    const budget = await checkRowBudget(c.env, ip);
    if (!budget.ok) {
      return c.json({ error: 'daily feed row budget reached' }, 429, {
        'Retry-After': String(budget.retryAfterSec),
      });
    }
    const item = await getClientTrade(c.env, id);
    if (!item) return c.json({ error: 'trade not found' }, 404);
    await spendRowBudget(c.env, ip, 1);
    return c.json({
      item,
      items: [item],
      cursor: item.cursor,
      count: 1,
      total: 1,
      limit: 1,
    });
  });

  r.get('/ticker/:ticker', async (c) => {
    const ticker = normalizeTickerLogoSymbol(c.req.param('ticker'));
    if (!ticker) return c.json({ error: 'invalid ticker' }, 400);
    const ip = clientIp(c.req.raw);
    const budget = await checkRowBudget(c.env, ip);
    if (!budget.ok) {
      return c.json({ error: 'daily feed row budget reached' }, 429, {
        'Retry-After': String(budget.retryAfterSec),
      });
    }
    const q = c.req.query();
    const filters = filtersFromQuery(q);
    const params: TxQueryParams = {
      ...filters,
      ticker,
      limit: detailLimit(q.limit),
      order: asOrder(q.order) ?? 'desc',
    };
    // Company-drawer parity block (buy pressure, buys/sells over time, top
    // buyers/sellers, "Performance After Buys"). Opt-in because the backtest
    // leg scans this ticker's full price history plus the whole SPX series —
    // see client/tickerAnalytics.ts for why it lives on THIS contract rather
    // than sending clients to the internal /api/analytics routes.
    const includeAnalytics = wantsAnalytics(q.include);
    const summaryQ = tickerSummarySql(ticker, filters);
    const [list, summaryRow, refRow, analytics] = await Promise.all([
      readClientTradeList(c.env, params),
      get<TradeSummaryRow>(c.env.DB, summaryQ.sql, summaryQ.params),
      getSecurityRef(c.env, ticker),
      includeAnalytics
        ? tickerAnalytics(c.env, ticker, {
            window: q.window,
            granularity: q.granularity,
          }).catch((err) => {
            // The trade list is this endpoint's primary job; an analytics
            // failure degrades that one section to `null` rather than blanking
            // the whole screen. Clients must treat `analytics: null` as
            // "unavailable right now", never as "no activity".
            console.error('client ticker analytics failed', {
              ticker,
              error: err instanceof Error ? err.message : String(err),
            });
            return null;
          })
        : Promise.resolve(undefined),
    ]);
    await spendRowBudget(c.env, ip, list.count);
    return c.json({
      ticker,
      asset: securityRef(ticker, refRow),
      summary: {
        ...baseSummary(summaryRow),
        memberCount: num(summaryRow?.member_count),
      },
      // Omitted entirely unless requested, so existing decoders see byte-for-byte
      // the response they see today.
      ...(includeAnalytics ? { analytics } : {}),
      ...list,
    });
  });

  r.get('/member/:memberIdOrName', async (c) => {
    const peeled = peelEncodedQueryFromPathParam((c.req.param('memberIdOrName') || '').trim());
    const memberIdOrName = peeled.id.trim();
    const q = mergePeeledQuery(c.req.query(), peeled.query);
    if (!memberIdOrName || memberIdOrName.length > 120) {
      return c.json({ error: 'invalid member id or name' }, 400);
    }
    const ip = clientIp(c.req.raw);
    const budget = await checkRowBudget(c.env, ip);
    if (!budget.ok) {
      return c.json({ error: 'daily feed row budget reached' }, 429, {
        'Retry-After': String(budget.retryAfterSec),
      });
    }
    const resolved = await resolveMember(c.env, memberIdOrName);
    if (!resolved) return c.json({ error: 'member not found' }, 404);
    const filters = filtersFromQuery(q);
    const params: TxQueryParams = {
      ...filters,
      member: resolved.id,
      limit: detailLimit(q.limit),
      // Recent Trades must be newest *trade date*, not newest ingest cursor.
      // Khanna 2026-08-16: lastTrade 2026-07-01 but cursor order put a
      // reimported 2025-12-12 filing first on the politician sheet.
      sort: asSort(q.sort) ?? 'tx_date',
      order: asOrder(q.order) ?? 'desc',
    };
    const summaryQ = memberSummarySql(resolved.id, filters);
    const perfQ = buildMemberPerformanceQuery(resolved.id, {
      window: asWindow(q.window, 'all'),
      chambers: filters.chambers,
      parties: filters.partyBuckets,
      txTypes: filters.types ?? (filters.type ? [filters.type] : undefined),
    });
    const [list, summaryRow, perfRowsRaw, currentSpx] = await Promise.all([
      readClientTradeList(c.env, params),
      get<TradeSummaryRow>(c.env.DB, summaryQ.sql, summaryQ.params),
      all<Record<string, unknown>>(c.env.DB, perfQ.sql, perfQ.params),
      latestSpxClose(c.env),
    ]);
    if (!resolved.profile && list.total === 0) return c.json({ error: 'member not found' }, 404);
    await spendRowBudget(c.env, ip, list.count);

    const perfRows = perfRowsRaw.map((row) => ({
      isOption: num(row.is_option) === 1,
      txType: str(row.tx_type),
      priceAtTrade: row.price_at_trade == null ? null : num(row.price_at_trade),
      spxAtTrade: row.spx_at_trade == null ? null : num(row.spx_at_trade),
      priceAtFiling: row.price_at_filing == null ? null : num(row.price_at_filing),
      spxAtFiling: row.spx_at_filing == null ? null : num(row.spx_at_filing),
      currentPrice: row.current_price == null ? null : num(row.current_price),
      elapsedDaysSinceFiling:
        row.elapsed_days_since_filing == null ? null : num(row.elapsed_days_since_filing),
      currentPriceDate: str(row.current_price_date),
      spxNow: row.spx_now == null ? null : num(row.spx_now),
    }));
    const dual = aggregateMemberDualPerformance(perfRows, currentSpx, {
      priceFreshThrough: currentPriceFreshThrough(),
    });
    // Flat `performance` stays trade-date buy skill for older iOS decoders;
    // nested legs expose both anchors for new clients.
    const performance = {
      ...dual.tradeDate,
      side: dual.side,
      buyCount: dual.buyCount,
      tradeDate: dual.tradeDate,
      filingDate: dual.filingDate,
      // Newest price date behind any scored trade: every return above ends on it
      // (the S&P leg is aligned per ticker to the same day) — clients print "Prices as of".
      pricesAsOf: perfRows.reduce<string | null>(
        (best, r) => (r.currentPriceDate && (!best || r.currentPriceDate > best) ? r.currentPriceDate : best),
        null,
      ),
    };

    const member = memberProfile(resolved.profile, resolved.id);
    if (!member.committees.length) {
      member.committees = await resolveFilerCommittees(
        c.env.DB,
        resolved.id,
        resolved.profile?.committees,
        resolved.profile?.resolved_bioguide_id,
      );
    }
    return c.json({
      member,
      summary: {
        ...baseSummary(summaryRow),
        uniqueTickers: num(summaryRow?.unique_tickers),
        uniqueAssets: num(summaryRow?.unique_assets),
        performance,
      },
      ...list,
    });
  });

  r.get('/preferences', async (c) => {
    try {
      const user = await requireUser(c);
      return c.json({ preferences: await getPreferences(c.env, user.id) });
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }
  });

  r.put('/preferences', async (c) => {
    try {
      const user = await requireUser(c);
      const body = await readJson(c);
      return c.json({ preferences: await upsertPreferences(c.env, user.id, normalizePreferencePatch(body)) });
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }
  });

  r.get('/subscriptions', async (c) => {
    try {
      const user = await requireUser(c);
      const subs = await listUserSubscriptions(c.env, user);
      const memberInfo = await describeSubscriptionMembers(c.env, subs);
      return c.json({ subscriptions: subs.map((sub) => publicSubscription(sub, false, memberInfo.get(sub.id))) });
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }
  });

  r.get('/commands', async (c) => {
    try {
      const user = await requireUser(c);
      return c.json({ commands: await listCommands(c.env, user.id, parseIntOrUndef(c.req.query('limit')) ?? 20) });
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }
  });

  r.get('/commands/:id', async (c) => {
    try {
      const user = await requireUser(c);
      const id = c.req.param('id');
      const command = await getCommand(c.env, user.id, id);
      if (!command) return c.json({ error: 'command not found' }, 404);
      // One-time credential disclosure: the first owner-authenticated read of
      // a succeeded command claims and destroys result_secret. Every later
      // read (and every list/replay path) sees only the redacted result.
      if (command.status !== 'succeeded') return c.json({ command });
      const claimed = await claimCommandResultSecret(c.env, user.id, id);
      if (!claimed) return c.json({ command });
      return c.json({ command: { ...command, result: mergeClaimedSecret(command.result, claimed) } });
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }
  });

  r.post('/commands', async (c) => {
    let user: User;
    let body: Record<string, unknown>;
    try {
      user = await requireUser(c);
      body = await readJson(c);
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }

    let type: ClientCommandType;
    try {
      type = commandType(body.type ?? body.kind);
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }

    const payload = body.payload ?? body.input ?? {};
    const idempotencyKey =
      (typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()) ||
      c.req.header('Idempotency-Key') ||
      null;

    // Replay by idempotency key. A terminal (succeeded/failed/canceled) row is
    // always a valid, permanent replay target. A queued/running row is only
    // replayed while it's plausibly still being executed (isStaleInFlightCommand
    // — see state.ts); once it's sat past that TTL with no terminal status, the
    // owning request/worker is presumed dead and we fall through to reclaim +
    // re-enqueue the same row below instead of replaying a status that can
    // never change.
    const existing = await findCommandByIdempotencyKey(c.env, user.id, idempotencyKey);
    if (existing && !isStaleInFlightCommand(existing)) {
      return c.json({ command: existing, replayed: true }, 200);
    }

    let command: ClientCommand;
    if (existing) {
      const reclaimed = await reclaimStaleInFlightCommand(c.env, user.id, existing.id);
      if (!reclaimed) {
        const current = await findCommandByIdempotencyKey(c.env, user.id, idempotencyKey);
        if (current) return c.json({ command: current, replayed: true }, 200);
        return c.json({ error: 'a duplicate command is already in flight; retry shortly' }, 409);
      }
      command = reclaimed;
    } else {
      try {
        command = await createCommand(c.env, { userId: user.id, type, payload, idempotencyKey });
      } catch (err) {
        // True concurrent-duplicate race: our lookup above saw nothing, but a
        // peer request's INSERT for the same (user, idempotencyKey) committed
        // first and won the unique-index race. Replay its row (or 409 if it
        // vanished between the failed insert and this re-fetch) instead of
        // letting the raw D1 constraint violation surface as a 500.
        if (err instanceof DuplicateCommandError && idempotencyKey) {
          const won = await findCommandByIdempotencyKey(c.env, user.id, idempotencyKey);
          if (won) return c.json({ command: won, replayed: true }, 200);
          return c.json({ error: 'a duplicate command is already in flight; retry shortly' }, 409);
        }
        throw err;
      }
    }

    // Enqueue FIRST as the durable backstop: if this request dies mid-flight
    // (or inline execution below overruns its budget), the tick still runs the
    // command. The queue dedupes on commandId, so reclaim re-enqueues and
    // redeliveries stay idempotent.
    try {
      await c.env.INGEST_QUEUE.send({
        type: 'command.execute',
        commandId: command.id,
        userId: user.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed = await updateCommandStatus(c.env, user.id, command.id, 'failed', {
        error: `command enqueue failed: ${message}`,
      });
      return c.json({ command: failed, error: 'command enqueue failed' }, 503);
    }

    // Then try to finish it INLINE, inside this request. Commands are typed by
    // a human waiting on a screen (redeem an App Store purchase, create a
    // delivery), but the durable queue is drained by the background tick — one
    // minute apart on the paid profile, five on free, and behind whatever
    // ingest work the tick claims first. The iOS client only polls
    // GET /commands/:id for ~18s, so a purchase that Apple had already charged
    // surfaced as "Request failed" while the redeem sat queued (owner report,
    // 2026-08-13 TestFlight). Inline execution collapses that to one round
    // trip; the enqueued message is what covers the cases it cannot.
    //
    // executeQueuedCommand is idempotent — it re-reads the row and no-ops
    // unless it is still queued/running — so the later queue delivery of a
    // command finished here is a cheap read, not a second execution.
    try {
      await Promise.race([
        executeQueuedCommand(c.env, command.id, user.id),
        new Promise<void>((resolve) => setTimeout(resolve, INLINE_COMMAND_BUDGET_MS)),
      ]);
    } catch {
      // executeQueuedCommand already recorded the failure on the row; a
      // non-ClientInputError rethrow here must not 500 the request, because
      // the terminal status it just wrote is exactly what the client needs.
    }

    const settled = (await getCommand(c.env, user.id, command.id)) ?? command;
    // 200 once terminal, 202 while it is still the queue's problem — the
    // client polls on queued/running either way.
    const terminal = settled.status === 'succeeded' || settled.status === 'failed' ||
      settled.status === 'canceled';
    // Inline create_subscription used to return the redacted row and never
    // GET /commands/:id, so the one-time secret sat unclaimed (DELIVERYALERTS-01).
    // Claim it here for the creating user. Do not log the secret.
    if (settled.status === 'succeeded') {
      const claimed = await claimCommandResultSecret(c.env, user.id, settled.id);
      if (claimed) {
        return c.json({
          command: { ...settled, result: mergeClaimedSecret(settled.result, claimed) },
        }, 200);
      }
    }
    return c.json({ command: settled }, terminal ? 200 : 202);
  });

  return r;
}

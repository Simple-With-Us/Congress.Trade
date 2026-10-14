import type { Env, QueueMessage } from "../shared/types.ts";
import { maybeAlertTerminalDurableIngestFailure } from "../ingestion/pipelineLoudAlerts.ts";
import {
  AUTOPILOT_BUDGET_SETTLEMENT_WRITER,
  LLM_SPEND_SETTLEMENT_WRITER,
  createAutopilotBudgetSettlementWriter,
  createLlmSpendSettlementWriter,
} from "../shared/llmSpend.ts";

export const DURABLE_QUEUE_MAX_BATCH_SIZE = 100;
export const DURABLE_QUEUE_DEFAULT_LIMIT = 25;
export const DURABLE_QUEUE_DEFAULT_CLAIM_SIZE = 10;
export const DURABLE_QUEUE_DEFAULT_LEASE_MS = 10 * 60_000;
export const DURABLE_QUEUE_DEFAULT_MAX_ATTEMPTS = 8;
/** Terminal cap on dead-letter recovery cycles. Without this, a DLQ receipt
 * whose recovery handler keeps throwing non-terminally loops forever —
 * stealing drain budget and spamming dead_letter_events on every cycle. */
export const DURABLE_QUEUE_MAX_DEAD_LETTER_CYCLES = 8;
export const DURABLE_QUEUE_RETRY_BASE_MS = 30_000;
export const DURABLE_QUEUE_RETRY_MAX_MS = 30 * 60_000;

export type DurableQueueName = "ingest" | "delivery";

export interface DurableQueueSendOptions {
  delaySeconds?: number;
}

export interface DurableQueueBatchMessage<Message>
  extends DurableQueueSendOptions {
  body: Message;
}

export interface DurableQueueHandlers {
  handleIngestMessage(
    env: Env,
    message: QueueMessage,
    attempts: number,
    lease: DurableQueueLeaseContext,
  ): Promise<void>;
  handleDeliveryMessage(
    env: Env,
    message: QueueMessage,
    lease: DurableQueueLeaseContext,
  ): Promise<boolean>;
  handleDeadLetterMessage(
    env: Env,
    queueName: string,
    message: QueueMessage,
    attempts: number,
    lease: DurableQueueLeaseContext,
  ): Promise<void>;
  handleCorruptDeadLetterMessage(
    env: Env,
    queueName: string,
    message: unknown,
    attempts: number,
    error: string,
    lease: DurableQueueLeaseContext,
  ): Promise<void>;
  isTerminalDeadLetterError(
    message: QueueMessage,
    error: unknown,
  ): boolean;
  completeIngestionOutbox(env: Env, docId: string): Promise<unknown>;
  completeDeliveryOutbox(env: Env, txId: string): Promise<unknown>;
}

export interface DurableQueueDrainOptions {
  limit?: number;
  claimSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
  now?: () => Date;
  /** Stops claiming/handling new messages when aborted (caller deadline). */
  signal?: AbortSignal;
}

export interface DurableQueueDrainResult {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
}

export interface DurableQueueLeaseContext {
  readonly signal: AbortSignal;
  assertOwned(): Promise<void>;
  renew(): Promise<void>;
}

export class DurableQueueLeaseLostError extends Error {
  constructor(message = "durable queue lease is no longer owned") {
    super(message);
    this.name = "DurableQueueLeaseLostError";
  }
}

interface DurableQueueRow {
  id: number | string;
  queue_name: string;
  payload: string;
  status: string;
  attempts: number | string;
  dead_letter_pending: number | string;
  /** Recovery cycles completed for a dead-lettered receipt (migration 0064;
   * absent on pre-migration schemas, hence optional). */
  dead_letter_cycles?: number | string;
  available_at: string;
  lease_until: string | null;
  lease_token: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface D1ResultLike<T = unknown> {
  success?: boolean;
  results?: T[];
  error?: string;
  meta?: unknown;
}

function resultOrThrow<T>(
  result: D1ResultLike<T>,
  operation: string,
): D1ResultLike<T> {
  if (result.success === false) {
    throw new Error(
      `${operation}: ${result.error || "database operation failed"}`,
    );
  }
  return result;
}

async function allOrThrow<T>(
  statement: D1PreparedStatement,
  operation: string,
): Promise<T[]> {
  const result = resultOrThrow(
    await statement.all<T>() as unknown as D1ResultLike<T>,
    operation,
  );
  return result.results ?? [];
}

async function runOrThrow(
  statement: D1PreparedStatement,
  operation: string,
): Promise<D1ResultLike> {
  return resultOrThrow(
    await statement.run() as unknown as D1ResultLike,
    operation,
  );
}

function normalizedDelaySeconds(delaySeconds: number | undefined): number {
  if (delaySeconds === undefined) return 0;
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
    throw new Error("queue delaySeconds must be a finite non-negative number");
  }
  return Math.floor(delaySeconds);
}

function retryDelayMs(attempts: number, error?: unknown): number {
  if (error && typeof error === "object") {
    const delaySeconds = (error as { delaySeconds?: unknown }).delaySeconds;
    if (
      typeof delaySeconds === "number" &&
      Number.isFinite(delaySeconds) &&
      delaySeconds >= 0
    ) {
      return Math.floor(delaySeconds * 1_000);
    }
  }
  const exponent = Math.max(0, attempts - 1);
  return Math.min(
    DURABLE_QUEUE_RETRY_MAX_MS,
    DURABLE_QUEUE_RETRY_BASE_MS * (2 ** exponent),
  );
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

function queueDedupeKey(
  queueName: DurableQueueName,
  value: unknown,
): string | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  const type = typeof message.type === "string" ? message.type : "";
  const key = (...parts: unknown[]) =>
    `${queueName}:${type}:${parts.map((part) => String(part ?? "")).join(":")}`;
  switch (type) {
    case "filing.new":
    case "filing.fetched":
    case "filing.extracted":
    case "filing.local_wait_check":
      return typeof message.docId === "string" ? key(message.docId) : null;
    case "tx.persisted":
      return typeof message.txId === "string" ? key(message.txId) : null;
    case "agreement.check":
      return typeof message.docId === "string"
        ? key(message.docId, message.claimToken, message.escalationTier)
        : null;
    case "delivery.dispatch":
      return typeof message.txId === "string"
        ? key(message.txId, message.subscriptionId, message.afterSubscriptionId)
        : null;
    case "usage.telemetry": {
      const event = message.event as Record<string, unknown> | undefined;
      return typeof event?.idempotencyKey === "string"
        ? key(event.idempotencyKey)
        : null;
    }
    case "command.execute":
      // One active execution per command row; re-enqueues of the same
      // command (stale reclaim, redelivery) dedupe while one is in flight.
      return typeof message.commandId === "string" ? key(message.commandId) : null;
    case "autopilot.tick":
      // Per-tick uniqueness: continuation re-enqueues while the prior claim is
      // still `processing`, so a stable runId-only key would collide.
      return typeof message.runId === "string" &&
          typeof (message as { tickId?: unknown }).tickId === "string"
        ? key(message.runId, (message as { tickId: string }).tickId)
        : typeof message.runId === "string"
          // Legacy messages (pre-tickId) keep run-scoped dedupe.
          ? key(message.runId)
          : null;
    default:
      return null;
  }
}

function requireString(
  value: unknown,
  field: string,
  type: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid ${type} queue message: ${field} is required`);
  }
}

/** Reject malformed or cross-queue payloads instead of silently acknowledging them. */
export function assertCanonicalQueueMessage(
  queueName: DurableQueueName,
  value: unknown,
): asserts value is QueueMessage {
  if (!value || typeof value !== "object") {
    throw new Error(`invalid ${queueName} queue message: expected an object`);
  }
  const message = value as Record<string, unknown>;
  const type = message.type;
  if (typeof type !== "string") {
    throw new Error(`invalid ${queueName} queue message: type is required`);
  }

  if (queueName === "delivery") {
    if (type !== "delivery.dispatch") {
      throw new Error(`invalid delivery queue message type: ${type}`);
    }
    requireString(message.txId, "txId", type);
    return;
  }

  switch (type) {
    case "filing.new":
      requireString(message.docId, "docId", type);
      requireString(message.sourceUrl, "sourceUrl", type);
      if (!["house", "senate", "executive"].includes(String(message.chamber))) {
        throw new Error(`invalid ${type} queue message: chamber is required`);
      }
      return;
    case "filing.fetched":
    case "filing.extracted":
    // Local vision wait polls — enqueued by classifyFiling for scanned_pdf
    // when a local worker heartbeat is fresh. Missing this case dead-lettered
    // every scanned filing with "invalid ingest queue message type:
    // filing.local_wait_check" (prod 2026-08-04/05: 1540 durable + 270 outbox).
    case "filing.local_wait_check":
      requireString(message.docId, "docId", type);
      return;
    case "tx.persisted":
      requireString(message.txId, "txId", type);
      requireString(message.docId, "docId", type);
      return;
    case "agreement.check":
      requireString(message.docId, "docId", type);
      if (
        message.rawObjectKey !== null &&
        typeof message.rawObjectKey !== "string"
      ) {
        throw new Error(
          `invalid ${type} queue message: rawObjectKey must be a string or null`,
        );
      }
      return;
    case "autopilot.tick":
      requireString(message.runId, "runId", type);
      // tickId is required for new enqueues (unique active-dedupe). Accept
      // legacy in-flight messages that only carry runId so deploys don't
      // dead-letter already-queued ticks.
      if (message.tickId !== undefined) {
        requireString(message.tickId, "tickId", type);
      }
      return;
    case "command.execute":
      requireString(message.commandId, "commandId", type);
      requireString(message.userId, "userId", type);
      return;
    case "usage.telemetry":
      if (!message.event || typeof message.event !== "object") {
        throw new Error(
          "invalid usage.telemetry queue message: event is required",
        );
      }
      return;
    default:
      throw new Error(`invalid ingest queue message type: ${type}`);
  }
}

/** Cloudflare Queue-compatible producer backed by the shared Turso database. */
export class DurableQueueAdapter<Message> {
  constructor(
    private readonly db: D1Database,
    private readonly queueName: DurableQueueName,
    private readonly now: () => Date = () => new Date(),
    private readonly beforePersist?: () => Promise<void>,
  ) {}

  /** Return an equivalent producer that revalidates ownership at its write boundary. */
  withWriteGuard(guard: () => Promise<void>): DurableQueueAdapter<Message> {
    return new DurableQueueAdapter(
      this.db,
      this.queueName,
      this.now,
      async () => {
        await this.beforePersist?.();
        await guard();
      },
    );
  }

  async send(
    message: Message,
    options?: DurableQueueSendOptions,
  ): Promise<void> {
    await this.sendBatch([{
      body: message,
      delaySeconds: options?.delaySeconds,
    }]);
  }

  async sendBatch(
    messages: DurableQueueBatchMessage<Message>[],
  ): Promise<void> {
    if (messages.length === 0) return;
    if (messages.length > DURABLE_QUEUE_MAX_BATCH_SIZE) {
      throw new Error(
        `queue batch exceeds ${DURABLE_QUEUE_MAX_BATCH_SIZE} messages`,
      );
    }

    const createdAt = this.now();
    const valuesSql: string[] = [];
    const bindings: unknown[] = [];
    for (const message of messages) {
      assertCanonicalQueueMessage(this.queueName, message.body);
      const delaySeconds = normalizedDelaySeconds(message.delaySeconds);
      const availableAt = new Date(createdAt.getTime() + delaySeconds * 1_000)
        .toISOString();
      const payload = JSON.stringify(message.body);
      if (payload === undefined) {
        throw new Error("queue message is not JSON serializable");
      }
      valuesSql.push("(?, ?, ?, 'pending', 0, 0, ?, NULL, NULL, NULL, ?, ?)");
      bindings.push(
        this.queueName,
        queueDedupeKey(this.queueName, message.body),
        payload,
        availableAt,
        createdAt.toISOString(),
        createdAt.toISOString(),
      );
    }

    // `send()` delegates here and `sendBatch()` can be called directly. Check
    // at the final persistence boundary so construction time cannot outlive
    // the queue message lease unnoticed.
    await this.beforePersist?.();
    await runOrThrow(
      this.db.prepare(`
        INSERT OR IGNORE INTO deno_runtime_queue
          (queue_name, dedupe_key, payload, status, attempts, dead_letter_pending,
           available_at, lease_until,
           lease_token, last_error, created_at, updated_at)
        VALUES ${valuesSql.join(", ")}
      `).bind(...bindings),
      `persist ${this.queueName} queue batch`,
    );
  }
}

async function claimMessages(
  db: D1Database,
  queueName: DurableQueueName,
  limit: number,
  now: Date,
  leaseMs: number,
): Promise<DurableQueueRow[]> {
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
  const leaseToken = crypto.randomUUID();
  return await allOrThrow<DurableQueueRow>(
    db.prepare(`
      UPDATE deno_runtime_queue
      SET status = 'processing',
          attempts = attempts + 1,
          lease_until = ?,
          lease_token = ?,
          updated_at = ?
      WHERE id IN (
        SELECT id FROM (
          SELECT id, available_at, payload FROM deno_runtime_queue
          WHERE queue_name = ? AND status = 'pending' AND available_at <= ?
          UNION ALL
          SELECT id, available_at, payload FROM deno_runtime_queue
          WHERE queue_name = ? AND status = 'processing' AND lease_until <= ?
        )
        -- Prefer review-queue autonomy work over usage.telemetry spam on the
        -- free-tier drain budget (3 msgs / 5 min). Telemetry still drains,
        -- just after agreement/autopilot and normal ingest messages.
        -- json_valid guards corrupt payloads (dead-letter resume tests / DLQ).
        ORDER BY CASE
                   WHEN json_valid(payload) THEN
                     CASE json_extract(payload, '$.type')
                       WHEN 'agreement.check' THEN 0
                       WHEN 'autopilot.tick' THEN 0
                       WHEN 'usage.telemetry' THEN 2
                       ELSE 1
                     END
                   ELSE 1
                 END,
                 available_at ASC, id ASC
        LIMIT ?
      )
      RETURNING id, queue_name, payload, status, attempts, available_at,
                dead_letter_pending, dead_letter_cycles, lease_until,
                lease_token, last_error, created_at, updated_at
    `).bind(leaseUntil, leaseToken, nowIso, queueName, nowIso, queueName, nowIso, limit),
    `claim ${queueName} queue messages`,
  );
}

async function transitionClaim(
  db: D1Database,
  row: DurableQueueRow,
  sql: string,
  bindings: unknown[],
  operation: string,
): Promise<boolean> {
  const rows = await allOrThrow<{ id: number | string }>(
    db.prepare(`${sql} RETURNING id`).bind(
      ...bindings,
      row.id,
      row.lease_token,
    ),
    operation,
  );
  return rows.length === 1;
}

class ClaimedLeaseContext implements DurableQueueLeaseContext {
  readonly signal: AbortSignal;
  private readonly abortController = new AbortController();
  private lostError: Error | null = null;
  private lastVerifiedMs: number | null = null;

  constructor(
    private readonly db: D1Database,
    private readonly row: DurableQueueRow,
    private readonly leaseMs: number,
    private readonly now: () => Date,
  ) {
    this.signal = this.abortController.signal;
  }

  /**
   * Successful ownership checks stay fresh for a short window so the
   * lease-fencing proxies do not pay a Turso round trip per statement. The
   * window is bounded well below the heartbeat interval (leaseMs / 3): a lost
   * lease is still surfaced by the next renew(), which records the loss and
   * fails every subsequent assert immediately. A successful assert/renew also
   * proves ownership until `lease_until`, so reuse inside the window cannot
   * let a stale owner write after another worker reclaimed the row.
   */
  private ownershipFreshMs(): number {
    return Math.max(1_000, Math.floor(this.leaseMs / 6));
  }

  private markLost(error: unknown): never {
    const normalized = error instanceof DurableQueueLeaseLostError
      ? error
      : new DurableQueueLeaseLostError(errorText(error));
    this.lostError = normalized;
    this.lastVerifiedMs = null;
    this.abortController.abort(normalized);
    throw normalized;
  }

  async assertOwned(): Promise<void> {
    if (this.lostError) throw this.lostError;
    const nowMs = this.now().getTime();
    if (
      this.lastVerifiedMs !== null &&
      nowMs - this.lastVerifiedMs < this.ownershipFreshMs()
    ) {
      return;
    }
    const current = new Date(nowMs).toISOString();
    try {
      const rows = await allOrThrow<{ id: number | string }>(
        this.db.prepare(`
          SELECT id
          FROM deno_runtime_queue
          WHERE id = ? AND status = 'processing' AND lease_token = ?
            AND lease_until IS NOT NULL AND lease_until > ?
          LIMIT 1
        `).bind(this.row.id, this.row.lease_token, current),
        `verify durable queue lease ${this.row.id}`,
      );
      if (rows.length !== 1) this.markLost(new DurableQueueLeaseLostError());
      this.lastVerifiedMs = nowMs;
    } catch (error) {
      this.markLost(error);
    }
  }

  async renew(): Promise<void> {
    if (this.lostError) throw this.lostError;
    const current = this.now();
    const currentIso = current.toISOString();
    const leaseUntil = new Date(current.getTime() + this.leaseMs).toISOString();
    try {
      const rows = await allOrThrow<{ id: number | string }>(
        this.db.prepare(`
          UPDATE deno_runtime_queue
          SET lease_until = ?, updated_at = ?
          WHERE id = ? AND status = 'processing' AND lease_token = ?
            AND lease_until IS NOT NULL AND lease_until > ?
          RETURNING id
        `).bind(
          leaseUntil,
          currentIso,
          this.row.id,
          this.row.lease_token,
          currentIso,
        ),
        `renew durable queue lease ${this.row.id}`,
      );
      if (rows.length !== 1) this.markLost(new DurableQueueLeaseLostError());
      // A successful renew is proof of ownership; seed the assertOwned()
      // freshness cache so the hot path skips redundant verification queries.
      this.lastVerifiedMs = current.getTime();
    } catch (error) {
      this.markLost(error);
    }
  }
}

function startLeaseHeartbeat(
  lease: ClaimedLeaseContext,
  leaseMs: number,
): () => Promise<void> {
  let stopped = false;
  let active: Promise<void> | null = null;
  const intervalMs = Math.max(1_000, Math.floor(leaseMs / 3));
  const timer = setInterval(() => {
    if (stopped || active) return;
    active = lease.renew()
      .catch(() => {
        // renew() records lease loss and aborts the signal. The foreground
        // ownership check turns it into the queue retry/terminal transition.
      })
      .finally(() => {
        active = null;
      });
  }, intervalMs);

  return async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  };
}

/**
 * Bind the claimed lease to every durable binding used by a handler. This is
 * the enforcement layer for stage implementations that do not know about the
 * Deno queue adapter: a stale worker cannot write/read Turso, R2/KV, or enqueue
 * another message after another worker has reclaimed the row.
 */
function leaseGuardedEnv(
  env: Env,
  lease: DurableQueueLeaseContext,
): Env {
  const statementTargets = new WeakMap<object, object>();

  const guardStatement = (statement: object): object => {
    const proxy = new Proxy(statement as Record<PropertyKey, unknown>, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === "bind" && typeof value === "function") {
          return (...args: unknown[]) =>
            guardStatement(value.apply(target, args) as object);
        }
        if (typeof value === "function") {
          return async (...args: unknown[]) => {
            await lease.assertOwned();
            return await value.apply(target, args);
          };
        }
        return value;
      },
    });
    statementTargets.set(proxy, statement);
    return proxy;
  };

  const db = new Proxy(env.DB as unknown as Record<PropertyKey, unknown>, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "prepare" && typeof value === "function") {
        return (sql: string) => guardStatement(value.call(target, sql));
      }
      if (property === "batch" && typeof value === "function") {
        return async (statements: object[]) => {
          await lease.assertOwned();
          return await value.call(
            target,
            statements.map((statement) => statementTargets.get(statement) ?? statement),
          );
        };
      }
      if (typeof value === "function") {
        return async (...args: unknown[]) => {
          await lease.assertOwned();
          return await value.apply(target, args);
        };
      }
      return value;
    },
  }) as unknown as D1Database;

  const guardedStreams = new WeakMap<object, object>();
  const guardReadableStream = <T>(stream: ReadableStream<T>): ReadableStream<T> => {
    const cached = guardedStreams.get(stream);
    if (cached) return cached as ReadableStream<T>;
    const guardReader = (reader: ReadableStreamDefaultReader<T>) => new Proxy(reader, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property === "releaseLock") return (...args: unknown[]) => value.apply(target, args);
        return async (...args: unknown[]) => {
          await lease.assertOwned();
          const result = await value.apply(target, args);
          await lease.assertOwned();
          return result;
        };
      },
    });
    const guarded = new Proxy(stream, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "getReader" && typeof value === "function") {
          return (...args: unknown[]) => guardReader(value.apply(target, args));
        }
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          await lease.assertOwned();
          const result = await value.apply(target, args);
          await lease.assertOwned();
          return result;
        };
      },
    }) as ReadableStream<T>;
    guardedStreams.set(stream, guarded);
    return guarded;
  };

  const guardBinding = <T extends object>(binding: T | undefined): T | undefined => {
    if (!binding) return undefined;
    return new Proxy(binding as Record<PropertyKey, unknown>, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === "body" && value instanceof ReadableStream) {
          return guardReadableStream(value);
        }
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          await lease.assertOwned();
          const result = await value.apply(target, args);
          await lease.assertOwned();
          if (
            (property === "createMultipartUpload" || property === "get") &&
            result && typeof result === "object"
          ) {
            return guardBinding(result as object);
          }
          return result;
        };
      },
    }) as T;
  };

  return new Proxy(env, {
    get(target, property, receiver) {
      // A stale worker is still responsible for accounting for a provider
      // response that was already billed. Expose only immutable/idempotent
      // settlement writers over the original DB; never expose the unfenced DB.
      if (property === LLM_SPEND_SETTLEMENT_WRITER) {
        return createLlmSpendSettlementWriter(target.DB);
      }
      if (property === AUTOPILOT_BUDGET_SETTLEMENT_WRITER) {
        return createAutopilotBudgetSettlementWriter(target.DB);
      }
      if (property === "DB") return db;
      if (property === "RAW_FILES") return guardBinding(target.RAW_FILES);
      if (property === "CONFIG_KV") return guardBinding(target.CONFIG_KV);
      if (property === "INGEST_QUEUE") {
        const queue = target.INGEST_QUEUE;
        return guardBinding(
          queue instanceof DurableQueueAdapter
            ? queue.withWriteGuard(() => lease.assertOwned())
            : queue,
        );
      }
      if (property === "DELIVERY_QUEUE") {
        const queue = target.DELIVERY_QUEUE;
        return guardBinding(
          queue instanceof DurableQueueAdapter
            ? queue.withWriteGuard(() => lease.assertOwned())
            : queue,
        );
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

async function completeClaim(
  db: D1Database,
  row: DurableQueueRow,
  now: Date,
): Promise<boolean> {
  return await transitionClaim(
    db,
    row,
    `UPDATE deno_runtime_queue
     SET status = 'completed', lease_until = NULL, lease_token = NULL,
         last_error = NULL, updated_at = ?
     WHERE lease_until > ? AND id = ? AND status = 'processing' AND lease_token = ?`,
    [now.toISOString(), now.toISOString()],
    `complete durable queue message ${row.id}`,
  );
}

async function retryClaim(
  db: D1Database,
  row: DurableQueueRow,
  now: Date,
  error: unknown,
): Promise<boolean> {
  const attempts = Number(row.attempts);
  const availableAt = new Date(now.getTime() + retryDelayMs(attempts, error))
    .toISOString();
  return await transitionClaim(
    db,
    row,
    `UPDATE deno_runtime_queue
     SET status = 'pending', available_at = ?, lease_until = NULL, lease_token = NULL,
         last_error = ?, updated_at = ?
     WHERE lease_until > ? AND id = ? AND status = 'processing' AND lease_token = ?`,
    [availableAt, errorText(error), now.toISOString(), now.toISOString()],
    `retry durable queue message ${row.id}`,
  );
}

async function retryDeadLetterClaim(
  db: D1Database,
  row: DurableQueueRow,
  now: Date,
  error: unknown,
): Promise<boolean> {
  const availableAt = new Date(
    now.getTime() + retryDelayMs(Number(row.attempts), error),
  ).toISOString();
  return await transitionClaim(
    db,
    row,
    `UPDATE deno_runtime_queue
     SET status = 'pending', dead_letter_pending = 1,
         dead_letter_cycles = COALESCE(dead_letter_cycles, 0) + 1,
         available_at = ?, lease_until = NULL, lease_token = NULL,
         last_error = ?, updated_at = ?
     WHERE lease_until > ? AND id = ? AND status = 'processing' AND lease_token = ?`,
    [availableAt, errorText(error), now.toISOString(), now.toISOString()],
    `retry durable dead-letter receipt ${row.id}`,
  );
}

async function failClaim(
  db: D1Database,
  row: DurableQueueRow,
  now: Date,
  error: unknown,
): Promise<boolean> {
  return await transitionClaim(
    db,
    row,
    `UPDATE deno_runtime_queue
     SET status = 'failed', dead_letter_pending = 0,
         lease_until = NULL, lease_token = NULL, last_error = ?, updated_at = ?
     WHERE lease_until > ? AND id = ? AND status = 'processing' AND lease_token = ?`,
    [errorText(error), now.toISOString(), now.toISOString()],
    `fail durable queue message ${row.id}`,
  );
}

async function failIngestQueueClaim(
  env: Env,
  queueName: DurableQueueName,
  row: DurableQueueRow,
  now: Date,
  error: unknown,
  message: QueueMessage | null,
): Promise<boolean> {
  const failed = await failClaim(env.DB, row, now, error);
  if (failed && queueName === "ingest" && message) {
    await maybeAlertTerminalDurableIngestFailure(
      env,
      message,
      errorText(error),
      now,
    );
  }
  return failed;
}

async function dispatchMessage(
  env: Env,
  queueName: DurableQueueName,
  message: QueueMessage,
  attempts: number,
  handlers: DurableQueueHandlers,
  lease: DurableQueueLeaseContext,
): Promise<void> {
  if (queueName === "delivery") {
    const shouldComplete = await handlers.handleDeliveryMessage(
      env,
      message,
      lease,
    );
    await lease.assertOwned();
    if (shouldComplete && message.type === "delivery.dispatch") {
      await handlers.completeDeliveryOutbox(env, message.txId);
    }
    return;
  }

  await handlers.handleIngestMessage(env, message, attempts, lease);
  await lease.assertOwned();
  if (message.type === "filing.new") {
    await handlers.completeIngestionOutbox(env, message.docId);
  }
}

export async function drainDurableQueue(
  env: Env,
  queueName: DurableQueueName,
  handlers: DurableQueueHandlers,
  options: DurableQueueDrainOptions = {},
): Promise<DurableQueueDrainResult> {
  const limit = Math.max(
    0,
    Math.floor(options.limit ?? DURABLE_QUEUE_DEFAULT_LIMIT),
  );
  const claimSize = Math.max(
    1,
    Math.floor(options.claimSize ?? DURABLE_QUEUE_DEFAULT_CLAIM_SIZE),
  );
  const leaseMs = Math.max(
    1_000,
    Math.floor(options.leaseMs ?? DURABLE_QUEUE_DEFAULT_LEASE_MS),
  );
  const maxAttempts = Math.max(
    1,
    Math.floor(options.maxAttempts ?? DURABLE_QUEUE_DEFAULT_MAX_ATTEMPTS),
  );
  const now = options.now ?? (() => new Date());
  const result: DurableQueueDrainResult = {
    claimed: 0,
    completed: 0,
    retried: 0,
    failed: 0,
  };

  while (result.claimed < limit) {
    if (options.signal?.aborted) break;
    const remaining = limit - result.claimed;
    const rows = await claimMessages(
      env.DB,
      queueName,
      Math.min(claimSize, remaining),
      now(),
      leaseMs,
    );
    if (rows.length === 0) break;
    result.claimed += rows.length;

    for (const row of rows) {
      if (options.signal?.aborted) break;
      const attempts = Number(row.attempts);
      let parsed: unknown;
      let canonicalMessage: QueueMessage | null = null;
      const lease = new ClaimedLeaseContext(env.DB, row, leaseMs, now);
      const guardedEnv = leaseGuardedEnv(env, lease);
      let stopHeartbeat: () => Promise<void> = async () => {};
      try {
        // Rows are claimed in batches and handled serially. Renew before any
        // handler starts so a row that expired while waiting cannot do work.
        await lease.renew();
        stopHeartbeat = startLeaseHeartbeat(lease, leaseMs);
      } catch {
        continue;
      }
      if (Number(row.dead_letter_pending) === 1) {
        try {
          try {
            parsed = JSON.parse(row.payload);
            try {
              assertCanonicalQueueMessage(queueName, parsed);
              canonicalMessage = parsed;
            } catch {
              canonicalMessage = null;
            }
          } catch {
            // Preserve malformed JSON as the raw string. This branch is a
            // resumed durable receipt, so parsing must never bypass the raw
            // corrupt-message handler and create an infinite retry loop.
            parsed = row.payload;
            canonicalMessage = null;
          }
          await lease.assertOwned();
          if (canonicalMessage) {
            await handlers.handleDeadLetterMessage(
              guardedEnv,
              `${queueName}-dlq`,
              canonicalMessage,
              attempts,
              lease,
            );
          } else {
            await handlers.handleCorruptDeadLetterMessage(
              guardedEnv,
              `${queueName}-dlq`,
              parsed,
              attempts,
              row.last_error || "invalid durable queue message",
              lease,
            );
          }
          await lease.assertOwned();
          await stopHeartbeat();
          if (
            await failIngestQueueClaim(
              env,
              queueName,
              row,
              now(),
              row.last_error || "message exhausted retries",
              canonicalMessage,
            )
          ) {
            result.failed += 1;
          }
        } catch (deadLetterError) {
          await stopHeartbeat();
          if (
            canonicalMessage &&
            handlers.isTerminalDeadLetterError(
              canonicalMessage,
              deadLetterError,
            )
          ) {
            if (
              await failIngestQueueClaim(
                env,
                queueName,
                row,
                now(),
                deadLetterError,
                canonicalMessage,
              )
            ) {
              result.failed += 1;
            }
            continue;
          }
          if (
            Number(row.dead_letter_cycles ?? 0) >=
            DURABLE_QUEUE_MAX_DEAD_LETTER_CYCLES
          ) {
            // Recovery budget exhausted: go terminal instead of looping the
            // poison receipt forever.
            if (
              await failIngestQueueClaim(
                env,
                queueName,
                row,
                now(),
                new Error(
                  `dead-letter recovery budget exhausted (${DURABLE_QUEUE_MAX_DEAD_LETTER_CYCLES} cycles): ${errorText(deadLetterError)}`,
                ),
                canonicalMessage,
              )
            ) {
              result.failed += 1;
            }
            continue;
          }
          if (
            await retryDeadLetterClaim(
              env.DB,
              row,
              now(),
              deadLetterError,
            )
          ) {
            result.retried += 1;
          }
        }
        continue;
      }
      try {
        parsed = JSON.parse(row.payload);
        assertCanonicalQueueMessage(queueName, parsed);
        canonicalMessage = parsed;
        await lease.assertOwned();
        await dispatchMessage(
          // Handlers see lease-fenced durable bindings. The original DB is
          // retained only by the adapter's own claim-transition code.
          guardedEnv,
          queueName,
          canonicalMessage,
          attempts,
          handlers,
          lease,
        );
        await lease.assertOwned();
        await stopHeartbeat();
        if (await completeClaim(env.DB, row, now())) result.completed += 1;
      } catch (error) {
        if (
          canonicalMessage &&
          handlers.isTerminalDeadLetterError(canonicalMessage, error)
        ) {
          await stopHeartbeat();
          if (await failIngestQueueClaim(env, queueName, row, now(), error, canonicalMessage)) {
            result.failed += 1;
          }
          continue;
        }
        if (attempts < maxAttempts) {
          await stopHeartbeat();
          if (await retryClaim(env.DB, row, now(), error)) result.retried += 1;
          continue;
        }

        try {
          if (canonicalMessage) {
            await handlers.handleDeadLetterMessage(
              guardedEnv,
              `${queueName}-dlq`,
              canonicalMessage,
              attempts,
              lease,
            );
          } else {
            await handlers.handleCorruptDeadLetterMessage(
              guardedEnv,
              `${queueName}-dlq`,
              parsed === undefined ? row.payload : parsed,
              attempts,
              errorText(error),
              lease,
            );
          }
          await lease.assertOwned();
          await stopHeartbeat();
        } catch (deadLetterError) {
          await stopHeartbeat();
          if (
            canonicalMessage &&
            handlers.isTerminalDeadLetterError(
              canonicalMessage,
              deadLetterError,
            )
          ) {
            if (
              await failIngestQueueClaim(
                env,
                queueName,
                row,
                now(),
                deadLetterError,
                canonicalMessage,
              )
            ) {
              result.failed += 1;
            }
            continue;
          }
          const terminalError = new Error(
            `${errorText(error)}; dead-letter recovery failed: ${
              errorText(deadLetterError)
            }`,
          );
          if (
            await retryDeadLetterClaim(
              env.DB,
              row,
              now(),
              terminalError,
            )
          ) {
            result.retried += 1;
          }
          continue;
        }
        if (await failIngestQueueClaim(env, queueName, row, now(), error, canonicalMessage)) {
          result.failed += 1;
        }
      }
    }
  }

  return result;
}

export async function drainDurableQueues(
  env: Env,
  handlers: DurableQueueHandlers,
  options: DurableQueueDrainOptions = {},
): Promise<
  { ingest: DurableQueueDrainResult; delivery: DurableQueueDrainResult }
> {
  const ingest = await drainDurableQueue(env, "ingest", handlers, options);
  const delivery = await drainDurableQueue(env, "delivery", handlers, options);
  return { ingest, delivery };
}

// ---------------------------------------------------------------------------
// Failed-job requeue (post-incident recovery)
// ---------------------------------------------------------------------------

export interface RequeueFailedDurableOptions {
  /** Queue to requeue from; default 'ingest'. */
  queue?: DurableQueueName;
  /** Optional payload `$.type` filter (e.g. 'filing.extracted'). */
  type?: string;
  /** Max rows to requeue in one call; default 500, hard cap 5000. */
  limit?: number;
  /** Count only — no writes. */
  dryRun?: boolean;
}

export interface RequeueFailedDurableResult {
  ok: boolean;
  queue: DurableQueueName;
  dryRun: boolean;
  /** Failed rows matching the filter. */
  matched: number;
  /** Rows actually reset to pending (matched minus dedupe conflicts). */
  requeued: number;
  /** Matching rows skipped because an active sibling holds the dedupe key. */
  skippedConflict: number;
  /** Failed-row counts grouped by payload type (for operator visibility). */
  byType: Record<string, number>;
}

/**
 * Reset terminally-failed durable-queue rows (status='failed') back to
 * 'pending' after a systemic consumer fix (e.g. the 2026-07 DLQ replay bug
 * that permanently failed non-filing.new ingest dead letters, or a provider
 * outage whose root cause is now resolved). This is the deno_runtime_queue
 * analogue of requeueFailedIngestionOutbox (ingestion_outbox table).
 *
 * Rows get a fresh start: attempts/dead-letter cycles zeroed, lease cleared,
 * immediately available. Rows whose dedupe key is already held by an active
 * (pending/processing) sibling are SKIPPED — requeuing them would violate
 * the active-dedupe unique index, and the active row will do the work anyway.
 * Idempotent: only rows still 'failed' are touched.
 */
export async function requeueFailedDurableJobs(
  env: Env,
  opts: RequeueFailedDurableOptions = {},
): Promise<RequeueFailedDurableResult> {
  const db = env.DB;
  const queue = opts.queue ?? "ingest";
  const rawLimit = Number(opts.limit ?? 500);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 5000) : 500;
  const nowIso = new Date().toISOString();

  const typeFilter = opts.type ? `AND json_extract(payload, '$.type') = ?` : "";
  const baseParams: unknown[] = opts.type ? [queue, opts.type] : [queue];

  const byTypeRows = await db
    .prepare(
      `SELECT json_extract(payload, '$.type') AS t, COUNT(*) AS n
         FROM deno_runtime_queue
        WHERE queue_name = ? AND status = 'failed' ${typeFilter}
        GROUP BY t`,
    )
    .bind(...baseParams)
    .all<{ t: string | null; n: number }>();
  const byType: Record<string, number> = {};
  let matched = 0;
  for (const row of byTypeRows.results ?? []) {
    byType[row.t ?? "unknown"] = Number(row.n);
    matched += Number(row.n);
  }

  if (opts.dryRun) {
    return { ok: true, queue, dryRun: true, matched, requeued: 0, skippedConflict: 0, byType };
  }

  // Subquery alias notes:
  // - the NOT EXISTS guard only applies when the failed row HAS a dedupe key;
  //   keyless rows always requeue safely;
  // - the MAX(q2.id) self-join keeps only the NEWEST failed row per dedupe
  //   key: the active-dedupe index tolerates any number of failed duplicates
  //   but exactly one active row, so requeuing two failed rows that share a
  //   key would violate it (the IN list is materialized before the update,
  //   so the active-sibling guard alone cannot see intra-batch duplicates).
  const update = await db
    .prepare(
      `UPDATE deno_runtime_queue
          SET status = 'pending', attempts = 0, last_error = NULL,
              lease_until = NULL, lease_token = NULL, dead_letter_pending = 0,
              dead_letter_cycles = 0, available_at = ?, updated_at = ?
        WHERE id IN (
          SELECT q.id FROM deno_runtime_queue q
           WHERE q.queue_name = ? AND q.status = 'failed' ${typeFilter}
             AND (
               q.dedupe_key IS NULL
               OR (
                 q.id = (
                   SELECT MAX(q2.id) FROM deno_runtime_queue q2
                    WHERE q2.queue_name = q.queue_name
                      AND q2.dedupe_key = q.dedupe_key
                      AND q2.status = 'failed'
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM deno_runtime_queue a
                    WHERE a.queue_name = q.queue_name
                      AND a.dedupe_key = q.dedupe_key
                      AND a.status IN ('pending', 'processing')
                 )
               )
             )
           ORDER BY q.id
           LIMIT ?
        )`,
    )
    .bind(nowIso, nowIso, ...baseParams, limit)
    .run();

  const requeued = Number(update.meta?.changes ?? 0);
  return {
    ok: true,
    queue,
    dryRun: false,
    matched,
    requeued,
    skippedConflict: Math.max(0, Math.min(matched, limit) - requeued),
    byType,
  };
}

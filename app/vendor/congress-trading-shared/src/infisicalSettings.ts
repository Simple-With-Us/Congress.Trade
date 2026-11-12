// =============================================================================
// infisicalSettings — zero-dependency Infisical settings client (fleet-shared)
// =============================================================================
//
// This module is the fleet-wide reference implementation of the Infisical
// sole-source-of-truth pattern (see INFISICAL.md at the repo root).  It is a
// generic client: TypeScript apps import it, point it at their own Infisical
// project, and get the canonical cache/refresh/write-through contract with
// zero new runtime dependencies (global `fetch` only).
//
// Contract summary:
//   - init()     loads every secret for the project+environment into an
//                in-memory Map at startup.  Startup fails fast on error.
//   - get()/getAll()/has()/getRequired()  read memory ONLY.  They never touch
//                the network, so they are safe in hot request/tick paths.
//   - refresh()  re-reads Infisical and swaps the cache on success.  On
//                failure it logs LOUDLY and keeps serving the last-known-good
//                cache — staleness is safer than an outage.
//   - set()      is write-through: it writes to Infisical FIRST, then updates
//                the cache.  If the Infisical write fails the save fails — the
//                cache and Infisical are never allowed to diverge silently.
//   - stop()     clears the background refresh timer.
//
// Auth: Infisical universal auth.  The clientId/clientSecret come from the
// options, falling back to the INFISICAL_CLIENT_ID / INFISICAL_CLIENT_SECRET
// environment variables.  Secret VALUES are never printed, echoed, or logged —
// names and metadata only.
//
// Added as an explicit owner-directed exception (2026-10-03) to this repo's
// "do not add app runtime code here" rule: the library itself holds no
// secrets, but it is the home of the reusable pattern for the whole fleet.
// See the Infisical section in AGENTS.md.

export interface InfisicalSettingsOptions {
  /** Infisical project ID (the workspaceId), e.g. "6a953a29-8397-4a9d-a5a5-7d1b61e4a5e7". */
  projectId: string;
  /** Infisical environment slug, e.g. "dev", "staging", or "prod". */
  environment: string;
  /**
   * Background cache refresh interval in milliseconds.  Defaults to 300000
   * (5 minutes).  Values <= 0 disable the background timer (manual
   * refresh() calls still work).
   */
  refreshIntervalMs?: number;
  /** Infisical instance base URL.  Defaults to "https://app.infisical.com". */
  infisicalUrl?: string;
  /** Universal-auth client ID.  Defaults to the INFISICAL_CLIENT_ID env var. */
  clientId?: string;
  /** Universal-auth client secret.  Defaults to the INFISICAL_CLIENT_SECRET env var. */
  clientSecret?: string;
  /**
   * fetch implementation.  Defaults to globalThis.fetch.  Inject a mock in
   * tests; pass a custom fetch if you need proxies or retries.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional hook invoked after a failed background refresh has already been
   * logged loudly.  Useful for alerting; never receives secret values.
   */
  onRefreshError?: (error: Error) => void;
}

/** Thrown when a write-through `set()` cannot persist the value to Infisical. */
export class InfisicalWriteError extends Error {
  readonly key: string;
  constructor(key: string, message: string, options?: { cause?: unknown }) {
    super(`Infisical write-through failed for key "${key}": ${message}`);
    this.name = "InfisicalWriteError";
    this.key = key;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Thrown when init()/refresh() cannot load settings from Infisical. */
export class InfisicalLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`Infisical settings load failed: ${message}`);
    this.name = "InfisicalLoadError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

const DEFAULT_REFRESH_INTERVAL_MS = 300_000; // 5 minutes, per the canonical pattern.
const DEFAULT_INFISICAL_URL = "https://app.infisical.com";
const DEFAULT_SECRET_PATH = "/";
const LOG_PREFIX = "[infisical-settings]";

interface RawSecret {
  secretKey: string;
  secretValue: string;
}

interface RawSecretsResponse {
  secrets: RawSecret[];
}

interface LoginResponse {
  accessToken: string;
  expiresIn?: number;
}

/**
 * Read an environment variable without depending on Node globals, so the
 * module stays portable (Node, workers, edge runtimes).  In Node this reads
 * process.env; elsewhere it returns undefined.
 */
function readEnv(name: string): string | undefined {
  const proc = (globalThis as Record<string, unknown>)["process"] as
    | { env?: Record<string, string | undefined> }
    | undefined;
  return proc?.env?.[name];
}

function envOr(value: string | undefined, name: string): string | undefined {
  return value ?? readEnv(name);
}

export interface InfisicalSettings {
  /** Authenticate and load the full settings set into memory.  Call once at startup. */
  init(): Promise<void>;
  /** Read a value from the in-memory cache.  Never hits the network. */
  get(key: string): string | undefined;
  /** Read a value, throwing a clear error (naming the key, pointing at INFISICAL.md) if absent. */
  getRequired(key: string): string;
  /** True when the key is present in the in-memory cache.  Never hits the network. */
  has(key: string): boolean;
  /** Snapshot of the whole in-memory cache as a plain object.  Never hits the network. */
  getAll(): Record<string, string>;
  /**
   * Write-through save: persists to Infisical FIRST, then updates the cache.
   * Rejects with InfisicalWriteError (cache untouched) when the Infisical
   * write fails.
   */
  set(key: string, value: string): Promise<void>;
  /**
   * Re-read Infisical and swap the cache on success.  On failure logs loudly
   * and keeps the last-known-good cache.  Called automatically by the
   * background timer; call it on demand (SIGHUP, admin "Reload settings",
   * applicationDidBecomeActive) as needed.
   */
  refresh(): Promise<void>;
  /** Clear the background refresh timer.  Call on shutdown. */
  stop(): void;
}

class InfisicalSettingsClient implements InfisicalSettings {
  private readonly projectId: string;
  private readonly environment: string;
  private readonly refreshIntervalMs: number;
  private readonly infisicalUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onRefreshError?: (error: Error) => void;

  private cache = new Map<string, string>();
  private accessToken: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private initialized = false;

  constructor(options: InfisicalSettingsOptions) {
    if (!options.projectId) {
      throw new Error("createInfisicalSettings: projectId is required");
    }
    if (!options.environment) {
      throw new Error("createInfisicalSettings: environment is required");
    }
    const clientId = envOr(options.clientId, "INFISICAL_CLIENT_ID");
    const clientSecret = envOr(options.clientSecret, "INFISICAL_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      throw new Error(
        "createInfisicalSettings: universal-auth credentials are required — pass clientId/clientSecret or set INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET",
      );
    }
    this.projectId = options.projectId;
    this.environment = options.environment;
    this.refreshIntervalMs =
      options.refreshIntervalMs === undefined
        ? DEFAULT_REFRESH_INTERVAL_MS
        : options.refreshIntervalMs;
    this.infisicalUrl = (options.infisicalUrl ?? DEFAULT_INFISICAL_URL).replace(/\/+$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onRefreshError = options.onRefreshError;
  }

  async init(): Promise<void> {
    await this.login();
    await this.loadIntoCache();
    this.initialized = true;
    if (this.refreshIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.backgroundRefresh();
      }, this.refreshIntervalMs);
      // Don't keep the process alive just for settings refresh.
      const maybeUnref = this.timer as { unref?: () => void };
      if (typeof maybeUnref.unref === "function") {
        maybeUnref.unref();
      }
    }
  }

  get(key: string): string | undefined {
    this.assertInitialized();
    return this.cache.get(key);
  }

  getRequired(key: string): string {
    const value = this.get(key);
    if (value === undefined) {
      throw new Error(
        `Missing required Infisical setting "${key}" (project ${this.projectId}, environment "${this.environment}"). ` +
          `Add it to the Infisical project and restart — see INFISICAL.md.`,
      );
    }
    return value;
  }

  has(key: string): boolean {
    this.assertInitialized();
    return this.cache.has(key);
  }

  getAll(): Record<string, string> {
    this.assertInitialized();
    return Object.fromEntries(this.cache);
  }

  async set(key: string, value: string): Promise<void> {
    this.assertInitialized();
    await this.ensureToken();
    // Write-through: Infisical FIRST, cache only after the write succeeds.
    await this.persistSecret(key, value);
    this.cache.set(key, value);
  }

  async refresh(): Promise<void> {
    this.assertInitialized();
    await this.ensureToken();
    await this.loadIntoCache();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // -- internals ------------------------------------------------------------

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("InfisicalSettings: call init() before reading or writing settings");
    }
  }

  private async backgroundRefresh(): Promise<void> {
    try {
      await this.refresh();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      // LOUD log, then keep serving the last-known-good cache.
      console.error(
        `${LOG_PREFIX} Refresh failed for project ${this.projectId} environment "${this.environment}": ${err.message}. ` +
          `Serving last-known-good cache (${this.cache.size} keys); staleness is safer than an outage.`,
      );
      this.onRefreshError?.(err);
    }
  }

  private async login(): Promise<void> {
    const url = `${this.infisicalUrl}/api/v1/auth/universal-auth/login`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: this.clientId, clientSecret: this.clientSecret }),
      });
    } catch (error) {
      throw new InfisicalLoadError(`universal-auth login request failed for ${this.infisicalUrl}`, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new InfisicalLoadError(
        `universal-auth login failed with HTTP ${response.status} for ${this.infisicalUrl} — check client ID/secret`,
      );
    }
    const data = (await response.json()) as LoginResponse;
    if (!data.accessToken) {
      throw new InfisicalLoadError("universal-auth login response did not include an accessToken");
    }
    this.accessToken = data.accessToken;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  private async ensureToken(): Promise<void> {
    if (!this.accessToken) {
      await this.login();
    }
  }

  /** GET the full raw secret set and swap it into the cache.  Throws on failure. */
  private async loadIntoCache(): Promise<void> {
    const params = new URLSearchParams({
      workspaceId: this.projectId,
      environment: this.environment,
      secretPath: DEFAULT_SECRET_PATH,
    });
    const url = `${this.infisicalUrl}/api/v3/secrets/raw?${params.toString()}`;
    let response = await this.getWithReauth(url);
    if (!response.ok) {
      throw new InfisicalLoadError(
        `GET ${this.describeSecretsEndpoint()} returned HTTP ${response.status}`,
      );
    }
    const data = (await response.json()) as RawSecretsResponse;
    const next = new Map<string, string>();
    for (const secret of data.secrets ?? []) {
      if (secret.secretKey !== undefined) {
        next.set(secret.secretKey, secret.secretValue ?? "");
      }
    }
    this.cache = next;
  }

  /** GET with a single re-login + retry on 401. */
  private async getWithReauth(url: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: this.authHeaders() });
    } catch (error) {
      throw new InfisicalLoadError(`GET ${this.describeSecretsEndpoint()} request failed`, {
        cause: error,
      });
    }
    if (response.status === 401) {
      await this.login();
      response = await this.fetchImpl(url, { headers: this.authHeaders() });
    }
    return response;
  }

  private describeSecretsEndpoint(): string {
    return `/api/v3/secrets/raw (project ${this.projectId}, environment "${this.environment}")`;
  }

  /**
   * Persist one secret to Infisical.  PATCHes the existing secret; creates it
   * with POST when it does not exist yet (404).  Never touches the cache —
   * the caller updates the cache only after this resolves.
   */
  private async persistSecret(key: string, value: string): Promise<void> {
    const encodedKey = encodeURIComponent(key);
    const url = `${this.infisicalUrl}/api/v3/secrets/raw/${encodedKey}`;
    const write = async (method: "PATCH" | "POST"): Promise<Response> => {
      return this.fetchImpl(url, {
        method,
        headers: { ...this.authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: this.projectId,
          environment: this.environment,
          secretPath: DEFAULT_SECRET_PATH,
          secretValue: value,
          type: "shared",
        }),
      });
    };

    let response: Response;
    try {
      response = await write("PATCH");
    } catch (error) {
      throw new InfisicalWriteError(key, "PATCH request failed", { cause: error });
    }
    if (response.status === 401) {
      // Token may have expired mid-flight: re-login once and retry the PATCH.
      await this.login();
      try {
        response = await write("PATCH");
      } catch (error) {
        throw new InfisicalWriteError(key, "PATCH request failed after re-login", { cause: error });
      }
    }
    if (response.status === 404) {
      // Secret does not exist yet — create it.
      try {
        response = await write("POST");
      } catch (error) {
        throw new InfisicalWriteError(key, "POST (create) request failed", { cause: error });
      }
    }
    if (!response.ok) {
      throw new InfisicalWriteError(key, `Infisical returned HTTP ${response.status}`);
    }
  }
}

/**
 * Create a zero-dependency Infisical settings client for one project and
 * environment.  Call `init()` once at startup, read with `get()`/`getAll()`,
 * save admin changes with `set()`, and call `stop()` on shutdown.
 */
export function createInfisicalSettings(options: InfisicalSettingsOptions): InfisicalSettings {
  return new InfisicalSettingsClient(options);
}

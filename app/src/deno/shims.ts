import type { Client, InStatement } from "npm:@libsql/client/web";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";

// --- D1Database Shim ---

export class D1PreparedStatementShim {
  private client: Client;
  private query: string;
  private params: any[];

  constructor(client: Client, query: string, params: any[] = []) {
    this.client = client;
    this.query = query;
    this.params = params;
  }

  bind(...values: any[]): D1PreparedStatementShim {
    return new D1PreparedStatementShim(this.client, this.query, values);
  }

  async all<T = any>(): Promise<
    { success: boolean; results: T[]; error?: string; meta: any }
  > {
    try {
      const res = await this.client.execute({
        sql: this.query,
        args: this.params,
      });
      return {
        success: true,
        results: res.rows as unknown as T[],
        meta: d1Meta(res),
      };
    } catch (e: any) {
      // Cloudflare D1 rejects failed statements. Propagating here is critical
      // for durable producers: a failed INSERT must never look like an accepted
      // queue message to its caller.
      throw new Error(`D1 statement error: ${e.message}`, { cause: e });
    }
  }

  async first<T = any>(colName?: string): Promise<T | null> {
    const res = await this.client.execute({
      sql: this.query,
      args: this.params,
    });
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    if (colName) {
      return (row[colName] ?? null) as T;
    }
    return row as unknown as T;
  }

  async run<T = any>(): Promise<
    { success: boolean; results: T[]; error?: string; meta: any }
  > {
    return this.all<T>();
  }

  get statement(): InStatement {
    return { sql: this.query, args: this.params };
  }
}

export class D1DatabaseShim {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  prepare(query: string): D1PreparedStatementShim {
    return new D1PreparedStatementShim(this.client, query);
  }

  async batch<T = any>(
    statements: D1PreparedStatementShim[],
  ): Promise<{ success: boolean; results: T[]; error?: string; meta: any }[]> {
    try {
      const stmts = statements.map((s) => s.statement);
      // libsql `batch(stmts, "write")` already runs the batch inside a single
      // write transaction. Wrapping with explicit BEGIN IMMEDIATE/COMMIT made
      // every multi-statement write fail with:
      //   SQLITE_ERROR: cannot start a transaction within a transaction
      // which broke review confirm/reject, watcher inserts, and cron lanes.
      // Let libsql own BEGIN/COMMIT via the write-mode batch.
      const res = await this.client.batch(stmts, "write");
      return res.map((r) => ({
        success: true,
        results: r.rows as unknown as T[],
        meta: d1Meta(r),
      }));
    } catch (e: any) {
      throw new Error(`D1 batch error: ${e.message}`);
    }
  }
}

function d1Meta(result: {
  rows: unknown[];
  rowsAffected: number;
  lastInsertRowid?: bigint;
}) {
  return {
    changes: result.rowsAffected,
    last_row_id: result.lastInsertRowid == null
      ? 0
      : Number(result.lastInsertRowid),
    changed_db: result.rowsAffected > 0,
    rows_read: result.rows.length,
    rows_written: result.rowsAffected,
    duration: 0,
    size_after: 0,
  };
}

// --- KVNamespace Shim ---

/**
 * CONFIG_KV key prefixes that must NEVER be mirrored into the primary
 * application database. That DB is a plain SQLite file
 * (/data/congress-trade/db.sqlite) browsed by the sqlite-web sidecar and
 * copied into backups/archives, so a raw session token written there is a
 * bearer credential at rest. Everything else is refetchable cache and
 * belongs in SQL so it survives container restarts.
 * KEEP IN SYNC WITH: SESSION_PREFIX (src/auth/session.ts:22),
 * MAGIC_PREFIX (src/auth/magic.ts:11), and the Infisical cache key built at
 * src/secrets/infisical.ts:296/427/448.
 */
export const KV_NEVER_MIRROR_PREFIXES = ['sess:', 'magic:', 'infisical_secrets_cache:'] as const;

export class KVNamespaceShim {
  private kv: Deno.Kv;
  private prefix: string;
  private getDb?: () => D1DatabaseShim | null;

  constructor(kv: Deno.Kv, prefix: string = "kv", getDb?: () => D1DatabaseShim | null) {
    this.kv = kv;
    this.prefix = prefix;
    this.getDb = getDb;
  }

  private useTurso(key: string): D1DatabaseShim | null {
    if (!this.getDb) return null;
    const db = this.getDb();
    if (!db) return null;
    if (KV_NEVER_MIRROR_PREFIXES.some((prefix) => key.startsWith(prefix))) return null;
    return db;
  }

  async get(
    key: string,
    type?: "text" | "json" | "arrayBuffer" | "stream",
  ): Promise<any> {
    const db = this.useTurso(key);
    if (db) {
      const row = await db.prepare('SELECT value, expires_at FROM deno_runtime_kv WHERE namespace = ? AND key = ?').bind(this.prefix, key).first<{value: string, expires_at: number | null}>();
      if (!row) return null;
      if (row.expires_at !== null && row.expires_at < Math.floor(Date.now() / 1000)) {
        // Lazy delete in background
        db.prepare('DELETE FROM deno_runtime_kv WHERE namespace = ? AND key = ?').bind(this.prefix, key).run().catch(() => {});
        return null;
      }
      if (type === "json") return JSON.parse(row.value);
      return row.value;
    }

    const res = await this.kv.get([this.prefix, key]);
    if (!res.value) return null;
    if (type === "json") {
      return typeof res.value === "string" ? JSON.parse(res.value) : res.value;
    }
    return res.value;
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    let valToStore = value;
    if (typeof value !== "string" && !(value instanceof ArrayBuffer)) {
      throw new Error("Streams not supported in KVNamespaceShim yet");
    }

    const db = this.useTurso(key);
    if (db) {
      if (typeof value !== "string") {
        throw new Error("Only strings are supported for Turso-backed KV keys");
      }
      const expiresAt = options?.expirationTtl ? Math.floor(Date.now() / 1000) + options.expirationTtl : null;
      await db.prepare('INSERT INTO deno_runtime_kv (namespace, key, value, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(namespace, key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at').bind(this.prefix, key, value, expiresAt).run();
      return;
    }

    await this.kv.set(
      [this.prefix, key],
      valToStore,
      options?.expirationTtl
        ? { expireIn: options.expirationTtl * 1000 }
        : undefined,
    );
  }

  async delete(key: string): Promise<void> {
    const db = this.useTurso(key);
    if (db) {
      await db.prepare('DELETE FROM deno_runtime_kv WHERE namespace = ? AND key = ?').bind(this.prefix, key).run();
      return;
    }
    await this.kv.delete([this.prefix, key]);
  }

  /**
   * Atomically read-and-delete a key. Returns the value, or null if the key
   * was absent/expired or another request won the race. Single-use
   * credentials must use this: get()+delete() lets two concurrent requests
   * both observe the value before either delete lands.
   */
  async take(key: string): Promise<string | null> {
    const db = this.useTurso(key);
    if (db) {
      const nowSec = Math.floor(Date.now() / 1000);
      const res = await db
        .prepare(
          'DELETE FROM deno_runtime_kv WHERE namespace = ? AND key = ? ' +
            'AND (expires_at IS NULL OR expires_at > ?) RETURNING value',
        )
        .bind(this.prefix, key, nowSec)
        .all<{ value: string }>();
      const row = res.results?.[0];
      return row ? row.value : null;
    }

    const entry = await this.kv.get<string>([this.prefix, key]);
    if (entry.value === null || entry.value === undefined || entry.versionstamp === null) return null;
    const value = entry.value;
    const committed = await this.kv
      .atomic()
      .check({ key: [this.prefix, key], versionstamp: entry.versionstamp })
      .delete([this.prefix, key])
      .commit();
    if (!committed.ok) return null; // another request consumed it first
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
}

// --- S3Bucket Shim ---

export class S3BucketShim {
  private s3: S3Client;
  private bucketName: string;

  constructor(s3: S3Client, bucketName: string) {
    this.s3 = s3;
    this.bucketName = bucketName;
  }

  async get(key: string): Promise<
    {
      body: ReadableStream;
      httpMetadata: { contentType?: string };
      arrayBuffer: () => Promise<ArrayBuffer>;
      text: () => Promise<string>;
      json: () => Promise<any>;
    } | null
  > {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });
      const response = await this.s3.send(command);
      if (!response.Body) return null;
      const bodyStream = response.Body as any;
      return {
        body: bodyStream,
        httpMetadata: { contentType: response.ContentType },
        async arrayBuffer() {
          const arr = await response.Body?.transformToByteArray();
          return (arr ? arr.buffer : new ArrayBuffer(0)) as ArrayBuffer;
        },
        async text() {
          return await response.Body?.transformToString() ?? "";
        },
        async json() {
          const t = await response.Body?.transformToString();
          return t ? JSON.parse(t) : null;
        },
      };
    } catch (e: any) {
      // Only a genuine missing object is a cache miss. Authentication,
      // entitlement, TLS, and provider outages must reject so the durable
      // queue can retry instead of acknowledging lost RAW_FILES access.
      const name = String(e?.name ?? "");
      const code = String(
        e?.Code ?? e?.code ?? e?.$metadata?.httpStatusCode ?? "",
      );
      if (
        name === "NoSuchKey" ||
        name === "NotFound" ||
        code === "NoSuchKey" ||
        code === "NotFound" ||
        code === "404"
      ) {
        return null;
      }
      throw e;
    }
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ReadableStream | Blob,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: value as any,
      ContentType: options?.httpMetadata?.contentType,
    });
    await this.s3.send(command);

    const headCommand = new HeadObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });
    await this.s3.send(headCommand);
  }

  async delete(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });
    await this.s3.send(command);
  }

  /**
   * ListObjectsV2 mapped onto the Workers `R2Bucket.list()` shape.
   *
   * Deno prod previously had no enumeration at all, so anything needing to find
   * objects whose keys it does not already know (the bulk-snapshot prune) could
   * not run outside the Workers runtime. Only the fields callers actually read
   * are mapped: `key`, `size`, `uploaded`, plus `delimitedPrefixes` for
   * delimiter queries. One S3 call per page; the caller bounds the page count.
   */
  async list(
    options?: {
      prefix?: string;
      limit?: number;
      cursor?: string;
      delimiter?: string;
    },
  ): Promise<
    {
      objects: Array<{ key: string; size: number; uploaded: Date }>;
      truncated: boolean;
      cursor?: string;
      delimitedPrefixes: string[];
    }
  > {
    const response = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: options?.prefix,
        MaxKeys: options?.limit,
        ContinuationToken: options?.cursor,
        Delimiter: options?.delimiter,
      }),
    );
    const objects = (response.Contents ?? [])
      .filter((entry): entry is typeof entry & { Key: string } =>
        typeof entry.Key === "string"
      )
      .map((entry) => ({
        key: entry.Key,
        size: entry.Size ?? 0,
        uploaded: entry.LastModified ?? new Date(0),
      }));
    const truncated = response.IsTruncated === true;
    return {
      objects,
      truncated,
      // R2 omits the cursor entirely once a listing is complete; mirror that so
      // `while (result.truncated)` loops terminate the same way they do on
      // Workers instead of re-listing page one forever.
      ...(truncated && response.NextContinuationToken
        ? { cursor: response.NextContinuationToken }
        : {}),
      delimitedPrefixes: (response.CommonPrefixes ?? [])
        .map((entry) => entry.Prefix)
        .filter((prefix): prefix is string => typeof prefix === "string"),
    };
  }

  async createMultipartUpload(
    key: string,
    options?: { httpMetadata?: { contentType?: string } },
  ) {
    const created = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: options?.httpMetadata?.contentType,
      }),
    );
    if (!created.UploadId) {
      throw new Error("S3 multipart upload did not return an upload id");
    }
    const uploadId = created.UploadId;
    const s3 = this.s3;
    const bucketName = this.bucketName;
    return {
      key,
      uploadId,
      async uploadPart(partNumber: number, value: unknown) {
        const uploaded = await s3.send(
          new UploadPartCommand({
            Bucket: bucketName,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: value as any,
          }),
        );
        if (!uploaded.ETag) {
          throw new Error(
            `S3 multipart part ${partNumber} did not return an ETag`,
          );
        }
        return { partNumber, etag: uploaded.ETag };
      },
      async complete(parts: Array<{ partNumber: number; etag: string }>) {
        await s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucketName,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
              Parts: parts.map((part) => ({
                PartNumber: part.partNumber,
                ETag: part.etag,
              })),
            },
          }),
        );
      },
      async abort() {
        await s3.send(
          new AbortMultipartUploadCommand({
            Bucket: bucketName,
            Key: key,
            UploadId: uploadId,
          }),
        );
      },
    };
  }
}

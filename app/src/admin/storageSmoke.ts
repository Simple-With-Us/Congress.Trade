export type StorageSmokeStage = "put" | "get" | "contents" | "delete";

export interface StorageSmokeObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * The shared subset implemented by Cloudflare's R2Bucket and the Deno S3 shim.
 */
export interface StorageSmokeBucket {
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<StorageSmokeObjectBody | null>;
  delete(key: string): Promise<unknown>;
}

export interface StorageSmokeResult {
  ok: true;
  bytes: number;
  checks: {
    put: true;
    get: true;
    contents: true;
    delete: true;
  };
}

export class StorageSmokeError extends Error {
  readonly stage: StorageSmokeStage;
  readonly priorStage?: Exclude<StorageSmokeStage, "delete">;

  constructor(
    stage: StorageSmokeStage,
    priorStage?: Exclude<StorageSmokeStage, "delete">,
  ) {
    super(`RAW_FILES storage verification failed during ${stage}`);
    this.name = "StorageSmokeError";
    this.stage = stage;
    this.priorStage = priorStage;
  }
}

const KEY_PREFIX = "storage-smoke/";
const PAYLOAD = "congress.trade RAW_FILES storage smoke v1\n";

/**
 * Performs one bounded write/read/delete round trip against RAW_FILES.
 *
 * The random key and provider errors are intentionally omitted from the result
 * and thrown errors so this helper is safe to expose through an authenticated
 * diagnostic route.
 */
export async function verifyRawFilesStorage(
  bucket: StorageSmokeBucket,
): Promise<StorageSmokeResult> {
  const key = `${KEY_PREFIX}${crypto.randomUUID()}.txt`;
  const expectedBytes = new TextEncoder().encode(PAYLOAD);
  let primaryFailure: StorageSmokeError | undefined;
  let cleanupFailure: StorageSmokeError | undefined;

  try {
    try {
      await bucket.put(key, PAYLOAD, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
      });
    } catch {
      throw new StorageSmokeError("put");
    }

    let object: StorageSmokeObjectBody | null;
    try {
      object = await bucket.get(key);
    } catch {
      throw new StorageSmokeError("get");
    }
    if (!object) throw new StorageSmokeError("get");

    let actualBytes: Uint8Array;
    try {
      actualBytes = new Uint8Array(await object.arrayBuffer());
    } catch {
      throw new StorageSmokeError("get");
    }

    const bytesMatch = actualBytes.byteLength === expectedBytes.byteLength &&
      actualBytes.every((byte, index) => byte === expectedBytes[index]);
    const textMatches = new TextDecoder().decode(actualBytes) === PAYLOAD;
    if (!bytesMatch || !textMatches) throw new StorageSmokeError("contents");
  } catch (error) {
    primaryFailure = error instanceof StorageSmokeError
      ? error
      : new StorageSmokeError("contents");
  } finally {
    try {
      await bucket.delete(key);
    } catch {
      cleanupFailure = new StorageSmokeError(
        "delete",
        primaryFailure?.stage === "delete" ? undefined : primaryFailure?.stage,
      );
    }
  }

  // Prefer the first real failure. If put/get failed and cleanup also 401s,
  // reporting delete hides the actual store-auth problem (live 2026-08-18).
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;

  return {
    ok: true,
    bytes: expectedBytes.byteLength,
    checks: {
      put: true,
      get: true,
      contents: true,
      delete: true,
    },
  };
}

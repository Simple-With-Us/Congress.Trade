import { describe, expect, it, vi } from 'vitest';
import {
  StorageSmokeError,
  verifyRawFilesStorage,
  type StorageSmokeBucket,
} from '../storageSmoke.ts';

function arrayBufferFor(value: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function fakeBucket() {
  const objects = new Map<string, string>();
  const put = vi.fn(async (key: string, value: string) => {
    objects.set(key, value);
  });
  const get = vi.fn(async (key: string) => {
    const value = objects.get(key);
    return value === undefined ? null : { arrayBuffer: async () => arrayBufferFor(value) };
  });
  const remove = vi.fn(async (key: string) => {
    objects.delete(key);
  });
  return {
    bucket: { put, get, delete: remove } satisfies StorageSmokeBucket,
    objects,
    put,
    get,
    remove,
  };
}

describe('verifyRawFilesStorage', () => {
  it('completes a bounded round trip and removes the test object', async () => {
    const fake = fakeBucket();

    await expect(verifyRawFilesStorage(fake.bucket)).resolves.toEqual({
      ok: true,
      bytes: 42,
      checks: { put: true, get: true, contents: true, delete: true },
    });
    expect(fake.put).toHaveBeenCalledOnce();
    expect(fake.get).toHaveBeenCalledOnce();
    expect(fake.remove).toHaveBeenCalledOnce();
    expect(fake.objects.size).toBe(0);
    expect(fake.put.mock.calls[0][0]).toMatch(/^storage-smoke\/[0-9a-f-]{36}\.txt$/);
  });

  it('rejects wrong contents without exposing object or provider details', async () => {
    const fake = fakeBucket();
    fake.get.mockResolvedValueOnce({ arrayBuffer: async () => arrayBufferFor('wrong-secret-value') });

    const failure = await verifyRawFilesStorage(fake.bucket).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StorageSmokeError);
    expect(failure).toMatchObject({ stage: 'contents' });
    expect(String(failure)).not.toContain('wrong-secret-value');
    expect(fake.remove).toHaveBeenCalledOnce();
  });

  it('throws a secret-safe put failure', async () => {
    const fake = fakeBucket();
    fake.put.mockRejectedValueOnce(new Error('credential=put-secret'));

    const failure = await verifyRawFilesStorage(fake.bucket).catch((error: unknown) => error);
    expect(failure).toMatchObject({ stage: 'put' });
    expect(String(failure)).toBe('StorageSmokeError: RAW_FILES storage verification failed during put');
    expect(String(failure)).not.toContain('put-secret');
  });

  it('throws a secret-safe get failure', async () => {
    const fake = fakeBucket();
    fake.get.mockRejectedValueOnce(new Error('endpoint=get-secret'));

    const failure = await verifyRawFilesStorage(fake.bucket).catch((error: unknown) => error);
    expect(failure).toMatchObject({ stage: 'get' });
    expect(String(failure)).toBe('StorageSmokeError: RAW_FILES storage verification failed during get');
    expect(String(failure)).not.toContain('get-secret');
  });

  it('throws a secret-safe delete failure', async () => {
    const fake = fakeBucket();
    fake.remove.mockRejectedValueOnce(new Error('access-key=delete-secret'));

    const failure = await verifyRawFilesStorage(fake.bucket).catch((error: unknown) => error);
    expect(failure).toMatchObject({ stage: 'delete', priorStage: undefined });
    expect(String(failure)).toBe('StorageSmokeError: RAW_FILES storage verification failed during delete');
    expect(String(failure)).not.toContain('delete-secret');
  });

  it('always attempts cleanup after an earlier failure', async () => {
    const fake = fakeBucket();
    fake.put.mockRejectedValueOnce(new Error('write unavailable'));

    await expect(verifyRawFilesStorage(fake.bucket)).rejects.toMatchObject({ stage: 'put' });
    expect(fake.get).not.toHaveBeenCalled();
    expect(fake.remove).toHaveBeenCalledOnce();
    expect(fake.remove.mock.calls[0][0]).toMatch(/^storage-smoke\/[0-9a-f-]{36}\.txt$/);
  });

  it('reports put when put and cleanup both fail', async () => {
    const fake = fakeBucket();
    fake.put.mockRejectedValueOnce(new Error('Unauthorized'));
    fake.remove.mockRejectedValueOnce(new Error('Unauthorized'));

    await expect(verifyRawFilesStorage(fake.bucket)).rejects.toMatchObject({ stage: 'put' });
  });
});

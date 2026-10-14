/** Cooperative abort for cron lanes that receive a merged maintenance signal. */
export function abortIfSignal(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException('Aborted', 'AbortError');
}

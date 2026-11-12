/**
 * Peel a query string that a client percent-encoded into a path parameter.
 *
 * APICONTRACT-01: iOS `appendingPathComponent("member/id?sort=")` and similar
 * web concatenations turned `?` into `%3F`, so the server looked up
 * `C001047?sort=tx_date` and 404'd. Real query items still win when both
 * are present.
 */
export function peelEncodedQueryFromPathParam(raw: string): {
  id: string;
  query: Record<string, string>;
} {
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    value = raw;
  }
  const q = value.indexOf('?');
  if (q < 0) return { id: value, query: {} };
  const id = value.slice(0, q);
  const query: Record<string, string> = {};
  const params = new URLSearchParams(value.slice(q + 1));
  for (const [key, val] of params.entries()) {
    query[key] = val;
  }
  return { id, query };
}

/** Request query string is authoritative; peeled path leftovers fill gaps. */
export function mergePeeledQuery(
  requestQuery: Record<string, string>,
  peeled: Record<string, string>,
): Record<string, string> {
  return { ...peeled, ...requestQuery };
}

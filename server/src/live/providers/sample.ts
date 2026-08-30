// ── Response samples for diagnostics ──────────────────────────────────────────
//
// Shared by every adapter's probe(). A provider whose documentation does not show a
// whole response — bigballsdata does not — cannot be reasoned about from counts alone:
// what is needed is the shape, which keys wrap the list and what pagination sits beside
// it. This produces that, small enough to render in the admin UI and paste into a chat.

/**
 * The response with every array cut to its first element, as formatted JSON.
 *
 * Never contains credentials: this is a response body, and the API key travels in a
 * request header.
 */
export function trimmedSample(body: unknown, maxChars = 1200): string {
  const trim = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.length <= 1 ? value : [value[0], `…${value.length - 1} more`];
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trim(v)]));
    }
    return value;
  };

  const text = JSON.stringify(trim(body), null, 2) ?? String(body);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… truncated`;
}

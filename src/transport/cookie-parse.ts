/**
 * Parses an HTTP `Cookie` header and returns the value of the named cookie
 * (URI-decoded), or `undefined` if the cookie is not present.
 *
 * The `Cookie` header is a single string like `a=1; b=2; ory_kratos_session=xyz`.
 * This helper is intentionally minimal — it does NOT attempt to handle quoted
 * values, cookie attributes, or any of the legacy Set-Cookie syntax.
 */
export function extractCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  const pairs = header.split(/;\s*/);
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    if (p.slice(0, eq) === name) {
      return decodeURIComponent(p.slice(eq + 1));
    }
  }
  return undefined;
}

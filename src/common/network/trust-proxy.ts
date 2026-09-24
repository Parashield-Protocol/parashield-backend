/**
 * #494 — resolve Express's `trust proxy` setting from the TRUST_PROXY env var.
 *
 * Client IPs (used for rate limiting and operator-auth brute-force lockout)
 * are taken from `req.ip`, which Express derives from X-Forwarded-For only
 * for hops that are trusted here. With the default (`false`) the header is
 * ignored entirely and the TCP peer address is used, so a client cannot
 * spoof its identity by sending its own X-Forwarded-For.
 *
 * Accepted values:
 *   unset / "" / "false"   trust no proxies (default)
 *   "true"                 trust every hop — only safe if the app is never
 *                          reachable except through a proxy that overwrites
 *                          X-Forwarded-For
 *   "<n>"                  trust the n closest hops (e.g. "1" behind a
 *                          single load balancer)
 *   "<list>"               comma-separated IPs/CIDRs or Express presets
 *                          ("loopback", "linklocal", "uniquelocal")
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string[] {
  const raw = value?.trim();
  if (!raw || raw.toLowerCase() === 'false') return false;
  if (raw.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

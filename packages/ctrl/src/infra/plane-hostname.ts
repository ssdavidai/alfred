/**
 * Pure helpers for deriving Plane-addressable URLs from a tenant's
 * `customer_name`. Extracted from provisioner.ts so they can be unit tested
 * without dragging in the full provisioner surface (SSH, Hetzner client,
 * Nunjucks template imports, DB, etc).
 *
 * BACKGROUND — the Plane webhook URL bug (2026-04-23, David):
 *
 *   setupPlane() used to read `opts.subdomain`, which came from
 *   `instance.subdomain` in ctrl-db. On David's ctrl row that field had
 *   drifted to the pre-slug short form `alfred-david`, while the actual
 *   Cloudflare DNS + tunnel ingress used the full Hetzner-slug form
 *   `alfred-david-mnbqn4jg.alfred.black`. The webhook therefore registered
 *   at `https://alfred-david.alfred.black/...` — NXDOMAIN. Plane's 5-strike
 *   retry policy then disabled the webhook and reverse-sync silently
 *   stopped.
 *
 *   The robust fix is to derive the hostname from `customer_name`, which
 *   SaaS always generates as `alfred-<slug>-<base36ts>` and which Hetzner
 *   uses to name both the server and (via generateSubdomain) the DNS
 *   record. That removes the drift window entirely.
 */

export function generateSubdomain(customerName: string): string {
  // DNS-safe lowercase, underscore→hyphen. Must stay identical to the
  // provisioner's generateSubdomain (kept colocated in provisioner.ts and
  // re-exported from there for historical import sites).
  return customerName.toLowerCase().replace(/_/g, "-");
}

export function planeSlug(subdomain: string): string {
  // Plane workspace slugs are lowercased letters/numbers/hyphens only,
  // 2–48 chars. Our subdomain already matches /[a-z0-9-]+/ after
  // generateSubdomain(), so this is mostly a safety coerce in case the
  // subdomain ever widens.
  const s = subdomain
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length >= 2 ? s.slice(0, 48) : `alfred-${s}`.slice(0, 48);
}

/**
 * Derive the canonical Plane URLs (webhook, admin email, alfred email,
 * workspace slug) from the tenant's `customer_name`. Every field goes
 * through the same `generateSubdomain(customer_name)` projection that
 * Cloudflare DNS + cloudflared ingress use, so the webhook URL always
 * matches the tunnel hostname.
 */
export function planeHostnameFromCustomerName(
  customerName: string,
  domain = "alfred.black",
): {
  hostname: string;
  slug: string;
  adminEmail: string;
  alfredEmail: string;
  webhookUrl: string;
} {
  const hostname = generateSubdomain(customerName);
  return {
    hostname,
    slug: planeSlug(hostname),
    adminEmail: `admin@${hostname}.${domain}`,
    alfredEmail: `alfred@${hostname}.${domain}`,
    webhookUrl: `https://${hostname}.${domain}/api/v1/plane/webhook`,
  };
}

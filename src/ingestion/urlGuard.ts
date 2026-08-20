/**
 * SSRF guard for user-supplied URLs.
 *
 * This module is called before every outbound fetch and on every redirect hop.
 * It is deliberately conservative: false positives (blocking an edge-case
 * public IP) are far less harmful than false negatives (allowing a private
 * network request from the server).
 *
 * Residual DNS-rebinding gap: this guard resolves the hostname, then
 * Node's fetch resolves again. Between those two resolutions a fast DNS TTL
 * could point the name at a private address. For a local/self-hosted tool this
 * is an accepted risk. If this ever runs multi-tenant on shared infrastructure,
 * the fix is an egress proxy that pins the resolved IP into the TCP connection,
 * or using a proxy that rewrites requests to the already-resolved address.
 */

import { promises as dns } from "node:dns";

const MAX_URL_LENGTH = 2048;

class SsrfError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/** IPv4 CIDR block expressed as [network_int, mask_int]. */
type CidrV4 = [number, number];

const PRIVATE_V4: CidrV4[] = [
  // 0.0.0.0/8
  [0x00000000, 0xff000000],
  // 10.0.0.0/8
  [0x0a000000, 0xff000000],
  // 127.0.0.0/8
  [0x7f000000, 0xff000000],
  // 169.254.0.0/16  — link-local; includes cloud metadata 169.254.169.254
  [0xa9fe0000, 0xffff0000],
  // 172.16.0.0/12
  [0xac100000, 0xfff00000],
  // 192.0.0.0/24
  [0xc0000000, 0xffffff00],
  // 192.168.0.0/16
  [0xc0a80000, 0xffff0000],
  // 100.64.0.0/10  — CGNAT
  [0x64400000, 0xffc00000],
  // 198.18.0.0/15  — benchmarking
  [0xc6120000, 0xfffe0000],
  // 224.0.0.0/4    — multicast
  [0xe0000000, 0xf0000000],
  // 240.0.0.0/4    — reserved
  [0xf0000000, 0xf0000000],
];

function ipv4ToInt(addr: string): number {
  return addr
    .split(".")
    .reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

function isPrivateV4(addr: string): boolean {
  const n = ipv4ToInt(addr);
  return PRIVATE_V4.some(([net, mask]) => (n & mask) >>> 0 === (net >>> 0));
}

/** IPv4-mapped IPv6: ::ffff:a.b.c.d or ::ffff:aabb:ccdd */
function unmapV4(addr: string): string | null {
  const prefixDot = "::ffff:";
  if (addr.toLowerCase().startsWith(prefixDot)) {
    const rest = addr.slice(prefixDot.length);
    if (rest.includes(".")) return rest;
    const parts = rest.split(":");
    if (parts.length === 2) {
      const hi = parseInt(parts[0], 16);
      const lo = parseInt(parts[1], 16);
      return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    }
  }
  return null;
}

function isPrivateIPv6(addr: string): boolean {
  const low = addr.toLowerCase();
  if (low === "::" || low === "::1") return true;
  const first16 = parseInt(low.split(":")[0] || "0", 16);
  // fc00::/7 — ULA
  if ((first16 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 — link-local
  if ((first16 & 0xffc0) === 0xfe80) return true;
  // ff00::/8 — multicast
  if ((first16 & 0xff00) === 0xff00) return true;
  return false;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
]);

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith(".localhost")) return true;
  if (h.endsWith(".local")) return true;
  if (h.endsWith(".internal")) return true;
  return false;
}

/**
 * Validates that `input` is a safe, publicly-routable URL.
 * Throws a 400-shaped SsrfError on any violation.
 */
export async function assertFetchableUrl(input: string): Promise<URL> {
  if (input.length > MAX_URL_LENGTH) {
    throw new SsrfError(`URL exceeds maximum length of ${MAX_URL_LENGTH} characters.`);
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SsrfError("Invalid URL — could not parse.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(
      `URL protocol "${url.protocol}" is not allowed. Only http: and https: are supported.`
    );
  }

  if (url.username || url.password) {
    throw new SsrfError("URLs with embedded credentials are not allowed.");
  }

  if (isBlockedHostname(url.hostname)) {
    throw new SsrfError(`The hostname "${url.hostname}" is not allowed.`);
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.lookup(url.hostname, { all: true });
  } catch {
    throw new SsrfError(`Could not resolve hostname "${url.hostname}".`);
  }

  if (addresses.length === 0) {
    throw new SsrfError(`Hostname "${url.hostname}" resolved to no addresses.`);
  }

  for (const { address, family } of addresses) {
    if (family === 4) {
      if (isPrivateV4(address)) {
        throw new SsrfError(
          `The URL resolved to a private/reserved IP address (${address}), which is not allowed.`
        );
      }
    } else {
      const mapped = unmapV4(address);
      if (mapped !== null) {
        if (isPrivateV4(mapped)) {
          throw new SsrfError(
            `The URL resolved to a private/reserved IPv4-mapped address (${address}), which is not allowed.`
          );
        }
      } else if (isPrivateIPv6(address)) {
        throw new SsrfError(
          `The URL resolved to a private/reserved IPv6 address (${address}), which is not allowed.`
        );
      }
    }
  }

  return url;
}

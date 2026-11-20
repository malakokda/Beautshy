/**
 * Small helpers shared by everything that reads store websites. Server-only.
 *
 * Every download from another website goes through `download`, because some
 * addresses come from visitors (a pasted link, a store added by a link). It
 * refuses to connect to this server's own machine or private network, checks
 * that again after every redirect and at the moment of connecting (so a site
 * cannot pass the check and then point its name somewhere private), and stops
 * reading answers that are too large.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { Agent, fetch as undiciFetch } from "undici";

/** How the app introduces itself to the stores it reads. */
export const USER_AGENT = "BeautyDealFinder/1.0 (price comparison)";
/** How long downloaded store data is reused before it is downloaded again. */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** "www.Faces.eg" -> "faces.eg" */
export const siteName = (hostname: string) => hostname.toLowerCase().replace(/^www\./, "");

/* ---------- Addresses that must never be contacted ---------- */

const PRIVATE = new BlockList();
for (const [network, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // this machine
  ["169.254.0.0", 16], // link-local, including cloud metadata services
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
] as const) {
  PRIVATE.addSubnet(network, bits, "ipv4");
}
for (const [network, bits] of [
  ["::", 128], // unspecified
  ["::1", 128], // this machine
  ["64:ff9b::", 96], // IPv4 translation (NAT64)
  ["2002::", 16], // 6to4, which wraps an IPv4 address
  ["fc00::", 7], // private
  ["fe80::", 10], // link-local
  ["fec0::", 10], // old site-local
  ["ff00::", 8], // multicast
] as const) {
  PRIVATE.addSubnet(network, bits, "ipv6");
}

/** True for addresses on this machine or a private network. IPv4 written as IPv6 is covered too. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true; // not an address at all: refuse
  return PRIVATE.check(ip, family === 6 ? "ipv6" : "ipv4");
}

const PRIVATE_NAME = /^localhost$|\.localhost$|\.local$|\.internal$|\.home\.arpa$/i;

/** Refuse addresses that point at this machine or a private network. */
export async function isPublicHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (PRIVATE_NAME.test(host)) return false;
  try {
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    return addresses.length > 0 && addresses.every(({ address }) => !isPrivateAddress(address));
  } catch {
    return false;
  }
}

/**
 * Used when a connection is opened: looks the name up and refuses private
 * addresses, so the address checked is the address actually connected to.
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { family: options.family ?? 0, all: true }, (err, found) => {
    if (err) return callback(err, "");
    const addresses = found as LookupAddress[];
    if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
      const refused: NodeJS.ErrnoException = new Error(
        `refused: ${hostname} is not a public address`,
      );
      refused.code = "EREFUSED_PRIVATE";
      return callback(refused, "");
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

const publicOnly = new Agent({ connect: { lookup: publicOnlyLookup } });

/* ---------- Downloading ---------- */

export type Downloaded = { status: number; contentType: string; body: string };

/**
 * Download a page from another website.
 * - Only http(s) to public addresses; every redirect is checked the same way.
 * - Cookies the site sets are sent back while it redirects to itself
 *   (Faces answers the first request with a cookie and a redirect).
 * - Reading stops at `maxBytes`; the text read so far is returned.
 */
export async function download(
  address: string | URL,
  options: {
    accept: string;
    timeoutMs?: number;
    maxBytes?: number;
    /** Throw if a redirect leads to a different website. */
    sameSiteOnly?: boolean;
  },
): Promise<Downloaded> {
  const { accept, timeoutMs = 20_000, maxBytes = 15_000_000, sameSiteOnly = false } = options;
  const signal = AbortSignal.timeout(timeoutMs);
  const cookies = new Map<string, string>();
  let current = new URL(address);
  const firstHost = current.hostname;

  for (let hop = 0; hop <= 5; hop++) {
    if (current.protocol !== "https:" && current.protocol !== "http:") {
      throw new Error(`refused: ${current.protocol} is not a web address`);
    }
    const host = current.hostname.replace(/^\[|\]$/g, "");
    // Names are checked when connecting (publicOnlyLookup); bare addresses skip
    // the lookup, so they are checked here.
    if (PRIVATE_NAME.test(host) || (isIP(host) !== 0 && isPrivateAddress(host))) {
      throw new Error(`refused: ${host} is not a public address`);
    }
    const sameHost = current.hostname === firstHost;
    const res = await undiciFetch(current, {
      headers: {
        "user-agent": USER_AGENT,
        accept,
        ...(sameHost && cookies.size > 0
          ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") }
          : {}),
      },
      redirect: "manual",
      signal,
      dispatcher: publicOnly,
    });
    if (sameHost) {
      for (const cookie of res.headers.getSetCookie()) {
        const pair = cookie.split(";")[0]!;
        const equals = pair.indexOf("=");
        if (equals > 0) cookies.set(pair.slice(0, equals).trim(), pair.slice(equals + 1).trim());
      }
    }
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      await res.body?.cancel();
      const next = new URL(res.headers.get("location")!, current);
      if (sameSiteOnly && next.hostname !== firstHost) {
        throw new Error(`redirected away to ${next.hostname}`);
      }
      current = next;
      continue;
    }
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body: await readUpTo(res.body, maxBytes),
    };
  }
  throw new Error("too many redirects");
}

async function readUpTo(body: NodeReadableStream<Uint8Array> | null, maxBytes: number) {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

/** Download JSON. Throws when the site cannot be reached or answers with an error. */
export async function getJson<T>(url: string | URL, timeoutMs = 20_000): Promise<T> {
  const res = await download(url, { accept: "application/json", timeoutMs });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(res.body) as T;
}

/** Download JSON, or null when that fails for any reason. */
export async function tryGetJson<T>(url: string | URL, timeoutMs = 8_000): Promise<T | null> {
  try {
    return await getJson<T>(url, timeoutMs);
  } catch {
    return null;
  }
}

export type JsonLd = Record<string, unknown>;

/** The schema.org Product information that shops put in their pages for Google, if any. */
export function findJsonLdProduct(html: string): JsonLd | undefined {
  for (const block of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const product = productIn(JSON.parse(block[1]!));
      if (product) return product;
    } catch {
      /* ignore invalid JSON-LD */
    }
  }
  return undefined;
}

function productIn(node: unknown): JsonLd | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const product = productIn(child);
      if (product) return product;
    }
    return undefined;
  }
  if (!node || typeof node !== "object") return undefined;
  const obj = node as JsonLd;
  const type = obj["@type"];
  if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) return obj;
  return productIn(obj["@graph"]);
}

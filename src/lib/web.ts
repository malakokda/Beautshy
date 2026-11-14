/** Small helpers shared by everything that reads store websites. Server-only. */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** How the app introduces itself to the stores it reads. */
export const USER_AGENT = "BeautyDealFinder/1.0 (price comparison)";
/** How long downloaded store data is reused before it is downloaded again. */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** "www.Faces.eg" -> "faces.eg" */
export const siteName = (hostname: string) => hostname.toLowerCase().replace(/^www\./, "");

/** Download JSON. Throws when the site cannot be reached or answers with an error. */
export async function getJson<T>(url: string | URL, timeoutMs = 20_000): Promise<T> {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
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

/** Refuse addresses that point at this machine or a private network. */
export async function isPublicHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.local$|\.internal$/i.test(host)) return false;
  try {
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    return addresses.every(({ address }) => !isPrivateAddress(address));
  } catch {
    return false;
  }
}

function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v6 = ip.toLowerCase();
    if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
    return (
      v6 === "::1" ||
      v6 === "::" ||
      v6.startsWith("fc") ||
      v6.startsWith("fd") ||
      v6.startsWith("fe80")
    );
  }
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

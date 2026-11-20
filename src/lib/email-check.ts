/**
 * Which email addresses can sign up, and catching mistyped ones before an
 * account is made, so the confirmation code is not sent to an address nobody reads.
 *
 * Runs in the browser and on the server (no server-only imports here).
 */
import { typoDistance } from "./fuzzy-match";

/** New accounts must use one of these email providers. */
export const ALLOWED_EMAIL_DOMAINS = ["gmail.com", "yahoo.com", "icloud.com", "hotmail.com"];

export const NOT_ALLOWED_MESSAGE =
  "Please sign up with a Gmail, Yahoo, iCloud or Hotmail address " +
  "(ending in @gmail.com, @yahoo.com, @icloud.com or @hotmail.com).";

/** The provider names: "gmail", "yahoo", ... */
const PROVIDERS = ALLOWED_EMAIL_DOMAINS.map((domain) => domain.slice(0, domain.indexOf(".")));

/** Endings that are almost always a slip for ".com". */
const COM_SLIPS = new Set([
  "con",
  "cmo",
  "cpm",
  "vom",
  "xom",
  "comm",
  "ocm",
  "cim",
  "om",
  "cm",
  "co",
]);

function domainOf(email: string): string {
  return email
    .slice(email.lastIndexOf("@") + 1)
    .trim()
    .toLowerCase();
}

export function isAllowedEmail(email: string): boolean {
  return email.lastIndexOf("@") > 0 && ALLOWED_EMAIL_DOMAINS.includes(domainOf(email));
}

/**
 * The allowed address the person probably meant, or null when there is none.
 * "sara@gmial.com" gives "sara@gmail.com"; "sara@gmail.con" gives "sara@gmail.com".
 */
export function suggestEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1 || isAllowedEmail(email)) return null;
  const domain = domainOf(email);
  const dot = domain.lastIndexOf(".");
  if (dot < 1) return null;
  const name = domain.slice(0, dot);
  const ending = domain.slice(dot + 1);
  if (ending !== "com" && !COM_SLIPS.has(ending)) return null;

  let best: string | null = null;
  let bestDistance = 3;
  for (const provider of PROVIDERS) {
    if (provider[0] !== name[0]) continue; // the first letter is rarely the mistake
    const distance = typoDistance(name, provider, 2);
    const allowed = provider.length >= 6 ? 2 : 1;
    if (distance <= allowed && distance < bestDistance) {
      best = provider;
      bestDistance = distance;
    }
  }
  return best ? `${email.slice(0, at)}@${best}.com` : null;
}

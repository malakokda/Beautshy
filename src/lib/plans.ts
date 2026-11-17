/** The plans the site offers. Used by both the page and the server. */

/** Searches a free account gets in total. */
export const FREE_SEARCHES = 3;
/** Monthly price of the premium plan, in Egyptian pounds. */
export const PREMIUM_PRICE_EGP = 99;

/** What the page knows about the signed-in person. */
export type Account = {
  email: string;
  plan: "free" | "premium";
  searchesUsed: number;
  /** Free searches still available; null when searches are unlimited. */
  searchesLeft: number | null;
  /** True for the site owner (see ADMIN_EMAILS in .env). */
  isAdmin: boolean;
  /** True once this person has asked to upgrade and is waiting for the owner. */
  upgradeRequested: boolean;
};

/** One row of the owner's list of accounts. */
export type AccountRow = {
  userId: string;
  email: string;
  plan: "free" | "premium";
  searchesUsed: number;
  upgradeRequestedAt: string | null;
  createdAt: string;
};

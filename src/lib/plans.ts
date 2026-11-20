/** The plans the site offers. Used by both the page and the server. */

/** Searches a free account gets in total. */
export const FREE_SEARCHES = 3;
/** Monthly price of the premium plan, in Egyptian pounds. */
export const PREMIUM_PRICE_EGP = 99;
/** How long one card payment keeps an account premium. */
export const PREMIUM_DAYS = 30;

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
  /** When a paid premium plan ends; null when it does not end (or the plan is free). */
  premiumUntil: string | null;
  /** True when premium can be bought by card on the site (Paymob is set up). */
  cardPayments: boolean;
};

/** One row of the owner's list of accounts. */
export type AccountRow = {
  userId: string;
  email: string;
  plan: "free" | "premium";
  searchesUsed: number;
  upgradeRequestedAt: string | null;
  /** When a paid premium plan ends; null when it does not end. */
  premiumUntil: string | null;
  createdAt: string;
};

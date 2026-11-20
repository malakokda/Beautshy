import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// accounts.ts reads cookies through the framework and asks Supabase to check
// passwords; neither is needed here. The database is real: an in-memory Postgres.
vi.mock("@tanstack/react-start/server", () => ({
  getCookie: vi.fn(),
  setCookie: vi.fn(),
  deleteCookie: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  createSupabaseAuthClient: vi.fn(),
}));
import { createSupabaseAuthClient } from "@/integrations/supabase/client.server";
import {
  getAccount,
  isAdmin,
  listAccounts,
  requestUpgrade,
  reserveSearch,
  sessionToken,
  setPlan,
  signUp,
  userFromToken,
} from "./accounts";
import { query } from "./db";
import { NOT_ALLOWED_MESSAGE } from "./email-check";
import { FREE_SEARCHES } from "./plans";

const user = { id: "0b1c2d3e-0000-4000-8000-000000000001", email: "someone@example.com" };
const owner = { id: "0b1c2d3e-0000-4000-8000-000000000002", email: "owner@example.com" };

beforeAll(() => {
  process.env["SESSION_SECRET"] = "test-secret";
  process.env["ADMIN_EMAILS"] = "Owner@Example.com, second@example.com";
});
beforeEach(async () => {
  await query("delete from profiles");
});

describe("session cookie", () => {
  it("gives back the user it was made for", () => {
    const token = sessionToken(user, Date.now() + 60_000);
    expect(userFromToken(token)).toEqual(user);
  });

  it("rejects a missing, expired or altered cookie", () => {
    expect(userFromToken(undefined)).toBeNull();
    expect(userFromToken("nonsense")).toBeNull();
    expect(userFromToken(sessionToken(user, Date.now() - 1))).toBeNull();

    const [payload, signature] = sessionToken(user, Date.now() + 60_000).split(".");
    const forged = Buffer.from(
      JSON.stringify({ id: user.id, email: "owner@example.com", expires: Date.now() + 60_000 }),
    ).toString("base64url");
    expect(userFromToken(`${forged}.${signature}`)).toBeNull();
    expect(userFromToken(`${payload}.${"x".repeat(signature!.length)}`)).toBeNull();
  });
});

describe("signUp", () => {
  it("refuses other email providers without contacting Supabase", async () => {
    for (const email of ["sara@outlook.com", "sara@yahoo.com.eg", "sara@cu.edu.eg"]) {
      expect(await signUp(email, "a-good-password")).toEqual({
        ok: false,
        error: NOT_ALLOWED_MESSAGE,
      });
    }
    expect(createSupabaseAuthClient).not.toHaveBeenCalled();
  });
});

describe("isAdmin", () => {
  it("matches the owner's emails whatever the capital letters", () => {
    expect(isAdmin("owner@example.com")).toBe(true);
    expect(isAdmin("SECOND@example.com")).toBe(true);
    expect(isAdmin("someone@example.com")).toBe(false);
  });
});

describe("free plan", () => {
  it("starts with all free searches and counts each one", async () => {
    expect((await getAccount(user)).searchesLeft).toBe(FREE_SEARCHES);
    expect((await reserveSearch(user)).allowed).toBe(true);
    const account = await getAccount(user);
    expect(account.plan).toBe("free");
    expect(account.searchesUsed).toBe(1);
    expect(account.searchesLeft).toBe(FREE_SEARCHES - 1);
  });

  it("stops after the free searches are used", async () => {
    for (let i = 0; i < FREE_SEARCHES; i++) expect((await reserveSearch(user)).allowed).toBe(true);
    expect((await reserveSearch(user)).allowed).toBe(false);
    const account = await getAccount(user);
    expect(account.searchesLeft).toBe(0);
    expect(account.searchesUsed).toBe(FREE_SEARCHES);
  });

  it("never lets searches sent at the same moment exceed the allowance", async () => {
    const attempts = await Promise.all(
      Array.from({ length: FREE_SEARCHES + 4 }, () => reserveSearch(user)),
    );
    expect(attempts.filter((a) => a.allowed)).toHaveLength(FREE_SEARCHES);
    expect((await getAccount(user)).searchesUsed).toBe(FREE_SEARCHES);
  });

  it("gives a search back when it found nothing", async () => {
    const reservation = await reserveSearch(user);
    await reservation.refund();
    expect((await getAccount(user)).searchesLeft).toBe(FREE_SEARCHES);
  });

  it("records an upgrade request and shows it to the owner first", async () => {
    await getAccount(owner);
    await getAccount(user);
    await requestUpgrade(user);
    expect((await getAccount(user)).upgradeRequested).toBe(true);
    const rows = await listAccounts();
    expect(rows.map((row) => row.email)).toEqual([user.email, owner.email]);
    expect(rows[0]!.upgradeRequestedAt).not.toBeNull();
  });
});

describe("unlimited searching", () => {
  it("lets a premium account keep searching", async () => {
    for (let i = 0; i < FREE_SEARCHES; i++) await reserveSearch(user);
    await setPlan(user.id, "premium");
    expect((await reserveSearch(user)).allowed).toBe(true);
    const account = await getAccount(user);
    expect(account.plan).toBe("premium");
    expect(account.searchesLeft).toBeNull();
    expect(account.upgradeRequested).toBe(false);
  });

  it("lets the owner keep searching on a free plan", async () => {
    for (let i = 0; i < FREE_SEARCHES + 2; i++) {
      expect((await reserveSearch(owner)).allowed).toBe(true);
    }
    const account = await getAccount(owner);
    expect(account.isAdmin).toBe(true);
    expect(account.searchesLeft).toBeNull();
  });
});

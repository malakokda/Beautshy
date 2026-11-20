// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// accounts.ts reads cookies through the framework; not needed here.
vi.mock("@tanstack/react-start/server", () => ({
  getCookie: vi.fn(),
  setCookie: vi.fn(),
  deleteCookie: vi.fn(),
  getRequestProtocol: vi.fn(),
  getRequestHeader: vi.fn(),
  getRequestIP: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({ createSupabaseAuthClient: vi.fn() }));

import { getAccount, reserveSearch } from "./accounts";
import { query } from "./db";
import {
  egyptianMobile,
  handlePaymobCallback,
  signedText,
  startCardPayment,
  transactionSignature,
} from "./payments";
import { FREE_SEARCHES, PREMIUM_PRICE_EGP } from "./plans";

const SECRET = "test-hmac-secret";
const user = { id: "0b1c2d3e-0000-4000-8000-0000000000aa", email: "buyer@gmail.com" };

beforeAll(() => {
  Object.assign(process.env, {
    PAYMOB_SECRET_KEY: "sk_test_x",
    PAYMOB_PUBLIC_KEY: "pk_test_y",
    PAYMOB_CARD_INTEGRATION_ID: "123456",
    PAYMOB_HMAC_SECRET: SECRET,
    PUBLIC_SITE_URL: "https://beautshy.test/",
  });
});
beforeEach(async () => {
  await query("delete from payments");
  await query("delete from profiles");
});
afterEach(() => vi.unstubAllGlobals());

/** A "transaction processed" message like Paymob's, for a payment we created. */
function transaction(paymentId: string, changes: Record<string, unknown> = {}) {
  return {
    amount_cents: PREMIUM_PRICE_EGP * 100,
    created_at: "2026-11-17T12:00:00.123456",
    currency: "EGP",
    error_occured: false,
    has_parent_transaction: false,
    id: 9001,
    integration_id: 123456,
    is_3d_secure: true,
    is_auth: false,
    is_capture: false,
    is_refunded: false,
    is_standalone_payment: true,
    is_voided: false,
    order: { id: 777, merchant_order_id: paymentId },
    owner: 42,
    pending: false,
    source_data: { pan: "2346", sub_type: "MasterCard", type: "card" },
    success: true,
    ...changes,
  };
}

function callback(obj: Record<string, unknown>, hmac = transactionSignature(obj, SECRET)) {
  return handlePaymobCallback(
    new Request(`https://beautshy.test/api/paymob/callback?hmac=${hmac}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "TRANSACTION", obj }),
    }),
  );
}

async function pendingPayment(amountCents = PREMIUM_PRICE_EGP * 100): Promise<string> {
  await getAccount(user); // creates the profile
  const id = crypto.randomUUID();
  await query(
    `insert into payments (id, user_id, amount_cents, currency) values ($1, $2, $3, 'EGP')`,
    [id, user.id, amountCents],
  );
  return id;
}

/** The end of premium, as the page receives it. */
async function premiumUntil(): Promise<Date | null> {
  const until = (await getAccount(user)).premiumUntil;
  return until ? new Date(until) : null;
}

describe("the signature on Paymob's message", () => {
  it("joins the fields exactly like Paymob's own worked example", () => {
    // The sample transaction from Paymob's HMAC documentation.
    const sample = {
      amount_cents: 100,
      created_at: "2020-03-25T18:39:44.719228",
      currency: "EGP",
      error_occured: false,
      has_parent_transaction: false,
      id: 2556706,
      integration_id: 6741,
      is_3d_secure: true,
      is_auth: false,
      is_capture: false,
      is_refunded: false,
      is_standalone_payment: true,
      is_voided: false,
      order: { id: 4778239 },
      owner: 4705,
      pending: false,
      source_data: { pan: "2346", sub_type: "MasterCard", type: "card" },
      success: true,
    };
    expect(signedText(sample)).toBe(
      "1002020-03-25T18:39:44.719228EGPfalsefalse25567066741truefalsefalsefalsetruefalse47782394705false2346MasterCardcardtrue",
    );
  });
});

describe("after a card payment", () => {
  it("makes the account premium for 30 days, automatically", async () => {
    const paymentId = await pendingPayment();
    for (let i = 0; i < FREE_SEARCHES; i++) await reserveSearch(user);
    expect((await reserveSearch(user)).allowed).toBe(false);

    const res = await callback(transaction(paymentId));
    expect(res.status).toBe(200);

    const account = await getAccount(user);
    expect(account.plan).toBe("premium");
    expect(account.searchesLeft).toBeNull();
    expect((await reserveSearch(user)).allowed).toBe(true);
    const days = ((await premiumUntil())!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("counts a repeated message only once", async () => {
    const paymentId = await pendingPayment();
    await callback(transaction(paymentId));
    const first = await premiumUntil();
    await callback(transaction(paymentId));
    await callback(transaction(paymentId));
    expect((await premiumUntil())!.getTime()).toBe(first!.getTime());
  });

  it("adds 30 days on top when a premium account pays again", async () => {
    await callback(transaction(await pendingPayment()));
    const first = (await premiumUntil())!.getTime();
    const second = await pendingPayment();
    await callback(
      transaction(second, { id: 9002, order: { id: 778, merchant_order_id: second } }),
    );
    const after = (await premiumUntil())!.getTime();
    expect((after - first) / 86_400_000).toBeCloseTo(30, 1);
  });

  it("refuses a message that was not signed by Paymob, or was changed", async () => {
    const paymentId = await pendingPayment();
    const obj = transaction(paymentId);
    expect((await callback(obj, "0".repeat(128))).status).toBe(401);
    expect((await callback(obj, "")).status).toBe(401);
    // Signed for one payment, then edited to point at another.
    const signed = transactionSignature(obj, SECRET);
    const edited = transaction(paymentId, { amount_cents: 1 });
    expect((await callback(edited, signed)).status).toBe(401);
    expect((await getAccount(user)).plan).toBe("free");
  });

  it("does not upgrade when the amount paid is not the price", async () => {
    const paymentId = await pendingPayment();
    await callback(transaction(paymentId, { amount_cents: 100 })); // genuine, but 1 EGP
    expect((await getAccount(user)).plan).toBe("free");
  });

  it("does not upgrade for a failed, pending or refunded payment", async () => {
    for (const changes of [{ success: false }, { pending: true }, { is_refunded: true }]) {
      const paymentId = await pendingPayment();
      expect((await callback(transaction(paymentId, changes))).status).toBe(200);
      expect((await getAccount(user)).plan, JSON.stringify(changes)).toBe("free");
    }
  });

  it("ends premium when the paid month is over", async () => {
    await callback(transaction(await pendingPayment()));
    await query(
      `update profiles set premium_until = now() - interval '1 minute', searches_used = $2
        where user_id = $1`,
      [user.id, FREE_SEARCHES],
    );
    expect((await getAccount(user)).plan).toBe("free");
    expect((await reserveSearch(user)).allowed).toBe(false);
  });
});

describe("starting a payment", () => {
  it("asks Paymob for the price set on the server and returns its checkout page", async () => {
    await getAccount(user);
    const paymob = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ client_secret: "csk_test_abc", intention_order_id: 555 }, { status: 201 }),
    );
    vi.stubGlobal("fetch", paymob);

    const result = await startCardPayment(user, "+201012345678");
    expect(result).toEqual({
      ok: true,
      checkoutUrl:
        "https://accept.paymob.com/unifiedcheckout/?publicKey=pk_test_y&clientSecret=csk_test_abc",
    });

    const [url, init] = paymob.mock.calls[0]!;
    expect(url).toBe("https://accept.paymob.com/v1/intention/");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Token sk_test_x");
    const body = JSON.parse(String(init.body));
    expect(body.amount).toBe(PREMIUM_PRICE_EGP * 100);
    expect(body.currency).toBe("EGP");
    expect(body.payment_methods).toEqual([123456]);
    expect(body.billing_data.phone_number).toBe("+201012345678");
    expect(body.notification_url).toBe("https://beautshy.test/api/paymob/callback");

    const saved = await query<{ id: string; status: string; paymob_order_id: string }>(
      `select id, status, paymob_order_id::text from payments`,
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]!.id).toBe(body.special_reference);
    expect(saved[0]!.status).toBe("pending");
    expect(saved[0]!.paymob_order_id).toBe("555");
  });

  it("understands Egyptian mobile numbers", () => {
    expect(egyptianMobile("01012345678")).toBe("+201012345678");
    expect(egyptianMobile("+20 112 345 6789")).toBe("+201123456789");
    expect(egyptianMobile("201512345678")).toBe("+201512345678");
    expect(egyptianMobile("0123")).toBeNull();
    expect(egyptianMobile("01312345678")).toBeNull();
  });
});

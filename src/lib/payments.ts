/**
 * Card payments through Paymob. Server-only.
 *
 * 1. The visitor clicks "Pay": `startCardPayment` records a pending payment
 *    and asks Paymob for a checkout page. The price comes from plans.ts on the
 *    server, never from the browser.
 * 2. The visitor types their card on Paymob's own page. Card numbers never
 *    reach this site.
 * 3. Paymob tells this server the result (`handlePaymobCallback`, at
 *    /api/paymob/callback). The message is signed with the HMAC secret; an
 *    unsigned or altered message is refused. A successful, correctly priced
 *    payment makes the account premium for PREMIUM_DAYS, in one database
 *    statement, exactly once even if Paymob sends the message twice.
 *
 * Settings (in .env.local, and on Render): PAYMOB_SECRET_KEY, PAYMOB_PUBLIC_KEY,
 * PAYMOB_CARD_INTEGRATION_ID, PAYMOB_HMAC_SECRET, PUBLIC_SITE_URL.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { query } from "./db";
import { PREMIUM_DAYS, PREMIUM_PRICE_EGP } from "./plans";

const PAYMOB = "https://accept.paymob.com";
export const CALLBACK_PATH = "/api/paymob/callback";
/** A Paymob message larger than this is not a real one. */
const MAX_CALLBACK_BYTES = 1_000_000;

type PaymobSettings = {
  secretKey: string;
  publicKey: string;
  integrationId: number;
  hmacSecret: string;
  siteUrl: string;
};

function settings(): PaymobSettings | null {
  const env = process.env;
  const integrationId = Number(env["PAYMOB_CARD_INTEGRATION_ID"]);
  const siteUrl = env["PUBLIC_SITE_URL"]?.replace(/\/+$/, "");
  if (
    !env["PAYMOB_SECRET_KEY"] ||
    !env["PAYMOB_PUBLIC_KEY"] ||
    !env["PAYMOB_HMAC_SECRET"] ||
    !Number.isInteger(integrationId) ||
    !siteUrl
  ) {
    return null;
  }
  return {
    secretKey: env["PAYMOB_SECRET_KEY"],
    publicKey: env["PAYMOB_PUBLIC_KEY"],
    integrationId,
    hmacSecret: env["PAYMOB_HMAC_SECRET"],
    siteUrl,
  };
}

/** True when all the Paymob settings are filled in. */
export function cardPaymentsEnabled(): boolean {
  return settings() !== null;
}

/** Egyptian mobile numbers: 01xxxxxxxxx or +201xxxxxxxxx. Returned as +201xxxxxxxxx. */
export function egyptianMobile(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  const match = digits.match(/^(?:\+?20|0)?(1[0125]\d{8})$/);
  return match ? `+20${match[1]}` : null;
}

export type StartPayment = { ok: true; checkoutUrl: string } | { ok: false; error: string };

/** Record a pending payment and get Paymob's checkout page for it. */
export async function startCardPayment(
  user: { id: string; email: string },
  phone: string,
): Promise<StartPayment> {
  const config = settings();
  if (!config) return { ok: false, error: "Card payments are not available yet." };

  const amountCents = PREMIUM_PRICE_EGP * 100;
  const paymentId = randomUUID();
  await query(
    `insert into payments (id, user_id, amount_cents, currency) values ($1, $2, $3, 'EGP')`,
    [paymentId, user.id, amountCents],
  );

  const res = await fetch(`${PAYMOB}/v1/intention/`, {
    method: "POST",
    headers: { Authorization: `Token ${config.secretKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      amount: amountCents,
      currency: "EGP",
      payment_methods: [config.integrationId],
      items: [
        {
          name: `Beautshy Premium (${PREMIUM_DAYS} days)`,
          amount: amountCents,
          quantity: 1,
        },
      ],
      billing_data: {
        first_name: "Beautshy",
        last_name: "Customer",
        email: user.email,
        phone_number: phone,
        apartment: "NA",
        floor: "NA",
        street: "NA",
        building: "NA",
        shipping_method: "NA",
        postal_code: "NA",
        city: "NA",
        state: "NA",
        country: "EGY",
      },
      special_reference: paymentId,
      notification_url: `${config.siteUrl}${CALLBACK_PATH}`,
      redirection_url: `${config.siteUrl}/?payment=return`,
    }),
  });
  const data = (await res.json().catch(() => null)) as {
    client_secret?: string;
    intention_order_id?: number;
  } | null;
  if (!res.ok || !data?.client_secret) {
    console.error(`[payments] Paymob refused the payment (HTTP ${res.status}):`, data);
    await query(`update payments set status = 'failed' where id = $1`, [paymentId]);
    return { ok: false, error: "The payment could not be started. Please try again later." };
  }
  if (Number.isInteger(data.intention_order_id)) {
    await query(`update payments set paymob_order_id = $2 where id = $1`, [
      paymentId,
      data.intention_order_id,
    ]);
  }
  const checkout = new URL(`${PAYMOB}/unifiedcheckout/`);
  checkout.searchParams.set("publicKey", config.publicKey);
  checkout.searchParams.set("clientSecret", data.client_secret);
  return { ok: true, checkoutUrl: checkout.href };
}

/* ---------- Paymob's message about the result ---------- */

type Transaction = Record<string, unknown> & {
  order?: Record<string, unknown>;
  source_data?: Record<string, unknown>;
};

/**
 * The signature Paymob puts on a "transaction processed" message: these
 * fields, in this order, joined with nothing between them, signed with
 * HMAC-SHA512 (Paymob developer docs, "HMAC Transaction Callback").
 */
export function transactionSignature(obj: Transaction, secret: string): string {
  return createHmac("sha512", secret).update(signedText(obj)).digest("hex");
}

/** The text that is signed (exported for the tests). */
export function signedText(obj: Transaction): string {
  const fields = [
    obj["amount_cents"],
    obj["created_at"],
    obj["currency"],
    obj["error_occured"],
    obj["has_parent_transaction"],
    obj["id"],
    obj["integration_id"],
    obj["is_3d_secure"],
    obj["is_auth"],
    obj["is_capture"],
    obj["is_refunded"],
    obj["is_standalone_payment"],
    obj["is_voided"],
    obj.order?.["id"],
    obj["owner"],
    obj["pending"],
    obj.source_data?.["pan"],
    obj.source_data?.["sub_type"],
    obj.source_data?.["type"],
    obj["success"],
  ];
  return fields.map((value) => String(value)).join("");
}

function signatureMatches(obj: Transaction, given: string, secret: string): boolean {
  const expected = Buffer.from(transactionSignature(obj, secret));
  const received = Buffer.from(given.toLowerCase());
  return expected.length === received.length && timingSafeEqual(expected, received);
}

const reply = (status: number, message: string) =>
  new Response(JSON.stringify({ message }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Handle Paymob's POST to /api/paymob/callback. */
export async function handlePaymobCallback(request: Request): Promise<Response> {
  const config = settings();
  if (!config) return reply(404, "not found");

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_CALLBACK_BYTES) return reply(413, "too large");
  const text = await request.text();
  if (text.length > MAX_CALLBACK_BYTES) return reply(413, "too large");

  let body: { type?: unknown; obj?: Transaction };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return reply(400, "not json");
  }
  const obj = body.obj;
  const given = new URL(request.url).searchParams.get("hmac") ?? "";
  // Nothing in the message is believed until its signature is checked.
  if (
    !obj ||
    typeof obj !== "object" ||
    !given ||
    !signatureMatches(obj, given, config.hmacSecret)
  ) {
    console.warn("[payments] refused a payment message with a wrong or missing signature");
    return reply(401, "invalid signature");
  }
  if (body.type !== "TRANSACTION") return reply(200, "ignored");

  const paymentId = String(obj.order?.["merchant_order_id"] ?? "");
  const paymobOrderId = Number(obj.order?.["id"]);
  const transactionId = Number(obj["id"]);
  const paid =
    obj["success"] === true &&
    obj["pending"] === false &&
    obj["is_voided"] === false &&
    obj["is_refunded"] === false &&
    obj["error_occured"] === false;

  if (!paid) {
    await query(
      `update payments set status = 'failed'
        where status = 'pending' and (id::text = $1 or paymob_order_id = $2)`,
      [paymentId, paymobOrderId],
    );
    return reply(200, "recorded");
  }

  // One statement: mark the payment paid (only if it was pending and the amount
  // and currency are exactly what was asked), then extend premium. A repeated
  // message finds the payment already paid and changes nothing.
  const upgraded = await query<{ user_id: string }>(
    `with paid as (
       update payments
          set status = 'paid', paymob_transaction_id = $3, paid_at = now()
        where (id::text = $1 or paymob_order_id = $2)
          and status = 'pending' and amount_cents = $4 and currency = $5
        returning user_id
     )
     update profiles p
        set plan = 'premium',
            premium_until = greatest(coalesce(p.premium_until, now()), now())
                            + make_interval(days => $6::int),
            upgrade_requested_at = null
       from paid
      where p.user_id = paid.user_id
     returning p.user_id`,
    [
      paymentId,
      paymobOrderId,
      transactionId,
      Number(obj["amount_cents"]),
      String(obj["currency"]),
      PREMIUM_DAYS,
    ],
  );
  if (upgraded.length > 0) console.info(`[payments] premium for ${upgraded[0]!.user_id}`);
  return reply(200, "recorded");
}

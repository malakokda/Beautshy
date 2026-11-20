// Server-only connection to Supabase Auth, which keeps the passwords and checks
// them at sign-in. (All other data goes through src/lib/db.ts.)
// Never import this at the top of a file the browser loads.
import { createClient } from "@supabase/supabase-js";

function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
}

function createSupabaseFetch(supabaseKey: string, visitor: string | undefined): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
    );

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

    // New Supabase API keys are opaque strings, not bearer JWTs.
    if (
      isNewSupabaseApiKey(supabaseKey) &&
      headers.get("Authorization") === `Bearer ${supabaseKey}`
    ) {
      headers.delete("Authorization");
    }

    headers.set("apikey", supabaseKey);
    // Supabase limits sign-ups and sign-ins per internet address. Every request
    // comes from this server, so without this header all visitors would share
    // one limit and one person could use it up for everyone. Supabase only
    // trusts it with a secret key, and only once "forwarded IP" is enabled
    // under Authentication > Rate Limits.
    if (visitor && isNewSupabaseApiKey(supabaseKey)) headers.set("Sb-Forwarded-For", visitor);
    return fetch(input, { ...init, headers });
  };
}

/**
 * A fresh Supabase Auth client for one sign-up or sign-in. A new one is made
 * each time because signing in changes the client's identity to that person.
 * `visitor` is the internet address of the person signing in.
 */
export function createSupabaseAuthClient(visitor?: string) {
  const SUPABASE_URL = process.env["SUPABASE_URL"];
  const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const missing = [
      ...(!SUPABASE_URL ? ["SUPABASE_URL"] : []),
      ...(!SUPABASE_SERVICE_ROLE_KEY ? ["SUPABASE_SERVICE_ROLE_KEY"] : []),
    ];
    const message = `Missing Supabase environment variable(s): ${missing.join(", ")}. Set them in your .env file.`;
    console.error(`[Supabase] ${message}`);
    throw new Error(message);
  }

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    global: {
      fetch: createSupabaseFetch(SUPABASE_SERVICE_ROLE_KEY, visitor),
    },
    auth: {
      storage: undefined,
      persistSession: false,
      autoRefreshToken: false,
    },
  }).auth;
}

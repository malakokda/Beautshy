# GlowSouq

Sign in, then search a cosmetics product by name (or paste a product link) and see the 10 cheapest
offers from Egyptian online stores, cheapest first.

Names do not have to be exact: spelling mistakes ("garnir micelar watr") and half names
("la roche effac") are matched to the closest products. The rules are in
`src/lib/fuzzy-match.ts`.

How the whole site works, and why it is built this way, is explained in `ARCHITECTURE.md`.

## Run it

```sh
npm install
npm run dev        # http://localhost:8080
```

To share it, run `ngrok http 8080` in a second terminal and send the https link.

## Put it online

The site needs a host that runs a Node.js server (for example Render or Railway):

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Environment variables: the settings below

You can run several copies of the server at once. They share one database, so store
products, accounts and daily limits are the same for all of them.

## Settings

| File         | Setting                     | What it is                                            |
| ------------ | --------------------------- | ----------------------------------------------------- |
| `.env.local` | `DATABASE_URL`              | Postgres address of your Supabase project (see below) |
| `.env`       | `SUPABASE_URL`              | Your Supabase project address (used for sign-in)      |
| `.env.local` | `SUPABASE_SERVICE_ROLE_KEY` | Supabase secret key (never share it)                  |
| `.env.local` | `SERPAPI_KEY`               | SerpAPI key, used for Amazon Egypt                    |
| `.env`       | `ADMIN_EMAILS`              | The owner's email(s)                                  |
| host only    | `AMAZON_SEARCHES_PER_DAY`   | New Amazon searches allowed per day (8 if not set)    |

`DATABASE_URL` is on the Supabase dashboard under **Connect** (use the "Session pooler"
address and put your database password in it). The tables are created automatically the
first time the server connects; there is no SQL to run.

Without `DATABASE_URL` the site uses a small database stored in `data/pglite` on this
computer. That is fine for trying things out, but a hosted site must set it, or its data
is lost on every restart.

## Accounts and plans

Searching needs an account. A free account gets 3 searches; premium is unlimited. The
numbers and the price are in `src/lib/plans.ts`.

- Passwords are handled by Supabase Auth. Each account's plan and search count are in the
  `profiles` table.
- `ADMIN_EMAILS` in `.env` lists the owner's emails: unlimited searches, plus an accounts
  list at the bottom of the page for switching people to premium after they pay.
- "Request premium" only records the request; payment is arranged by hand.

## Stores

Every store's product list is kept in the database and read again from the store's website
when it is more than 6 hours old. A search never waits for a store's website.

Pasting a link from a new website into the search box adds that website to the searched
stores, as long as it is an Egyptian Shopify store with prices in EGP. Added stores are
saved in the `added_stores` table; delete a store's row to remove it.

Edit `src/lib/stores.config.ts` to add or remove stores. Shopify stores need only a
name and address. Stores that are not on Shopify (Mazaya, Faces) are read through their
sitemap and product pages; see `src/lib/sitemap-store.ts`. The database tables are defined in
`src/lib/schema.ts`.

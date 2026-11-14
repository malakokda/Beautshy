# Beauty Deal Finder

Search a cosmetics product by name (or paste a product link) and see the 10 cheapest
offers from Egyptian online stores, cheapest first.

Names do not have to be exact: spelling mistakes ("garnir micelar watr") and half names
("la roche effac") are matched to the closest products. The rules are in
`src/lib/fuzzy-match.ts`.

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
- Environment variables: the three settings below

## Settings

| File         | Setting                     | What it is                           |
| ------------ | --------------------------- | ------------------------------------ |
| `.env`       | `SUPABASE_URL`              | Your Supabase project address        |
| `.env.local` | `SUPABASE_SERVICE_ROLE_KEY` | Supabase secret key (never share it) |
| `.env.local` | `SERPAPI_KEY`               | SerpAPI key, used for Amazon Egypt   |

## Stores

Pasting a link from a new website into the search box adds that website to the searched
stores, as long as it is a Shopify store with prices in EGP. Added stores are saved in the
Supabase table `added_stores` (create it by running `supabase/schema.sql`); until that table
exists they are saved in `data/added-stores.json`. Delete a store's row or entry to remove it.

Edit `src/lib/stores.config.ts` to add or remove stores. Shopify stores need only a
name and address. Stores that are not on Shopify (Mazaya, Faces) are read through their
sitemap and product pages; see `src/lib/sitemap-store.ts`. The database table is defined in `supabase/schema.sql`.

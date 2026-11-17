# GlowSouq: summary

GlowSouq is a price-comparison website for makeup and skincare in Egypt. A visitor types a
product name, or pastes a product link, and the site shows the cheapest offers for that
product across Egyptian beauty stores, with a link to each store.

This file is the short version. `README.md` covers setup and settings, and
`ARCHITECTURE.md` explains every part in detail.

---

## 1. What a visitor can do

- **Search by name.** Spelling mistakes and partial names are fine: "garnir micelar watr"
  finds "Garnier Micellar Water".
- **Search by link.** Pasting a product link from a store finds the same product in the
  other stores.
- **Add a store.** Pasting a link from an Egyptian Shopify store the site does not know
  yet adds that store to the ones it searches.
- **See the ten cheapest offers**, each with store name, price in EGP, picture and link.

Searching requires an account. A free account gets 3 searches; after that the site asks
the visitor to upgrade to premium (99 EGP), which gives unlimited searches.

---

## 2. The stores

There are 21 built-in stores, plus any that visitors add.

| How the store is read                             | Stores                                                                                                                                                                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shopify catalogue (the store's open product list) | Cairo Megastore, Loolia Closet, Bashrety, Dr. Dawood Store, Feel22 Egypt, Source Beauty, Bloom Pharmacy, Zynah, Trindiva, Sofie Store, Korean Beautys, Taksima, Braes, Areej Aromatherapy, The Bath Land, AM Cosmetics, Maison Nari, Infinity Clinic Pharma |
| Sitemap plus product pages                        | Mazaya, Faces                                                                                                                                                                                                                                               |
| SerpAPI (a paid search service)                   | Amazon Egypt                                                                                                                                                                                                                                                |

noon, Jumia, Breadfast and Talabat are not connected: they do not offer a product list
that can be read reliably.

---

## 3. What happens during a search

1. The visitor submits the search box.
2. The server checks the visitor is signed in and is not sending too many requests.
3. One search is taken from the visitor's allowance.
4. If the text is a link, the server reads the product's name from that page. If the link
   is from an unknown Shopify store, the store is added.
5. The server looks for matching products in its memory, where it keeps every store's
   product list. No store website is contacted at this point, which is why searches are
   fast.
6. For Mazaya and Faces, the server opens the matching product pages to read the price
   (at most 10 per store). Amazon is asked through SerpAPI.
7. The ten cheapest offers are sent back to the page.
8. If nothing was found, the search is given back to the visitor's allowance.

---

## 4. How product names are matched

The matcher is written for this site (`src/lib/fuzzy-match.ts`).

- Names are simplified: lower case, no accents or punctuation, split into words.
- Each word the visitor typed is compared with the words used in product names, and each
  kind of match gets a score:

  | Match                                    | Score |
  | ---------------------------------------- | ----- |
  | Exact word                               | 1.0   |
  | Plural or singular form                  | 0.95  |
  | Start of a word ("micel" for "micellar") | 0.9   |
  | One typing mistake                       | 0.8   |
  | Two typing mistakes                      | 0.7   |

- A misspelt word must keep its first letter, and sizes and numbers ("400ml") must match
  exactly.
- A product is a match when it contains every word. Products scoring close to the best
  one are kept.
- If no product contains every word, products with at least half of them are shown and
  marked as approximate.
- The page shows the corrected spelling when the visitor's spelling was fixed.

To keep this fast, the server records for every word which products contain it, like the
index at the back of a book, so a search only looks at products sharing a word with it.

---

## 5. Where the products are kept

Reading every store takes 10 to 15 seconds, so it is not done during a search.

- The database holds one copy of every store's products (about 54,000 rows).
- A store is read again when its copy is more than 6 hours old. Only one server does this
  at a time; searches keep using the old copy until the new one is complete.
- Each server loads the products into memory and checks the database once a minute for
  newer copies.
- Mazaya and Faces prices are kept for 6 hours, and Amazon answers for 24 hours.

---

## 6. Accounts and plans

- **Sign-up and sign-in** use email and password, handled by Supabase Auth. New accounts
  confirm their email through a link.
- **Staying signed in** uses a signed cookie that lasts 30 days.
- **Free plan:** 3 searches. **Premium:** unlimited, 99 EGP.
- **Upgrading is manual.** The visitor clicks "upgrade", pays the owner directly, and the
  owner clicks "Make premium" in the accounts list.
- **The owner** is whoever's email is in `ADMIN_EMAILS` in `.env`. The owner has
  unlimited searches and sees the list of all accounts at the bottom of the page.

---

## 7. Limits that protect the site

| Limit                                                     | Value |
| --------------------------------------------------------- | ----- |
| Actions per visitor per minute                            | 15    |
| New Amazon searches per day (each costs a SerpAPI credit) | 8     |
| Stores added per day                                      | 5     |
| Added stores in total                                     | 40    |
| Product pages opened per sitemap store per search         | 10    |

---

## 8. What it is built with

| Part                | Used for                                           |
| ------------------- | -------------------------------------------------- |
| TypeScript          | The language for the whole project                 |
| Node.js             | Runs the server                                    |
| TanStack Start      | The framework: page and server code in one project |
| React               | The page in the browser                            |
| Tailwind            | Styling                                            |
| Vite and Nitro      | Development server and the build for hosting       |
| Postgres (Supabase) | The database                                       |
| Supabase Auth       | Passwords and confirmation emails                  |
| SerpAPI             | Amazon Egypt results                               |
| Vitest              | Automated tests (25)                               |

---

## 9. The main files

| File                                 | What it does                                                |
| ------------------------------------ | ----------------------------------------------------------- |
| `src/routes/index.tsx`               | The page: search box, results, account area                 |
| `src/components/account.tsx`         | Sign-in form, account bar, upgrade card, owner's list       |
| `src/lib/search.functions.ts`        | The door between the page and the server for searching      |
| `src/lib/account.functions.ts`       | The same for accounts                                       |
| `src/lib/search.ts`                  | The steps of one search                                     |
| `src/lib/fuzzy-match.ts`             | The name matcher                                            |
| `src/lib/catalog.ts`                 | Store products: saved in the database, searched from memory |
| `src/lib/shopify-store.ts`           | Reads Shopify stores                                        |
| `src/lib/sitemap-store.ts`           | Reads Mazaya and Faces                                      |
| `src/lib/store-search.ts`            | Collects offers from all stores, and Amazon                 |
| `src/lib/product-link.ts`            | Reads a product from a pasted link                          |
| `src/lib/store-registry.ts`          | The list of stores, including added ones                    |
| `src/lib/stores.config.ts`           | The built-in stores                                         |
| `src/lib/accounts.ts`                | Sign-in, plans, counting searches                           |
| `src/lib/plans.ts`                   | The number of free searches and the premium price           |
| `src/lib/rate-limit.ts`              | The limits in section 7                                     |
| `src/lib/db.ts`, `src/lib/schema.ts` | Database connection and tables                              |

---

## 10. The database tables

| Table            | Holds                                                     |
| ---------------- | --------------------------------------------------------- |
| `profiles`       | One row per account: plan, searches used, upgrade request |
| `added_stores`   | Stores added by pasting a link                            |
| `products`       | Every product of every store                              |
| `store_refresh`  | When each store was last read                             |
| `page_prices`    | Prices read from Mazaya and Faces pages                   |
| `amazon_cache`   | Saved Amazon answers                                      |
| `daily_counters` | Today's Amazon searches and added stores                  |

The tables are created automatically the first time the server connects.

---

## 11. Running it

On your computer:

```
npm install      (first time only)
npm run dev
```

Then open http://localhost:8080.

On a host such as Render: build with `npm install && npm run build`, start with
`npm start`, and give the host the same settings as below.

| File         | Setting                     | What it is                                         |
| ------------ | --------------------------- | -------------------------------------------------- |
| `.env`       | `SUPABASE_URL`              | Address of the Supabase project                    |
| `.env.local` | `SUPABASE_SERVICE_ROLE_KEY` | Supabase secret key                                |
| `.env.local` | `DATABASE_URL`              | Database address, with the database password in it |
| `.env.local` | `SERPAPI_KEY`               | SerpAPI key for Amazon                             |
| `.env`       | `ADMIN_EMAILS`              | The owner's email                                  |

---

## 12. What is not done yet

- Payment is manual; there is no online payment.
- There is no "forgot password".
- noon, Jumia, Breadfast and Talabat are not connected.
- Arabic product names are matched only as written.
- The site has not been tested with many visitors at once.
# Beautshy: how it works, and how I would build it again

This document explains the whole website: what it does, the languages and tools it
uses and why, the logic of a search, the matching algorithm, accounts and plans, and
what I would do differently if I started again from an empty folder.

---

## 1. What the site does

A visitor signs in, types a cosmetics product name (or pastes a link), and gets the
10 cheapest offers from Egyptian online stores, cheapest first. Each offer shows the
store, the price in EGP and a link to buy.

Four things make it more than a simple search box:

1. **It forgives typing.** "garnir micelar watr" finds Garnier Micellar Water, and
   "la roche effac" finds La Roche-Posay Effaclar.
2. **It reads prices live from the stores**, not from a list someone typed in.
3. **It grows.** Pasting a link from a new Egyptian Shopify store adds that store to
   the search for everyone.
4. **It has plans.** A free account gets 3 searches; premium is unlimited.

---

## 2. Languages and tools, and why

| Piece             | What is used                   | Why                                                                                                                                                                                         |
| ----------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language          | **TypeScript**                 | One language for the page and the server. It checks types before the code runs, which catches many mistakes (a missing field, a wrong name) while editing instead of in front of a visitor. |
| Page              | **React 19**                   | The page is a handful of states (signed out, searching, results, upgrade). React redraws the right one when the state changes.                                                              |
| Framework         | **TanStack Start**             | It lets the page call a function that runs on the server ("server function") as if it were an ordinary function. No separate API project, no hand-written request code.                     |
| Styling           | **Tailwind CSS 4**             | Styles are written next to the element they style, so there is no separate stylesheet to keep in step.                                                                                      |
| Server            | **Node.js 22**                 | Runs the TypeScript server code, and has `fetch` built in for reading the stores.                                                                                                           |
| Build             | **Vite + Nitro**               | Vite gives instant reload while developing; Nitro packs the result into one folder (`.output`) that any Node host can run with `npm start`.                                                 |
| Accounts and data | **Supabase** (Postgres + Auth) | Stores passwords safely (never in our own tables) and gives a real database without running one.                                                                                            |
| Amazon prices     | **SerpAPI**                    | Amazon blocks direct reading, so a paid service does it. Each new search costs one credit.                                                                                                  |
| Input checking    | **Zod**                        | Every request from the page is checked (length, shape) before the server acts on it.                                                                                                        |
| Tests             | **Vitest**                     | Fast tests for the parts that must not break: matching, search counting, the sign-in cookie.                                                                                                |

No Python, PHP or separate backend is involved. Everything is TypeScript in one project.

---

## 3. How the code is organised

```
src/
  routes/index.tsx          The page: search box, results, store list
  components/account.tsx    Sign-in form, account bar, upgrade card, owner's list
  lib/
    search.functions.ts     What the page may ask the server (search, list stores)
    search.ts               One search from start to finish
    store-search.ts         Collects matching offers from every store; searches Amazon
    catalog.ts              The stores' products: shared in the database, searched from memory
    shopify-store.ts        Reader for Shopify stores
    fuzzy-match.ts          The matching algorithm (typos, half names)
    sitemap-store.ts        Reader for non-Shopify stores (Mazaya, Faces)
    product-link.ts         Works out the product behind a pasted link
    store-registry.ts       Stores added by pasting a link
    stores.config.ts        The built-in list of stores
    account.functions.ts    What the page may ask about accounts
    accounts.ts             Sign-in, the login cookie, plans, search counting
    plans.ts                The numbers: 3 free searches, EGP 99 a month
    rate-limit.ts           Per-minute and per-day limits
    db.ts                   The database connection
    schema.ts               The database tables (created automatically)
    web.ts                  Shared download helpers
    price-results.ts        The "offer" shape and "keep the 10 cheapest"
  integrations/supabase/    Connection to Supabase Auth (passwords)
```

The rule that keeps this tidy: files ending in `.functions.ts` are the only doors
between the page and the server. Everything else under `lib/` runs only on the server,
so keys and store-reading code never reach the visitor's browser.

---

## 4. What happens during one search

1. **The page sends the text** to `searchPrices` on the server.
2. **Limit check.** More than 15 requests a minute from one visitor are refused.
3. **Account check.** No sign-in cookie means "please sign in". A free account that has
   used its 3 searches gets "upgrade".
4. **One search is reserved** on the account before any work starts, so two searches
   sent at the same moment cannot both slip through on the last free search.
5. **Is the text a link?** If it looks like a web address:
   - its website is added to the searched stores if it is a new Egyptian Shopify store;
   - a link to a store's front page stops here with a message;
   - a link to a product is turned into a product name (section 7).
6. **Every store's products are searched** from the server's memory (section 5) and the
   ones that fit the text are picked (section 6). No store website is contacted here.
7. **Mazaya and Faces matches are priced** by opening their product pages.
8. **Duplicates are removed**, the list is sorted by price, and the 10 cheapest are kept.
9. **If nothing was found, the reserved search is given back.** Only searches that
   return results count against the free plan.
10. **The page shows the results**, then re-reads the account so the "searches left"
    line is up to date.

---

## 5. How stores are read

There are three kinds of store, because stores expose their data in three ways.

### Shopify stores (most of the list)

Every Shopify store publishes its whole catalogue at `/products.json`. The server
downloads it 250 products at a time, 4 pages at once, up to 20,000 products. Each size
or shade (variant) becomes its own offer, so 100 ml and 400 ml are priced separately.
Sold-out variants are skipped.

### Sitemap stores (Mazaya, Faces)

These are not on Shopify, but they publish a sitemap listing every product page, and
the page address contains the product's name. So:

1. the sitemap is downloaded to learn the product names;
2. matching happens on those names;
3. only the matching pages (at most 10 per store per search) are opened to read the
   real name and price, which shops embed in the page for Google ("schema.org Product").

### Amazon Egypt

Amazon cannot be read directly, so SerpAPI searches it. Because each new search costs a
credit, at most 8 new Amazon searches are made per day (changeable with
`AMAZON_SEARCHES_PER_DAY`), and Amazon is sent the corrected spelling.

### Where the products are kept

Reading 20 stores from their websites takes 10 to 15 seconds, so a search never does it.
Instead:

- **The database holds one shared copy** of every store's products (about 54,000 rows).
- **A store is read again when its copy is over 6 hours old.** Whichever server notices
  first marks the store as "mine" in the database and reads it; other servers see the
  mark and leave it alone. So each store's website is read once per 6 hours, however
  many servers or visitors there are.
- **The new copy replaces the old one in one step.** Until that moment, searches keep
  using the old copy, and if the store's website is down the old copy stays.
- **Each server keeps the products in its own memory**, prepared for searching, and asks
  the database once a minute whether any store has a newer copy.

The result, measured on this project: the first search after a restart takes under a
second (loading from the database) instead of 10 seconds, and 200 searches one after
another take under 2 seconds in total.

Two smaller things are shared the same way: prices read from Mazaya and Faces product
pages (kept 6 hours) and Amazon answers (kept 24 hours).

---

## 6. The matching algorithm

This is the heart of the site (`fuzzy-match.ts`). The goal: find the products a person
meant, even when they misspell or type half a name, without guessing wildly.

### Step 1: clean the text

Both the search and every product name go through the same cleaning:

- lower-case, accents removed ("Lancôme" becomes "lancome");
- sizes joined: "400 ml", "400ML" and "400 مل" all become "400ml";
- split into words on spaces, hyphens and apostrophes;
- joining words dropped ("and", "with", "for", "of", "the", "in", "و", "مع").

For each product, every pair of neighbouring words is also stored joined, so
"Sebio-Control" answers to "sebiocontrol" and "make up" to "makeup".

### Step 2: build the vocabulary

When a store's products are loaded, the server counts how often each word appears across
all product names, and records for every word which products contain it (an "index",
like the one at the back of a book). A search then looks only at products that share a
word with it, instead of reading all 54,000. This word list is what makes spelling correction possible: a search word
that no store uses is probably misspelled, and the common word closest to it is
probably what was meant.

### Step 3: work out what each search word may stand for

Each search word gets a list of product words it accepts, with a score:

| Match             | Score | Example                |
| ----------------- | ----- | ---------------------- |
| Same word         | 1.00  | cerave = CeraVe        |
| Singular / plural | 0.95  | cleansers = cleanser   |
| Start of the word | 0.90  | micel = micellar       |
| One typo          | 0.80  | garnir = garnier       |
| Two typos         | 0.70  | nutrogina = neutrogena |

The safety rules that stop it guessing wrongly:

- **Sizes and numbers are never guessed.** "400ml" only matches "400ml".
- **Short words are exact.** Words under 4 letters get no typo allowance; 4 to 6 letters
  allow one typo; 7 or more allow two.
- **The first letter must be right.** This removes most false matches (cream / dream).
- **Real words are trusted.** If stores use the word as typed (more than twice), it is
  not "corrected". "serum" never turns into "series".
- **Only the closest, common spellings count.** If one-typo candidates exist, two-typo
  ones are ignored, and rare candidates (under a fifth as common as the best) are dropped.

A typo means one wrong, missing or extra letter, or two neighbouring letters swapped
(this is the "optimal string alignment" edit distance).

### Step 4: score every product

For each product, each search word takes the best score among the product's words. The
product's score is the average. A product "has" a search word if that word's score is
above zero.

### Step 5: choose what to show

- **Products that have every search word win.** Among those, anything more than 0.15
  below the best score is dropped, so exact matches are not buried under loose ones.
- **If no product has every word**, the products with the most search words are shown
  instead, as long as they have at least half of them and share a real word (not only
  a size). The page says "these are the closest ones we found".
- **The spelling shown back** ("Showing results for garnier micellar water") is taken
  from the words the matched products actually use, not from the dictionary alone.

Finally the kept products are sorted by price. Matching decides _which_ products
qualify; price decides the _order_.

### Worked example

Search: `garnir micelar watr`

1. Words: `garnir`, `micelar`, `watr`. No store uses any of them.
2. Closest common words: `garnier` (one typo), `micellar` (one typo), `water` (one typo).
3. "Garnier Micellar Water 400ml" has all three, scoring (0.8 + 0.8 + 0.8) / 3 = 0.8.
4. "Garnier Vitamin C Serum" has only one of three, so it is not shown.
5. The page says: Showing results for "garnier micellar water", you typed "garnir micelar watr".

---

## 7. Links

**Reading a product from a link.** For a Shopify link the server reads the product's
own data (`/products/<name>.js`): its name, price and stock. For other sites it reads
the page and takes the name from the product information, then the share title, the
main heading and the page title, in that order. Sites that refuse automated reading
(noon, Jumia, Amazon) are not opened; the name is taken from the words in the link.

The search then tries the page's name, and if that finds nothing (it may be Arabic), the
words in the link. The linked product's own offer is always included.

**Adding a store.** A link's website is added to the searched stores when it is public
https, a Shopify store with an open product list, priced in EGP and based in Egypt. At
most 5 stores are added per day and 40 in total. Addresses pointing at private networks
are refused, so the feature cannot be used to probe the server's own network.

---

## 8. Accounts and plans

- **Passwords** are handled entirely by Supabase Auth. The site's own tables never hold
  a password.
- **Staying signed in.** After a correct password the server sets a cookie holding the
  user's id and email plus a signature made with a secret only the server knows. A
  changed cookie fails the signature check. The page's scripts cannot read it, and it
  lasts 30 days.
- **Counting searches.** Each account has a row in `profiles` with its plan and
  `searches_used`. Checking the allowance and counting the search are one database
  statement, so two simultaneous requests, even to different servers, cannot both use
  the last free search.
- **Upgrading.** "Request premium" records the request. The owner sees it in the
  accounts list at the bottom of the page and clicks "Make premium" after being paid.
  There is no automatic payment yet.
- **The owner.** Emails listed in `ADMIN_EMAILS` get unlimited searches and the
  accounts list.

Plan numbers live in one file, `plans.ts`: 3 free searches, EGP 99 a month.

---

## 9. Limits that protect the site

| Limit                                | Value                   | Why                                             |
| ------------------------------------ | ----------------------- | ----------------------------------------------- |
| Requests per visitor                 | 15 a minute             | Stops flooding the stores and password guessing |
| New Amazon searches                  | 8 a day                 | Each costs a SerpAPI credit                     |
| New stores added                     | 5 a day, 40 in total    | Stops one person filling the list               |
| Product pages opened (Mazaya, Faces) | 10 per store per search | Politeness to those sites                       |

The Amazon and new-store limits are counted in the database, so they are shared by all
servers and survive restarts. The per-visitor limit is counted in each server's own
memory: it is there to stop a sudden burst, and with several servers the real limit is
15 a minute per server.

---

## 10. Database tables

| Table                         | Holds                                                     |
| ----------------------------- | --------------------------------------------------------- |
| `auth.users` (Supabase's own) | Emails and passwords                                      |
| `profiles`                    | One row per account: plan, searches used, upgrade request |
| `added_stores`                | Stores added by pasting a link                            |
| `products`                    | Every product of every store                              |
| `store_refresh`               | When each store was last read, and who is reading it now  |
| `page_prices`                 | Prices read from Mazaya and Faces product pages           |
| `amazon_cache`                | Amazon answers, so a search is not paid for twice         |
| `daily_counters`              | Today's count of Amazon searches and newly added stores   |

The tables are created automatically when the server first connects (`schema.ts`).

The server reaches the database through `DATABASE_URL`. When that is not set it uses a
small Postgres database stored in `data/pglite` on the same computer, which understands
the same SQL. That is how the site is developed and tested without an account.

Only the server can read or write these tables.

---

## 11. Built for many visitors at once

The site is designed so that more visitors means "run more copies of the server", with
nothing else to change:

| Concern                                        | How it is handled                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| Many servers reading the same stores           | One shared copy in the database; one server at a time refreshes a store  |
| Slow first search, data lost on restart        | Servers load products from the database, not from the stores             |
| Work per search                                | A word index: a search touches only products that share a word with it   |
| Limits multiplied by the number of servers     | Daily limits are counted in the database                                 |
| Two requests racing for the last free search   | One database statement checks and counts                                 |
| Signing in on one server, searching on another | The sign-in cookie is checked by its signature, so any server accepts it |

What still grows with traffic: Amazon credits (each new product name searched costs
one), and product-page reads on Mazaya and Faces (at most 10 per store per search).

This has not been load-tested with real traffic. The numbers above come from one
computer running searches one after another.

---

## 12. If I had to build the same website again

### What I would keep

- **TypeScript for everything, in one project.** For a site this size, a separate
  backend would double the work for no gain.
- **Reading Shopify's open catalogue.** It is fast, complete and intended to be read.
- **My own matcher.** It is about 300 lines, it is tested, and its rules are specific
  to product names (sizes, brands, joined words) in a way general search tools are not.
- **Products shared in the database, searched from memory.** The data is small enough
  (tens of thousands of products) to search in memory in a few milliseconds, and the
  database keeps every server in agreement.
- **Plans and limits in one small file each**, so the business rules are easy to change.

### What I would do differently

1. **Set up the database first.** This project grew while its database was unreachable,
   so sign-in was only tried against the real thing at the very end. I would create the Supabase
   project on day one.
2. **Keep price history.** Products are already stored on every refresh; keeping the old
   prices as well would allow "price dropped" alerts and a price chart. That is a far
   stronger reason to pay for premium than a search counter, which people can dodge
   with a second email.
3. **Sign in with Google instead of passwords.** One click for visitors, no password
   reset to build, and much harder to create throwaway accounts for more free searches.
4. **Take payment automatically from the start** (Paymob or a similar Egyptian
   provider), with the provider telling the server when a payment succeeds. Upgrading
   by hand does not scale past a few customers.
5. **Have the owner approve new stores.** Letting any visitor add a store is convenient
   but means the store list is not fully under the owner's control.
6. **Improve Arabic matching.** Arabic names are matched as written; joined prefixes
   ("بالقهوة" against "القهوة") and Arabic-to-English brand names are not handled.
7. **Ask the big stores for a feed.** noon, Jumia and Amazon cannot be read reliably.
   An affiliate or partner feed is the dependable route and can also earn commission,
   which may be a better business than subscriptions.

### The order I would build it in

1. Database, tables and sign-in.
2. One store connector (Shopify) saving products into the database.
3. The matcher, with tests, searching those products.
4. The page: search box and results.
5. More stores, then the sitemap connector.
6. Shared refresh across servers, and price history.
7. Plans, payment, and the owner's page.
8. Links and adding stores.
9. Hosting, limits and monitoring.

---

## 13. Known gaps today

- Sign-up and sign-in have been tried by hand against the real Supabase project, but have
  no automated tests. Everything behind them (plans, counting, products, limits) is
  tested automatically against a real Postgres engine running locally.
- There is no "forgot password".
- Payment is arranged by hand.
- noon, Jumia, Breadfast and Talabat are not connected.

# Pokemon Flipper

Find eBay Pokémon card listings worth flipping, priced to the exact printing, with a max bid for every one.

Search for a card the way you would on eBay. The app checks every listing, identifies the exact card and printing, prices it from real sold comps, and tells you whether it's a buy, how much to bid at most, and why.

> **The question it answers:** *At this price, is this card worth buying to resell?*

---

## Contents

- [How a search works](#how-a-search-works)
- [What you get](#what-you-get)
- [Design principles](#design-principles)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Scripts](#scripts)
- [Project layout](#project-layout)
- [Costs and limits](#costs-and-limits)
- [Testing](#testing)
- [Known gaps](#known-gaps)

---

## How a search works

Every search runs through a funnel, so the expensive steps only happen for listings that could actually make money.

```
Your search          base set 1999 charizard
    │
    ▼
AI reads the search  → Charizard, Base Set, any printing
    │
    ▼
eBay search          up to 1,000 results, the way eBay matches them
    │                listings that aren't this card are set aside
    ▼
Free check           AI reads each title (set, number, grade, condition)
    │                and prices the listing at its best case
    ▼
eBay details         only for listings that pass, then a second check
    │
    ▼
AI analysis          the photos: condition, printing marks, the slab label
    │                (the most promising candidates, a few at a time)
    ▼
Money math           every resale path, a verdict, a max bid, and a rating
```

Three ways to flip a card are priced for every listing:

| Path | Buy | Sell | Priced from |
| --- | --- | --- | --- |
| **Resell raw** | Raw card | Raw, as is | Market price in its condition |
| **Buy and grade** | Raw card | PSA or CGC slab | Sold comps across its likely grade range |
| **Resell the slab** | Graded slab | Same slab | Sold comps at its exact grader and grade |

## What you get

- **A verdict for every listing:** buy raw, buy and grade, buy graded, pass, needs review, or can't price.
- **A max bid:** the most you can pay and still clear your targets after eBay fees, sales tax, shipping, and grading costs.
- **Your targets, live:** set a minimum profit and minimum return in the toolbar (or *Any*). Every max bid, verdict, and ranking recalculates instantly, with no new lookups.
- **Ratings:** *Strong*, *Good*, or *Thin*, from plain rules: room under the max bid, the outcome at the low end of the grade range, how many sales back the price, photo confidence, and seller feedback. Every concern is listed.
- **Bargain signals:** signs a listing is overlooked or mispriced because of how it was listed: photos showing a pricier printing than the title says, a misspelled name, no set or number, missing item details, weak photos of an identifiable card, auctions with almost no bids or ending in the middle of the night, new sellers. Each listing gets a score with the reasons, and **Most overlooked first** sorts by it. A signal is never a buy: the photos and the money math still decide.
- **Dig deeper:** after a search, a button that goes after single cards a plain search misses: misspelled names (the AI writes the likely misspellings), number-only titles, and listings in the wrong eBay category. The photo decides whether the card is there, then the usual checks run. **Hidden finds** shows only what still has genuine profit, labeled with how it was found. Lots are never shown. Up to 120 photo checks per dig.
- **Best Offer:** for a Buy It Now that takes offers, what to offer and where to walk away, plus a friendly note to send with it. Listings that would be a deal at a realistic offer show up in **Deals**.
- **Honest auctions:** an auction is judged by how often the card actually sells as low as your max bid, not by today's bid. Auctions that will very likely end above it go to **Long shots**.
- **The exact printing:** 1st Edition, Shadowless, and Unlimited are priced apart, and the title, item details, slab label, and photos have to agree.
- **Reprints caught:** Celebrations, Classic Collection (2021 and 2026), Base Set 2, metal cards, and Topps cards don't get priced as vintage originals.
- **Checked comps:** sold comps pass hard rules first, then an AI check that drops sales of another card, printing, or grade, qualified or signed copies, lots, and altered cards.

## Design principles

1. **Identity first, price second.** No price source decides what card a listing is. A card is priced only once its set, number, and printing are known.
2. **The AI reports; code does the money.** The AI reads photos, titles, and searches. Every fee, profit, return, and max bid is plain code, and the same inputs always give the same answer.
3. **Fail closed.** Anything unknown stops the math instead of being guessed: an unclear printing goes to review, and a grade with no sales underneath it can't be priced.
4. **Pricier printings need two witnesses.** 1st Edition or Shadowless needs both the seller's word and the photos.
5. **Spend AI to save scarce things.** AI calls are batched and their answers saved, and they're used to avoid eBay requests, which are limited per day.

## Getting started

**Requirements**

- Node.js 22 or later
- API keys for [eBay](https://developer.ebay.com/my/keys) (Browse API, Production), [OpenAI](https://platform.openai.com/api-keys), and [pkmnprices](https://pkmnprices.com) (Pro plan)

**Install and run**

```bash
git clone https://github.com/life423/pokemon-flipper.git
cd pokemon-flipper
npm install
cp .env.example .env    # then fill in your keys
npm run dev
```

Open **http://localhost:3000** and search for a card.

## Configuration

**Keys, in `.env`**

| Variable | Required | What it's for |
| --- | --- | --- |
| `EBAY_CLIENT_ID` | Yes | eBay Browse API app ID |
| `EBAY_CLIENT_SECRET` | Yes | eBay Browse API cert ID |
| `OPENAI_API_KEY` | Yes | Photo analysis, reading searches and titles, comp checks |
| `PKMNPRICES_API_KEY` | Yes | Raw prices and graded sold comps |
| `EBAY_SHIP_TO_ZIP` | No | Lets eBay quote calculated shipping to your ZIP |
| `OPENAI_MODEL` | No | Overrides the default model |
| `POKEMON_PRICE_TRACKER_API_KEY` | No | A second price source, kept as a cross-check |
| `PORT` | No | Server port, 3000 by default |

**Money settings, in [`shared/money/config.ts`](shared/money/config.ts)**

eBay fees, sales tax, shipping costs, PSA and CGC service levels, and default targets all live in one file. Each part (selling, buying, grading) is marked verified once it's checked against your own accounts; until then, every analysis notes what's still unchecked.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Frees port 3000, then runs the app with live reload |
| `npm run kill-ports` | Stops whatever is using port 3000 |
| `npm test` | Runs the test suite; no paid API calls |
| `npm run typecheck` | Type-checks the server and the page |
| `npm run build` | Builds the page for production |
| `npm start` | Runs the production build |
| `npm run evaluate -- <eBay link>` | Prints the full analysis of one listing |
| `npm run consistency -- <eBay link> [runs]` | Re-runs the AI several times to measure how much its answers vary (paid) |

## Project layout

```
server/
  app.ts          API routes; serves the page
  ai/             OpenAI: photo analysis, title reading, comp checks
  analysis/       Runs a full analysis; code rules on the AI's answers
  deals/          The free check and the search funnel
  ebay/           eBay search and listing details, with caching
  identity/       Card, set, number, and printing identity; slab checks
  pricing/        pkmnprices, raw prices, graded comps
  search/         Reading a search; which results match it
  lib/            Cache, batching, concurrency, paths
shared/
  money/          The money math, run by both the server and the page
  types.ts        One set of types for the server and the page
client/           The React app (Vite)
scripts/          Command-line tools
test/             Tests, in the same folders as server/ and shared/
```

Everything is TypeScript. The server runs through [tsx](https://tsx.is), and the page is React with Vite, served by the same Express server on one port.

## Costs and limits

**eBay.** The Browse API allows 5,000 requests a day per app by default. The app keeps its use low:

- The free check runs on search results with AI-read titles; only listings that pass get an eBay detail request. That's about 300 requests per new 1,000-result search instead of 1,000.
- Searches are saved for 10 minutes and listing details for a week. Analyzing a listing you've already searched usually costs no eBay request at all.
- Changing targets, filters, or sorting never touches eBay.
- Searches fetch 400 results by default (eBay sorts by best match, so later pages are mostly loose matches). **Filters** can raise it to 1,000.
- The page shows how many of today's requests are left, from eBay's own count. In the last 10% of the day's allowance, the free check stops fetching listing details and works from titles, so searches keep working until the allowance resets at midnight Pacific.

eBay raises the limit through its free [Application Growth Check](https://developer.ebay.com/grow/application-growth-check).

**OpenAI.** Reading a search is one call, saved for a month. Titles are read 25 per call and saved for good. Comp checks are batched per card and grade and saved per sale. A full photo analysis is a few vision calls; its answers are saved per listing and reused until the photos change. Every candidate that lands in **Waiting** is analyzed automatically, best first, three at a time; long-shot auctions are skipped. The **AI per search** setting can cap that, or turn it off.

**pkmnprices.** Credits are charged per row returned. Responses are saved for a day.

## Testing

```bash
npm test            # 145 tests
npm run typecheck   # server, shared code, scripts, and the page
```

The tests cover identity and printing rules, comp filtering, the money math, ratings, auctions, search matching, and the search funnel. None of them call a paid API.

## Known gaps

- **PSA prices aren't verified yet.** eBay fees (13.6% plus $0.40), shipping costs, the 8.25% purchase tax, and CGC's fees are matched to real orders and published prices; PSA's in [`shared/money/config.ts`](shared/money/config.ts) still need checking.
- **Printings named only in item details.** The free check reads titles, so a slab whose seller writes *Shadowless* or *1st Edition* only in the item details is checked as Unlimited at first.
- **BGS and SGC slabs** aren't priced yet, and **non-English cards** are skipped.
- **Grade odds are a fixed rule:** the likely grade counts most and each grade away counts less. It isn't yet measured against real grading results.

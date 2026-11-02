# Pokemon Flipper

Find eBay Pokémon card listings worth flipping, priced to the exact printing, with a max bid for every one.

Search for a card or inspect a listing link. The app checks identity, price evidence and estimated costs before presenting a purchase limit. Current HTTP searches use a small bounded workflow with a persistent **$0.02 AI cap per search**.

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
- [Database storage](#database-storage)
- [Testing](#testing)
- [Known gaps](#known-gaps)

---

## How a search works

Current HTTP searches fetch one page of up to 200 listings, apply free format,
card-type, price and auction-window exclusions, then admit at most three
development candidates. Preliminary interpretation uses saved metadata or local
rules, with no fresh AI title, photo or price screening. Buy It Now searches
prioritize newly listed inventory. Automatic broad discovery and pricing
recovery are disabled for this development slice.

```
Your search          base set 1999 charizard
    │
    ▼
Saved/local reading  → literal card, set and grade constraints
    │
    ▼
eBay search          one English-only page; at most 3 eligible candidates
    │                listings that aren't this card are set aside
    ▼
Local screening      obvious mismatches, junk, prices and auction windows
    │                seller claims remain unverified
    ▼
eBay details         fetched when needed, within the shared daily allowance
    │
    ▼
Saved evidence       reuse unchanged photo assessments first
    │
    ▼
Bounded AI           exact input-token preflight, then one combined assessment
    │                of up to 6 photos; no automatic second opinion
    ▼
Prices and money     matched evidence, costs, a verdict and purchase ceiling
```

The bounded assessment combines identity, printing, photo coverage and raw
condition or the actual slab label. It records which photos were inspected;
unselected images are not described as assessed. A separate assessment version
keeps this evidence distinct from the older multi-pass workflow. Three resale
paths use existing deterministic pricing and money rules:

| Path | Buy | Sell | Priced from |
| --- | --- | --- | --- |
| **Resell raw** | Raw card | Raw, as is | Market price in its condition |
| **Buy and grade** | Raw card | PSA or CGC slab | Sold comps across its likely grade range |
| **Resell the slab** | Graded slab | Same slab | Sold comps at its exact grader and grade |

## What you get

Sections depend on available evidence. Bounded HTTP research does not regenerate
every legacy diagnostic or buy missing evidence solely to fill a UI section.

- **Targeted pricing retries:** temporary provider failures offer **Retry pricing**, up to five listings at a time after cooldown. The queue reuses caches, stops on provider limits and preserves existing assessments. Identity problems and missing comps stay separate. New candidates follow your existing AI setting; retries do not refresh listing terms or rerun search/discovery. See [limits and verification](docs/pricing-retries-card-details-2026-10-30.md).
- **Grade and finish at a glance:** card headers show values such as **Listed: PSA 8 · Holo**, then **Label checked** after a successful slab assessment. Raw cards remain labeled Raw; unreadable or qualified grades need review. Short entrances, selection underlines and save feedback respect reduced-motion preferences.
- **Flexible search:** type “Aquapolis cards PSA 7 or better holo”, “PSA 8+ Aquapolis holos”, or “Neo Genesis Lugia CGC 8.5 to 9.5”. The app shows the interpreted criteria and enforces the requested grader, inclusive slab-grade range and finish. Holo, reverse holo and non-holo stay distinct. A raw card's potential grade is a separate filter. Ordinary keyword searches and listing links still work. See [behavior and live verification](docs/flexible-search-2026-10-30.md).
- **Evaluate a listing link:** choose **Evaluate eBay link**, paste or drop a full eBay.com listing link, then choose **Evaluate listing · paid**. Pasting a link in search mode also selects evaluation. Switching modes preserves both drafts. The app checks that one listing's current terms and photos, opens its analysis, and lets you save it. Item numbers also work. Tracking parameters are removed; a link evaluation does not start a broad search or overlooked-listing discovery.
- **Shortlist:** save up to 100 listings with their latest local assessment, notes and your own bid/purchase ceiling. Saving and opening the shortlist make no paid/provider calls.
- **Targeted refresh:** check one saved listing or up to ten selected listings. Current prices, shipping, bids, end time, photos and availability replace the snapshot. Unchanged photos reuse the assessment; changed photos require an explicit analysis. Unavailable listings retain their history but no purchase advice.
- **Find new listings:** fetch one newest-result page, skip previously seen IDs and apply selected filters before admitting up to three development candidates. Earlier results stay available. This window does not cover all eBay inventory.
- **A verdict for every listing:** buy raw, buy and grade, buy graded, pass, needs review, or can't price.
- **A max bid:** the most you can pay and still clear your targets after eBay fees, sales tax, shipping, and grading costs.
- **Resale evidence:** raw cards use a recent eBay sold median when at least three sales explicitly match the printing, finish and condition. Otherwise the condition-specific TCGplayer market price remains a labeled fallback. Open Prices to inspect the matched sales. Graded cards prefer 90-day sales when at least three match, with a labeled 180-day fallback for sparse grades. Only USD sales enter the money math.
- **Trading activity:** fuller saved assessments can show recorded eBay sales over 30 days, active selling days and average recorded sales per day. Counts cover the same printing, with raw conditions or slab grades combined. They measure provider observations, not total market volume or guaranteed time to sell; bounded research does not buy a new activity lookup.
- **Your targets, live:** set a minimum profit and minimum return in the toolbar (or *Any*). Every max bid, verdict, and ranking recalculates instantly, with no new lookups.
- **Ratings:** *Strong*, *Good*, or *Thin*, from plain rules: room under the max bid, the outcome at the low end of the grade range, how many sales back the price, photo confidence, and seller feedback. Every concern is listed.
- **Bargain signals:** signs a listing is overlooked or mispriced because of how it was listed: photos showing a pricier printing than the title says, a misspelled name, no set or number, missing item details, weak photos of an identifiable card, auctions with almost no bids or ending in the middle of the night, new sellers. Each listing gets a score with the reasons, and **Most overlooked first** sorts by it. A signal is never a buy: the photos and the money math still decide.
- **Overlooked listings:** the discovery implementation supports misspellings,
  number-only titles and wrong categories. Automatic discovery is paused in the
  current development slice. Verified opportunities appear in **Deals** with
  their discovery reason; there is no separate Hidden finds view.
- **Best Offer:** for a Buy It Now that takes offers, show a realistic offer and walk-away amount when supported. Conditional offer opportunities are separate from profit at asking price; the app submits no offers.
- **Auction guidance:** maximum bids include the modeled costs and targets. Observed sales provide market references, without a forecast of the closing price.
- **The exact printing:** 1st Edition, Shadowless, and Unlimited are priced apart, and the title, item details, slab label, and photos have to agree.
- **Reprints caught:** Celebrations, Classic Collection (2021 and 2026), Base Set 2, metal cards, and Topps cards don't get priced as vintage originals.
- **Checked comps:** sold comps pass identity, printing, finish, grader/grade and other eligibility rules. Bounded HTTP research reuses saved AI comp checks and sold-copy condition evidence; it does not purchase new comp-review batches or historical photo assessments. Missing matched sales remain unavailable or use the labeled market fallback.

## Design principles

1. **Identity first, price second.** No price source decides what card a listing is. A card is priced only once its set, number, and printing are known.
2. **The AI reports; code does the money.** Bounded searches use cached/local metadata and AI photo findings. Every fee, profit, return, and max bid is plain code, and the same inputs always give the same answer.
3. **Fail closed.** Anything unknown stops the math instead of being guessed: an unclear printing goes to review, and a grade with no sales underneath it can't be priced.
4. **Premium printings need corroborated evidence.** A seller's title alone cannot establish 1st Edition or Shadowless.
5. **Reuse before spending.** Saved evidence is checked before new paid work. Every generation needs a verified input count and an affordable maximum output; eBay requests have separate daily and development allowances.

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

Open **http://localhost:3017** and search for a card. This app uses its own port
so it can run alongside Ascend Avoid on port 3000. Startup never kills another
process; if 3017 is already occupied, use the running instance or set `PORT`.

The current development search is English-only. Browse searches use the card
category's Language aspect; wrong-category discovery uses English keywords.
Known foreign title, item-specific and saved photo evidence is excluded before
further paid assessment. Unknown language stays preliminary until identified.

The server reads `.env` at startup. After adding or changing keys, restart
`npm run dev`. eBay requires a matching Production app ID and cert ID. Missing or
rejected eBay credentials now appear as an actionable search error.

## Configuration

**Keys, in `.env`**

| Variable | Required | What it's for |
| --- | --- | --- |
| `EBAY_CLIENT_ID` | Yes | eBay Browse API app ID |
| `EBAY_CLIENT_SECRET` | Yes | eBay Browse API cert ID |
| `OPENAI_API_KEY` | Yes | Exact input-token preflight and photo analysis |
| `PKMNPRICES_API_KEY` | Yes | Raw prices and graded sold comps |
| `EBAY_SHIP_TO_ZIP` | No | Lets eBay quote calculated shipping to your ZIP |
| `OPENAI_MODEL` | No | Overrides legacy text/vision defaults |
| `OPENAI_BOUNDED_VISION_MODEL` | No | Bounded photo model; unsupported pricing remains blocked |
| `POKEMON_PRICE_TRACKER_API_KEY` | No | A second price source, kept as a cross-check |
| `PORT` | No | Server port, 3017 by default |

**Money settings, in [`shared/money/config.ts`](shared/money/config.ts)**

eBay fees, sales tax, shipping costs, PSA and CGC service levels, and default targets all live in one file. Each part (selling, buying, grading) is marked verified once it's checked against your own accounts; until then, every analysis notes what's still unchecked.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the app with live reload; never stops another app |
| `npm test` | Runs the test suite; no paid API calls |
| `npm run typecheck` | Type-checks the server and the page |
| `npm run build` | Builds the page for production |
| `npm start` | Runs the production build |
| `npm run evaluate -- <eBay link>` | Prints the full analysis of one listing |
| `npm run consistency -- <eBay link> [runs]` | Re-runs the AI several times to measure how much its answers vary (paid) |

## Project layout

Start with the [workflow and code map](docs/architecture.md) to follow one
listing from search through photo assessment, pricing, money rules and the UI.

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
  shortlist/      Persistent saved listings and targeted refresh
  lib/            Cache, batching, concurrency, paths
shared/
  money/          The money math, run by both the server and the page
  types.ts        One set of types for the server and the page
client/src/
  App.tsx         Page, request, analysis-queue and cancellation coordination
  analysis-state.ts Shared client loading/error/completed state
  search/         Result selectors, saved preferences and search controls
  components/     Cards, panels and other interface components
    analysis/     Focused financial, evidence, price and offer detail sections
scripts/          Command-line tools
test/             Tests, in the same folders as server/ and shared/
```

Everything is TypeScript. The server runs through [tsx](https://tsx.is), and the page is React with Vite, served by the same Express server on one port.

## Costs and limits

**eBay.** The Browse API allows 5,000 requests a day per app by default. The app keeps its use low:

- Bounded preliminary screening uses the search result and saved/local title metadata. It requests no listing details or additional photos. The selected candidate's evaluator loads details only when valid saved details are unavailable. Shipping caches remain separated by destination ZIP.
- Ordinary searches are saved for 10 minutes; newest-inventory searches use a one-minute cache. Listing details are saved for a week and checked against the current title/photo snapshot before reuse. A saved detail response does not prove current availability indefinitely.
- Repricing a completed analysis, filtering loaded results and sorting make no
  eBay requests. Lower targets can qualify additional automatic analyses within
  the current AI budget. Widening the minimum Buy It Now price requires an explicit
  **Rerun search** to include previously excluded listings.
- Development searches fetch one page of up to 200 results, apply free exclusions,
  and admit at most three candidates to screening. This is a limited sample of
  eBay inventory; it does not promise three deals or complete search coverage.
- Each Browse request reserves a call at the transport boundary. A ledger shared by local instances of the same eBay account reconciles provider usage without resetting spent calls. Optional lookups preserve the last 10%; no Browse request is sent after exhaustion. Cached evidence remains usable. Provider reset times determine the reset; without a reported reset, accounting conservatively uses a 24-hour window.

eBay raises the limit through its free [Application Growth Check](https://developer.ebay.com/grow/application-growth-check).

**OpenAI.** A persistent guard at the SDK transport boundary enforces a maximum
of **$0.02 per search** across concurrent stages, retries and process restarts.
Paid processing is operator-controlled. Fresh installations, missing or invalid
controls/ledgers and unsupported model or cache pricing fail closed; starting
the app does not enable spending or reset a search allowance.

Before a generation request leaves, the transport requires immutable inline
image bytes, a trusted exact input count, supported default-tier/cache settings,
a bounded output and a durable reservation. Input preflight uses OpenAI's
count-only endpoint for the final request's model, instructions, schema and
images, with successful proofs reused for identical inputs. Generation has no
automatic retries in the bounded workflow. Unknown billing retains its full
reservation; a reported overage pauses further dispatch. Budget reporting
distinguishes reported spend from unconfirmed holds.

An uncached candidate receives one combined identity/condition/slab assessment
of at most six selected photos, with a 2,200-token output limit. Valid existing
photo evidence is reused first. Bounded HTTP research does not buy separate
identity passes, a second condition opinion, fresh comp-check batches or sold
listing photo reviews. Legacy diagnostic evaluators retain their older workflow
and remain subject to the same spending guard.

A controlled four-photo assessment's reported token usage cost **$0.0030728**
at the verified model rates.
Repeating the same photo evidence used no new AI generation, and the check used
no eBay Browse requests. This is a focused assessment canary, not the measured
cost or deal quality of a complete uncached search.

Underlying AI concurrency remains a ceiling, not a spending allowance.
Development UI offers up to three assessments or Off; source HTTP limits
apply before screening as well. Saved successful and unresolved photo evidence
is reused for unchanged inputs. Budget/credit pauses stop later work and leave
unfinished cards in Sorting, rather than pretending analysis completed.

**pkmnprices.** Credits are charged per row returned. Card/market-price responses are saved for a day; recent eBay sales and sales-volume responses for six hours. Raw evidence samples at most two pages (40 sales) per printing over 90 days, shared across listings. Volume uses one bounded 30-row page per printing/raw-or-graded scope and labels incomplete coverage. An unavailable plan feature does not block working price lookups. No background polling is added.

Saved shortlist valuations from an older pricing version or more than six hours ago do not supply current advice. Opening them refreshes the valuation, reusing valid unchanged photo assessments. The full-analysis setting still controls automatic search evaluations.

**Saved listings and new inventory.** Saves, notes, ceilings and removals use local
storage on the app server, with no provider call. Targeted refresh runs at most two
eBay detail requests at once, reuses successful checks for one minute, and backs
off failed checks for 30 seconds. It preserves the daily reserve and never starts
AI analysis. New inventory scans share a separate one-minute newest-search cache,
remember seen IDs across restarts and screen up to three unseen development
matches. Preliminary screening uses saved/local metadata; the selected
assessment setting applies to the bounded photo work on that small batch.
There is no recurring inventory polling.

The shortlist lives in `data/shortlist.json`; discovery history lives in
`data/search-history.json`. They belong to this app installation, with no account
sync. Back up these files along with the rest of `data/`. For isolated tests,
`POKEMON_FLIPPER_DATA_DIR` selects another data directory. See
[implementation and verification](docs/shortlist-discovery-2026-10-29.md).

**Direct links.** Each deliberate link submission checks current eBay details,
then reuses those details for bounded analysis under its capped search ID. Matching saved title/photo
assessments avoid another AI charge. Invalid links and unsupported variations
make no provider request; obvious non-single-card listings, unavailable listings
and missing photos stop before analysis. See [supported inputs and live checks](docs/listing-links-2026-10-30.md).

## Database storage

The backend supports local files and Azure SQL Database. Select the backend
explicitly with `POKEMON_FLIPPER_STORAGE=file` or `azure-sql`; the default is
local files. SQL mode never silently substitutes a file cache when SQL fails.

Azure SQL uses passwordless Microsoft Entra authentication through one small
connection pool with encrypted, certificate-validated connections. Local
development can use the existing `az login` identity:

```dotenv
POKEMON_FLIPPER_STORAGE=azure-sql
AZURE_SQL_SERVER=your-server.database.windows.net
AZURE_SQL_DATABASE=your-database
AZURE_SQL_AUTH=azure-cli
AZURE_SQL_OWNER_ID=local-owner
```

Use `AZURE_SQL_AUTH=default` for the Azure Identity credential chain, including
managed identities on supported Azure hosts. Public deployment still needs
authenticated user ownership and an appropriately scoped application identity;
the current local owner is not a public account system.

```sh
npm run db -- import --dry-run # validate existing files without SQL or provider calls
npm run db -- migrate          # apply versioned SQL schema explicitly
npm run db -- import           # back up, import in batches and verify every record
npm run db -- verify           # compare SQL with the saved import snapshot
npm run db -- status           # show schema version and saved record counts
npm run db:check               # encrypted connection and disposable concurrency checks
```

Import preserves original timestamps, evidence versions and newer SQL data.
Checksummed source backups and resumable checkpoints remain under ignored
`data/database-migration/`; original cache/assessment files are retained. Import
does not call OpenAI, eBay or price providers. SQL stores shared observations
separately from owner-specific financial evaluations. Destination-specific and
unknown cache namespaces remain owner-scoped.

Durable task claims prevent simultaneous identical AI dispatches. Completed
responses with identical inputs and owner context can be reused; dispatched
requests with unknown outcomes retain their
claims. An accepted answer can checkpoint locally during a SQL outage and later
save that answer without buying it again. A storage outage is distinct from a
confirmed cache miss and blocks new provider requests.

Startup checks the selected SQL schema before listening. The local app's
`GET /api/storage` endpoint reports backend readiness without requesting any
provider data; it uses the same local-only API header protection as other routes.

The current runtime spending/quota guards, shortlist, search history and usage
logs still use their existing local files. SQL budget/attempt tables establish
the schema for later shared accounting; they do not yet authorize independently
hosted replicas to use separate local allowances. The app remains a local,
single-host development deployment with operator-controlled paid AI. A complete
server-owned worker queue and public multiuser authentication are separate
remaining work.

Store original image bytes outside the Basic database; SQL keeps references
and fingerprints. Monitor storage and query load before increasing concurrency.

## Testing

### Historical seven pass spending audit

The original November 2 review followed the complete outgoing-provider paths and
their callers, saved-state transitions and client controls. These are the reviewed
boundaries and the regressions added for their failure cases:

| Pass | Verified boundary |
| --- | --- |
| Dispatch and cancellation | Stop/disconnect blocks queued titles, photos, pricing, comparisons and retries; accepted paid answers finish saving. |
| Reuse and concurrency | Same evidence shares work; canceled/restarted consumers wait for saved results; successful and unresolved answers do not expire into automatic repurchases. |
| Candidate selection | Source/known filters precede paid work; auctions use a fixed search-start 12-hour window and expire before later stages; only three development candidates enter screening. |
| Evidence and messages | Exact identity/finish gates reject unusable comparisons; numbered close-up notes cannot masquerade as listing-wide missing coverage; deliberate deferrals do not create false deals or routine review tasks. |
| Cost and quota | Persistent, cross-process reservations enforce the two-cent ceiling; unknown costs and missing/corrupt accounting block dispatch; Browse has a separate protected development allowance. |
| Lifecycle and outcomes | Changed filters stop old-scope work; target/price changes recheck hypothetical upside; manual upgrades reuse photo work; Sorting and Deals reflect actual assessment state. |
| Attribution and isolation | Search UUIDs, task/model/tier, usage/cache writes and request hashes are logged without prompts or credentials; tests use temporary data and explicit offline transport mocks. |

These checks use offline SDK/HTTP fixtures and stored evidence, including the
real cropped-close-up/full-back warning regression. Photo-viewer interaction
checks used local synthetic images at mobile and desktop sizes. They do not
certify future model judgments, complete market coverage or profitable flips.
An independent financial-formula/rate audit and a measured live search remain
pending. No new OpenAI generation, token-count or eBay Browse calls were used
for that offline audit, and paid processing was paused at its checkpoint. The
bounded-workflow canary described above was performed later; it does not replace
a complete search benchmark or the financial audit.

An optional `data/ebay-development-budget.json` adds a persisted Browse allowance
until its `expiresAt` time. It complements the daily quota and reserve; cached
reads, OAuth and Analytics do not consume it. Missing configuration leaves the
normal daily controls active. With `requireRenewal: true`, expiry also blocks Browse until an
explicit renewal; it never restores an uncapped development allowance. Without
that flag, the optional development cap expires while normal daily controls remain.
Invalid accounting or a retained lock blocks new
Browse requests. After a crash, stop all app instances and verify the owner is
no longer running before removing only `ebay-development-budget.json.lock`.
Keep the JSON ledger and its used count. An old lock is never stolen automatically.

`npm test` creates a temporary `POKEMON_FLIPPER_DATA_DIR` and selects file storage
for the suite, so mocked transport cannot consume the real ledgers. Direct
`node --test` invocations must provide the same isolation explicitly.

```bash
npm test            # offline provider and workflow regressions
npm run typecheck   # server, shared code, scripts, and the page
```

The tests cover identity and printing rules, comp filtering, the money math, ratings, auctions, search matching, and the search funnel. None of them call a paid API.

## Known gaps

- **PSA fees need account verification.** Public service levels were checked against PSA's October 30 schedule, including available Standard and the current Express fee. PSA remains unverified against your invoice/account. Your recorded 13.6% eBay fee, shipping assumptions, purchase tax and CGC schedule remain configurable in [`shared/money/config.ts`](shared/money/config.ts).
- **Printings named only in item details.** The free check reads titles, so a slab whose seller writes *Shadowless* or *1st Edition* only in the item details is checked as Unlimited at first.
- **Exact slab markets need coverage.** A readable grader/grade does not ensure matching sold prices are available. Non-English cards are excluded from the current scope.
- **Grade odds are a fixed rule:** the likely grade counts most and each grade away counts less. It isn't yet measured against real grading results.

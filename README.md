# Pokemon Flipper

Find eBay Pokémon card listings worth flipping, priced to the exact printing, with a max bid for every one.

Search for a card or inspect a listing link. The app checks identity, price evidence and estimated costs before presenting a purchase limit. Current HTTP searches admit up to **50 matching metadata rows**, with a persistent **$0.02 AI cap** and **100 Browse-request cap per new search**. Displayed listings and paid assessments have separate limits.

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
card-type, price and auction-window exclusions, then admit at most 50 matching
metadata rows. Preliminary interpretation uses saved metadata or local rules.
Before emitting those candidates to the browser, a price-first stage gathers
recent matched eBay sold records through PKMNPrices, reusing the configured
SQL/file cache. It uses no AI or additional eBay requests. Buy It Now searches
prioritize newly listed inventory. Normal searches and **Find new listings**
use this same stage; automatic broad discovery and pricing recovery remain off.

Sold screening processes at most four candidates concurrently and permits at
most 32 uncached PKMNPrices requests, including catalog lookups, within the
same persistent 64-request search allowance used by final valuation. It reads
one page of up to 20 sold records per requested market. Repeated listings share
catalog and sales work. At least three eligible matched sales are needed to
authorize automatic photo assessment; missing or deferred evidence stays in
Sorting without starting paid work. A raw First Edition Base Set lead priced
at $10 or less retains its focused-review exception.

Slabs use separate exact grader, grade, printing and finish markets. Their
median informs queue priority. Only a single explicit scope with three or more
sales in the past 90 days can exclude an obviously overpriced listing, using
the upper observed sold value after costs and the selected targets. Enabled
Best Offers remain limited to 10% below asking. Raw sold-condition buckets
remain separate priority references; they never assign this card a condition
or grade, or reject its possible grading upside. Unspecified-condition sales
are context only and provide no condition-specific price or purchase ceiling.
Unknown purchase shipping uses an explicitly optimistic $0 for this exclusion
check, preventing an assumed delivery charge from rejecting a possible lead.
Changing targets recalculates against retained sold references without fetching
them again; preliminary comparisons never create a confirmed Deal.

The automatic queue considers eligible loaded candidates with at most two
assessments in flight. It reuses saved evidence and starts new paid work only
while the shared two-cent search budget permits it. Fifty displayed rows do
not promise fifty AI assessments or fifty deals. Listing details and all nested
Browse work also share the separate 25-request search allowance.

```
Your search          base set 1999 charizard
    │
    ▼
Saved/local reading  → literal card, set and grade constraints
    │
    ▼
eBay search          one English-only page; up to 50 matching metadata rows
    │                listings that aren't this card are set aside
    ▼
Local screening      obvious mismatches, junk, prices and auction windows
    │                seller claims remain unverified
    ▼
Recent sold evidence PKMNPrices catalog + bounded eBay sold records; cache first
    │                rank candidates; exclude only clear exact-slab overpricing
    ▼
Browser queue        emit ranked candidates; missing price evidence stays Sorting
    │                automatic assessment requires supported sold references
    ▼
eBay details         fetched when needed; 25 Browse calls/search plus daily cap
    │
    ▼
Saved evidence       reuse unchanged photo assessments first
    │
    ▼
Bounded AI           exact input-token preflight, then one assessment
    │                RAW: up to 6 photos, 2,200 output tokens
    │                SLAB_LABEL: first 2 unique photos, 1,600 output tokens
    │                shared 2¢ budget; no automatic paid fallback/opinion
    ▼
Prices and money     matched evidence, costs, a verdict and purchase ceiling
```

Seller metadata chooses an advisory assessment plan. Raw or uncertain grading
claims use the existing combined identity/condition request, with its six-photo
selection and accepted-answer cache key preserved. A graded claim can use a
compact identity/slab-label check on the first two unique photos. That request
always returns a null condition; it does not estimate a raw condition or future
grade. The photographed holder and label determine the final resale route.
If a label-only check instead finds a raw card, it reports that result without
starting another paid raw assessment automatically.

The evaluator checks compatible saved combined and compact readings before
dispatch and selects the newest valid answer, preserving its original photo
numbers and coverage. Compatible stronger full legacy evidence retains priority.
Existing accepted combined/raw answers stay reusable, and a compatible compact
answer proving a slab can be reused even when advisory metadata requests raw
work. New requests and price freshness recognize the separate compact version;
this change does not require clearing paid evidence.

Supported raw condition can be used for as-is resale even when the photos do
not support a numeric grade. The grading route stays unavailable until a numeric
range is supported; no replacement range is invented. Three resale paths retain
their existing deterministic pricing and money rules:

| Path | Buy | Sell | Priced from |
| --- | --- | --- | --- |
| **Resell raw** | Raw card | Raw, as is | Recent condition-matched eBay sales; labeled market fallback when needed |
| **Buy and grade** | Raw card | PSA or CGC slab | Sold comps across a supported numeric grade range |
| **Resell the slab** | Graded slab | Same slab | Sold comps at its exact grader and grade |

## What you get

Sections depend on available evidence. Bounded HTTP research does not regenerate
every legacy diagnostic or buy missing evidence solely to fill a UI section.

- **Saved pricing retries:** the legacy **Retry pricing** controls remain for older ticketed results, using caches and preserving assessments. Current bounded searches leave missing prices in Sorting and do not issue new retry tickets. See the current [workflow](docs/architecture.md) and [historical retry implementation](docs/pricing-retries-card-details-2026-10-30.md).
- **Grade and finish at a glance:** card headers show values such as **Listed: PSA 8 · Holo**, then **Label checked** after a successful slab assessment. Raw cards remain labeled Raw; unreadable or qualified grades need review. Short entrances, selection underlines and save feedback respect reduced-motion preferences.
- **Flexible search:** type “Aquapolis cards PSA 7 or better holo”, “PSA 8+ Aquapolis holos”, or “Neo Genesis Lugia CGC 8.5 to 9.5”. The app shows the interpreted criteria and enforces the requested grader, inclusive slab-grade range and finish. Holo, reverse holo and non-holo stay distinct. A raw card's potential grade is a separate filter. Ordinary keyword searches and listing links still work. See [behavior and live verification](docs/flexible-search-2026-10-30.md).
- **Evaluate a listing link:** choose **Evaluate eBay link**, paste or drop a full eBay.com listing link, then choose **Evaluate listing · paid**. Pasting a link in search mode also selects evaluation. Switching modes preserves both drafts. The app checks that one listing's current terms and photos, opens its analysis, and lets you save it. Item numbers also work. Tracking parameters are removed; a link evaluation does not start a broad search or overlooked-listing discovery.
- **Shortlist:** save up to 100 listings with their latest local assessment, notes and your own bid/purchase ceiling. Saving and opening the shortlist make no paid/provider calls.
- **Targeted refresh:** check one saved listing or up to ten selected listings. Current prices, shipping, bids, end time, photos and availability replace the snapshot. Unchanged photos reuse the assessment; changed photos require an explicit analysis. Unavailable listings retain their history but no purchase advice.
- **Find new listings:** fetch one newest-result page, skip previously seen IDs and apply selected filters before admitting up to 50 matching metadata rows. Earlier results stay available. Automatic assessment depends on saved evidence and the remaining search budget. This window does not cover all eBay inventory.
- **Assessment verdicts:** buy raw, buy and grade, buy graded, pass, needs review, or can't price. Preliminary rows remain distinct from completed assessments.
- **A max bid:** the most you can pay and still clear your targets after eBay fees, sales tax, shipping, and grading costs.
- **Resale evidence:** one confirmed, exactly matched eBay sale can support a price; one or two matches retain low confidence. Raw resale also requires accepted photo-condition evidence for the sold copy. TCGplayer raw quotes remain labeled references and cannot establish a Deal alone. Graded cards prefer matching sales within 90 days, using the labeled 180-day fallback only when no current match exists. Open Prices to inspect the supporting sales. Only confirmed USD transaction amounts enter sold-price estimates.
- **Trading activity:** fuller saved assessments can show recorded eBay sales over 30 days, active selling days and average recorded sales per day. Counts cover the same printing, with raw conditions or slab grades combined. They measure provider observations, not total market volume or guaranteed time to sell; bounded research does not buy a new activity lookup.
- **Your targets, live:** set a minimum profit and minimum return in the toolbar (or *Any*). Every max bid, verdict, and ranking recalculates instantly, with no new lookups.
- **Ratings:** *Strong*, *Good*, or *Thin*, from plain rules: room under the max bid, the outcome at the low end of the grade range, how many sales back the price, photo confidence, and seller feedback. Every concern is listed.
- **Bargain signals:** signs a listing is overlooked or mispriced because of how it was listed: photos showing a pricier printing than the title says, a misspelled name, no set or number, missing item details, weak photos of an identifiable card, auctions with almost no bids or ending in the middle of the night, new sellers. Each listing gets a score with the reasons, and **Most overlooked first** sorts by it. A signal is never a buy: the photos and the money math still decide.
- **Saved seller-mistake evidence:** earlier independent photo observations
  remain readable and can support a corroborated identity correction. Current
  searches use the bounded query workflow; the unused broad photo-discovery
  writers have been retired. Supported opportunities appear in **Deals**.
- **Best Offer:** for a Buy It Now that takes offers, show a realistic offer and walk-away amount when supported. Conditional offer opportunities are separate from profit at asking price; the app submits no offers.
- **Auction guidance:** maximum bids include the modeled costs and targets. Observed sales provide market references, without a forecast of the closing price.
- **The exact printing:** 1st Edition, Shadowless, and Unlimited are priced apart. Supported photo/label evidence can resolve a wrong title or item detail; an unresolved material identity problem still blocks purchase advice.
- **Reprints caught:** Celebrations, Classic Collection (2021 and 2026), Base Set 2, metal cards, and Topps cards don't get priced as vintage originals.
- **Checked comps:** sold comps pass identity, printing, finish, grader/grade and other eligibility rules. Bounded HTTP research reuses saved AI comp checks and sold-copy condition evidence; it does not purchase new comp-review batches or historical photo assessments. Missing matched sales remain unavailable or use the labeled market fallback.

## Design principles

1. **Research prices before paying for photos; verify identity before advice.** Listing claims select preliminary sold markets without proving what the photographed card is. Final purchase advice requires the applicable identity and resale evidence.
2. **The AI reports; code does the money.** Bounded searches use cached/local metadata and AI photo findings. Every fee, profit, return, and max bid is plain code, and the same inputs always give the same answer.
3. **Keep uncertainty with the affected route.** An unclear printing needs review. An unsupported numeric grade blocks the grading route, while a supported raw condition can still price as-is resale. Missing matched price evidence is not invented.
4. **Premium printings need corroborated evidence.** A seller's title alone cannot establish 1st Edition or Shadowless.
5. **Reuse before spending.** Saved evidence is checked before new paid work. Every generation needs a verified input count and an affordable maximum output; eBay Browse requests have a persistent 25-request ceiling per search as well as account-wide daily protection.

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

The current search is English-only. Browse searches use the card category's
Language aspect.
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
| `POKEMON_PRICE_TRACKER_API_KEY` | No | Optional set-release-year catalog for the interface |
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
| `npm run evaluate -- <eBay link>` | Refreshes one listing's terms, reuses paid evidence and uses the app's bounded raw/slab evaluator |
| `npx tsx scripts/bounded-search-benchmark.ts --help` | Shows the explicit one-search diagnostic and provider-blocked cache replay; no provider work from help |

## Project layout

Start with the [workflow and code map](docs/architecture.md) to follow one
listing from search through photo assessment, pricing, money rules and the UI.

```
server/
  app.ts          API routes; serves the page
  ai/             OpenAI: photo analysis, title reading, comp checks
  analysis/       Runs a full analysis; code rules on the AI's answers
  deals/          Local checks, sold-price-first admission and the search funnel
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

- Bounded preliminary screening uses the search result, saved/local title metadata and cached/bounded PKMNPrices sold records. It requests no eBay listing details or additional photos. The selected candidate's evaluator loads details only when valid saved details are unavailable. Shipping caches remain separated by destination ZIP.
- Ordinary searches are saved for 10 minutes; newest-inventory searches use a one-minute cache. Listing details are saved for a week and checked against the current title/photo snapshot before reuse. A saved detail response does not prove current availability indefinitely.
- Repricing a completed analysis, filtering loaded results and sorting make no
  eBay requests. Lower targets can qualify additional automatic analyses within
  the current AI budget. Widening the minimum Buy It Now price requires an explicit
  **Rerun search** to include previously excluded listings.
- Development searches fetch one page of up to 200 results, apply free exclusions,
  and admit at most 50 matching metadata rows. These slots do not consume AI or
  listing-detail calls merely by being displayed. Automatic assessment reuses
  saved evidence and spends only within the separate search budgets; the loaded
  sample does not establish complete eBay coverage.
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

After saved-evidence reuse, an uncached RAW request assesses identity and
condition using at most six selected photos and a 2,200-token output limit.
An uncached SLAB_LABEL request uses the first two unique photos and a
1,600-token output limit for visible identity, certified label and case evidence;
condition is always null. Both use the same exact-input preflight, durable
reservation and two-cent ceiling. A disproved seller slab claim does not launch
a second paid raw assessment. Bounded HTTP research does not buy separate
identity passes, a second condition opinion, fresh comp-check batches or sold
listing photo reviews. The CLI uses this same evaluator; the separate legacy
evaluator and repeated fresh-opinion command have been retired. Smaller request bounds do not
establish a measured cost saving or guarantee label-reading quality.

A controlled four-photo assessment's reported token usage cost **$0.0030728**
at the verified model rates.
Repeating the same photo evidence used no new AI generation, and the check used
no eBay Browse requests. This is a focused assessment canary, not the measured
cost or deal quality of a complete uncached search.

Underlying AI concurrency remains a ceiling, not a spending allowance. The
development UI offers **Automatic · within 2¢** or **Off · manual only**.
Automatic work considers the eligible loaded rows, with at most two assessments
in flight after sold-price screening; the transport still enforces its persistent
spending reservations.
Saved successful and unresolved photo evidence is reused for unchanged inputs.
Budget/credit pauses stop later work and leave unfinished cards in Sorting,
rather than pretending analysis completed. Completed priced rejections stay
available in All matching instead of remaining in the work queue.

**pkmnprices.** Requests and credits are separate units: a request returning
20 sales can use 20 credits. The subscription currently supplies 20,000 daily
credits; actual reported remaining credits are read from provider headers,
not inferred from our local request counter. See the
[provider's credit rules](https://www.pkmnprices.com/docs/rate-limits).
The price-first stage permits at most 32 uncached requests, including catalog
work, within a persistent **64-request all-stage allowance per search ID**.
Final valuation and retries share that total; failed or unknown attempts remain
counted across restarts and days. One screening page holds up to 20 sales per
requested market. Cache hits do not consume requests or new credits; identical
catalog/market requests share work. Graded references prefer three or more
90-day matches, retaining a labeled 180-day reference when necessary; that
older reference cannot trigger a preliminary hard rejection. Raw screening
uses 90-day observations split by sold-title condition, including a separate
unspecified-condition context bucket. Provider failures or exhausted screening
allowance defer evidence rather than buying retries or creating zero prices.

Card/market-price responses are saved for a day; recent eBay sales and
sales-volume responses for six hours. Later full pricing retains its existing
sampling behavior within the shared allowance: raw evidence can sample up to two pages (40 sales) per
printing over 90 days, and volume uses one bounded 30-row page per
printing/raw-or-graded scope with incomplete coverage labeled. Bounded HTTP
assessment does not buy a new volume lookup. No background polling is added.

The existing usage panel now reports price requests and provider-reported
credits separately from the two-cent OpenAI budget and eBay Browse quota.
Missing charge headers remain explicitly incomplete. The remaining daily
credit count is the last provider observation, not a live balance from polling.
Accepted responses are saved to the configured SQL/file response cache even
after Stop; Stop prevents subsequent requests. If price research reaches its
limit after photos finish, completed routes remain usable and unfinished routes
stay deferred. A fully supported profitable route can still reach Deals.
The request ledger is local and keyed to the configured API key, not a shared
provider-account authority across key rotation or independent replicas.

Saved shortlist valuations from an older pricing version or more than six hours ago do not supply current advice. Opening them refreshes the valuation, reusing valid unchanged photo assessments. The full-analysis setting still controls automatic search evaluations.

**Saved listings and new inventory.** Saves, notes, ceilings and removals use local
storage on the app server, with no provider call. Targeted refresh runs at most two
eBay detail requests at once, reuses successful checks for one minute, and backs
off failed checks for 30 seconds. It preserves the daily reserve and never starts
AI analysis. New inventory scans share a separate one-minute newest-search cache,
remember seen IDs across restarts and admit up to 50 unseen matching metadata
rows. Preliminary screening uses saved/local metadata; automatic photo work
shares the two-cent budget and two-assessment in-flight limit. The 25-request
Browse ceiling includes both initial retrieval and follow-up details.
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

The price-first stage reuses this existing response cache and shares matched
sold summaries within the scan. It adds no long-term sold-observation table or
database migration; those remain separate future work.

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
| Candidate selection | Source/known filters precede paid work; auctions use a fixed search-start 12-hour window and expire before later stages. The historical batch restriction has since been replaced by the current 50-row metadata admission and budget-bounded automatic queue. |
| Evidence and messages | Exact identity/finish gates reject unusable comparisons; numbered close-up notes cannot masquerade as listing-wide missing coverage; deliberate deferrals do not create false deals or routine review tasks. |
| Cost and quota | Persistent, cross-process reservations enforce the two-cent ceiling; unknown costs and missing/corrupt accounting block dispatch; Browse has a separate 25-request per-search ceiling and account-wide daily protection. |
| Lifecycle and outcomes | Changed filters stop old-scope work; target/price changes recheck hypothetical upside; manual upgrades reuse photo work; Sorting and Deals reflect actual assessment state. |
| Attribution and isolation | Search UUIDs, task/model/tier, usage/cache writes and request hashes are logged without prompts or credentials; tests use temporary data and explicit offline transport mocks. |

These checks use offline SDK/HTTP fixtures and stored evidence, including the
real cropped-close-up/full-back warning regression. Photo-viewer interaction
checks used local synthetic images at mobile and desktop sizes. They do not
certify future model judgments, complete market coverage or profitable flips.
The subsequent [financial calculation audit](docs/financial-calculation-audit-2026-11-03.md)
corrects currency rounding, target ceilings, ROI, promotion fees and sold-price
eligibility, and documents the remaining input assumptions. The later controlled
search is recorded below. No new OpenAI generation, token-count or eBay Browse calls were used
for that offline audit, and paid processing was paused at its checkpoint. The
bounded-workflow canary described above was performed later; it does not replace
a complete search benchmark.

Each search allows at most **25 actual Browse transport requests**, including
listing details and other nested follow-up work carrying the same
`X-Pokemon-Flipper-Search-Id`. Cached reads, OAuth and Analytics consume none.
Counts persist under `data/ebay-search-budgets/`, scoped to the configured eBay
account and search ID. A restart, retry or calendar change does not replenish
the same search. A new search gets its own allowance while sharing the real
daily quota and optional-work reserve. The interface distinguishes this search's
remaining requests from eBay's daily remaining count.

The former expiring global `data/ebay-development-budget.json` is retained as
history and no longer blocks live searches. It incorrectly treated the intended
per-search limit as one shared development allowance. Invalid new accounting or
a retained per-search lock blocks Browse work. After a crash, stop all app
instances and verify the owner is no longer running before removing only that
search's `.json.lock` file. Keep its JSON ledger and used count; old locks are
never stolen automatically. The evaluate and bounded-search-benchmark CLI
commands establish one research ID through their shared scope helper; new CLI
callers must also establish a scope before making uncached Browse requests.

`npm test` creates a temporary `POKEMON_FLIPPER_DATA_DIR` and selects file storage
for the suite, so mocked transport cannot consume the real ledgers. Direct
`node --test` invocations must provide the same isolation explicitly.

```bash
npm test            # offline provider and workflow regressions
npm run typecheck   # server, shared code, scripts, and the page
```

The tests cover identity and printing rules, comp filtering, the money math, ratings, auctions, search matching, and the search funnel. None of them call a paid API.

The [November 3 bounded search benchmark](docs/search-cost-benchmark-2026-11-03.md)
loaded 50 listings, completed three new raw assessments for $0.0140084, and used
five Browse requests plus nine PKMNPrices requests (76 reported credits).
No confirmed Deal resulted. Replaying those completed assessments used no new
provider calls. The diagnostic separates actual transports, conservative budget
reservations, token preflight and cached evidence; it does not run automatically.

The subsequent [candidate-selection follow-up](docs/candidate-selection-2026-11-03.md)
reuses canonical catalog research and orders unpriced raw prospects by delivered
asking versus one exact recent raw market. Saved-only replay recovered price
context for 42/50 rows versus 35/50, with zero new provider calls. These
comparisons order research; completed photo/pricing/cost checks still decide
Deals, including supported raw-to-CGC and raw-to-PSA opportunities.

The [listing-filter corrections](docs/listing-filter-corrections-2026-11-03.md)
preserve ordinary authenticity/holder wording, recheck raw/graded choices against
saved photo evidence and retain conflicting seller-condition clues without
turning them into grades or automatic rejections.

## Known gaps

- **PSA fees need account verification.** Public service levels were checked against PSA's October 30 schedule, including available Standard and the current Express fee. PSA remains unverified against your invoice/account. Your recorded 13.6% eBay fee, shipping assumptions, purchase tax and CGC schedule remain configurable in [`shared/money/config.ts`](shared/money/config.ts).
- **Unconfirmed listing claims.** Preliminary screening uses available listing metadata, not a new photo assessment. Unstated printings/finishes stay separate research scopes; they cannot establish a uniquely applicable ceiling or exclude premium-printing upside.
- **Exact slab markets need coverage.** A readable grader/grade does not ensure matching sold prices are available. Non-English cards are excluded from the current scope.
- **Grade odds are a fixed rule:** the likely grade counts most and each grade away counts less. It isn't yet measured against real grading results.
- **Price-data accounting remains local.** Screening and final valuation share a durable 64-request allowance, with a 32-request screening sublimit. Provider headers report credit usage separately. API-key rotation and independent replicas need a shared account authority; the configured key's local ledger cannot enforce a global provider quota.
- **Workflow quality remains unproven.** One controlled full-flow search measured bounded costs and successful cache reuse, but found no Deal and retained two printing reviews. Raw priority, broader accuracy/positive-deal validation, deferred early-completion and photo/language warning reports remain later work. Reduced request bounds alone do not establish better deal detection.
- **Manual pricing retry admission is disconnected.** The compatibility endpoint and ticket UI remain, but the bounded price-first path does not issue new retry tickets. Reconnecting a bounded explicit retry or retiring the compatibility surface needs a separate decision; it is not automatic pricing recovery.

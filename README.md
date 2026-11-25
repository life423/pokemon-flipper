# Pokémon Flipper

Find and compare exact eBay Pokémon card listings using sold evidence, photo
findings and after-cost purchase limits.

Search for a card or evaluate an eBay listing link. **Deals** requires supported
positive net profit, even with profit and ROI set to Any. **Best current buy**
compares the full purchase cost of checked listings with recent sales for each
exact printing, raw condition or slab grade. The largest percentage saving
appears alongside its projected resale profit or loss. A search can finish
without a qualifying purchase.

Start with the [current plan and supplied resources](LOCAL_PLAN.md),
[active checklist](LOCAL_TODO.md) and [workflow/code map](docs/architecture.md).

## November 25 local progress

The latest checkpoint adds condition-specific TCGplayer raw resale estimates,
rolling 60-day sales activity without a hard three-sale purchase veto, bounded
recovery from temporary review failures, and discovery continuation in batches
of 50. Active asks and completed sales have separate provenance. The AI assesses
the raw copy's condition before the app selects its matching condition price.
The local reliability pass now binds buying advice to its verified exit route,
preserves conservative lower-condition resale floors and fixes continued-batch
ownership and quota recovery. Isolated browser checks cover automatic listing 51,
refresh and holds using real admission validators. Broad hunts can also scan
unseeded inventory, though live coverage and deal quality remain in the
[active checklist](LOCAL_TODO.md). A new live profitable deal has not been
demonstrated by this checkpoint.

The buying guide now lets the AI choose from the app's research functions for a
collector or reseller goal. It can search a liquid card market, inspect a copy's
original photos, verify listing terms, fetch matching sales, compare additional
price sources and calculate a resale or grading route. Independent checks on
different listings can run together. Code validates the evidence and calculates
the purchase ceiling. The result opens the relevant listing and evidence in the
inspector, with the choices recorded under **Research steps**.

- After two unsuccessful markets, the planner can choose another printing or a
  different card within the buyer's set, era and finish preferences. Recent
  matching sales guide that choice.
- Auction hunts support collectors buying below market and resellers seeking
  positive profit after costs. Candidates must be live with strictly less than
  ten hours remaining. Alerts retain the original bid limit for outcome tracking.
- A fresh raw-card grading hunt searches listings from the last 24 hours. For a
  full batch of 50 eligible copies, it reviews the 15 selected candidates before
  choosing a recommendation. A grading purchase needs front and back evidence,
  matching sales at the likely grade and a profitable comparison one grade lower.
- Collector-number discovery now broadens empty raw Buy It Now market searches
  at the same item-price ceiling. A separate artwork comparison checks these
  leads against an independent catalog before the hunt can recommend them.

The live number-search trial found an older Leafeon V missed by the full-name
query, but its photograph showed a different numbered artwork from the target.
The new comparison rejected it. That trial established no eligible target
purchase. Live Buy It Now profitability remains an open validation milestone.

The roadmap retains the [original twenty strategies](LOCAL_PLAN.md#twenty-deal-finding-ideas-to-test),
all [fifteen supplied eBay tactics](LOCAL_PLAN.md#fifteen-ebay-tactics-for-the-deal-planner)
and the collector feature ideas.
The [checklist](LOCAL_TODO.md) records their implementation and validation work.
Auction sniper development and the planned PriceCharting importer are on hold.

## Search workflow

Describe a card or buying goal in ordinary language, such as “find me a liquid
holographic card from the years 1999–2003 to flip” or “holo card no newer than
2020.” The latter includes 2020 and earlier. The app shows the interpreted
criteria. An explicit liquidity request prioritizes recent matched activity;
zero observed matching sales keeps a profitable estimate at Wait, and small
samples retain low confidence rather than a promised resale date.

While a hunt runs, its progress panel shows the current market or evidence
check and observed listing, pricing and review counts. It includes elapsed time
and Stop. These are actual observations, not a percentage of the marketplace;
purchase advice still requires the completed evidence checks. Stopping prevents
further dispatch while already accepted responses finish saving for reuse.

1. Send the submitted search text to OpenAI for a structured interpretation.
   Show the interpreted criteria, then route its refined query into card/set
   discovery or a market hunt. Preserve card, set, number, years, finish,
   edition, grader, grade, listing format and explicit purchase targets.
2. Fetch up to 200 listing summaries per discovery pass. Apply known mismatches,
   listing-format, price and auction-window rules; deduplicate listing IDs.
3. Gather exact recent sold evidence through PKMNPrices and the shared cache.
   Screen prices before buying photos. One eligible sale can support sparse
   research with low confidence. Unresolved evidence is not a zero price.
4. Select at most 50 retained rows per review batch. Broad searches advance
   distinct provisional markets and both raw and slab copies, then defer the
   remainder instead of screening hundreds before the first photo review.
   Exact-card searches can compare later copies on the fetched page.
   Continue saved overflow and later source pages
   under the original account and constraints. A thin newest-first BIN search can
   add one lower-price pass under the same allowances. Local result sorting is
   separate from marketplace discovery order.
5. With automatic assessment enabled, the app reviews every retained listing.
   For a batch with more than 15 eligible listings the AI picks the first 15,
   with rule-based priority when the ranking service is unavailable. Six reviews
   can run at once. Each card gives a buyer decision and its reason. Progress
   reports completed decisions and counts priority listings with photo evidence.
   Reuse accepted photo findings. Check only decision-relevant images, with
   bounded text or focused follow-ups when useful. Slab labels establish the
   certified grade; raw condition is assessed independently from seller claims.
   For an uncertain ordinary English Base Set printing, the app can recheck the
   right and bottom artwork edges and the stamp area on the original front photo.
   Conflicting evidence stays out of the resale calculation.
6. Calculate supported resale routes, costs, profit, ROI and purchase limits
   in code. Preserve unresolved, rejected and never-reached reasons separately
   from finished assessments and Deals.

The normal queue allows six assessments in flight, and independent grade-market
lookups can overlap. Queued cards and active checks have distinct status labels.
Completed decisions surface above pending cards in the default ordering.
Fifty retained rows do not
promise fifty paid assessments. Current searches are English-only; unknown
language remains preliminary until identified.

| Resale route | Required evidence |
| --- | --- |
| Sell raw as-is | Assessed live condition and exact condition/printing TCGplayer valuation or supported condition-matched sold evidence |
| Buy raw and grade | Supported raw grade estimate and exact PSA/CGC sales around it |
| Resell an existing slab | Exact card, printing, finish, grading company and certified grade |

First Edition, Shadowless and Unlimited are different markets. Holo, reverse
holo and non-holo are different finishes. A query or seller claim is not verified
physical identity. Unknown shipping is different from confirmed free shipping.

### Collector-number discovery

When a raw Buy It Now market search yields no eligible new copy, the deal hunt
tries the full printed fraction, such as `167/203`, and the set plus number,
such as `Evolving Skies 167`. Each query keeps the same item-price ceiling,
format and card-type constraints. The fresh-grading hunt also keeps its
24-hour listing window. A catalog record containing only a numerator uses the
set-plus-number query. Listings found more than once are counted once.

Seller wording supplies a lead for the photo check. The hunt verifies the
photographed name, number, language, finish and applicable printing evidence,
then compares the illustration with an exact English TCGdex catalog reference.
A copy with different artwork cannot use the target card's sale prices.
**Research steps** reports the queries, the eligible copies they added and the
result of the check. The buyer's final purchase limit still includes shipping,
estimated tax and the costs of the chosen resale route.

### How the app handles a thin price market

PKMNPrices supplies matching sold transactions and TCGplayer condition offers.
For raw resale, the app can use the lowest matching delivered asking price,
capped by the exact condition market value when available, or a labeled
condition market fallback. Asking prices never count as sold volume.
For a photo-identified Buy It Now listing with a confirmed shipping quote, the app
can check Pokémon Price Tracker for a product and grade summary. It can also run
a single OpenAI web search for the exact raw condition or certified grade.
Listing analysis shows dated findings with their sources and separates asking
prices from reported sales. Searches reuse cached evidence and the original
spending allowance. A photo-checked raw sale can price other listings with the
same card, printing, finish and assessed condition. Saved comparisons can still
explain a Skip when the current listing quote cannot be refreshed. If the
available evidence cannot justify buying or passing, the app recommends
waiting and gives the reason.

### Watch for grading opportunities

The buyer spotted a newly listed raw Shadowless Alakazam and judged it **Mint**
from the photos. The seller described it as Near Mint. The incorrect First
Edition item detail played no part in the purchase. [Original listing](https://www.ebay.com/itm/227548256279).

After a named Buy It Now search that includes raw cards, select **Watch for
grading opportunities** and keep Results open. During the 30-minute session,
the app can check for new listings twice, at 10-minute intervals, using the
search’s remaining allowance. It considers listings posted in the last 24 hours
and reuses earlier checks when the same copy appears again.

An alert shows the delivered price, grading and submission costs, and estimated
profit after selling costs at two grades. The likely grade must meet the buyer’s
targets with supported matching sales, with observed 60-day activity shown
separately. One grade lower
must still yield a profit and have at least one matching sale. The assessment
uses front and back photos, so a seller’s Near Mint description leaves room for
the AI to recognize a cleaner copy. An expired quote can be rechecked from Results.

## Interface

- Compact comparison rows put asking price, after-cost profit/loss and purchase
  limit together. Evidence and detailed costs expand when needed.
- A desktop split inspector keeps search results visible while reviewing a card.
  Smaller screens use an accessible modal with scrollable original photos.
- Green marks the Find deals action and supported profit. Purple marks listing
  evaluation. Lavender marks selection and keyboard focus. Amber flags evidence to check, and dark neutral
  surfaces support the hierarchy. Grading labels remain neutral; losses use red.
- Search controls preserve format, raw/graded choice, marketplace order and
  targets. Target changes reprice retained evidence without repeating photos.
- Choose **Find a flip** on the search screen to hunt for a profitable card across sets without entering a name. The fixed-price resale hunt searches active eBay listings newest first. Older active copies are eligible. It screens across printings, reserves some photo checks for incomplete listings, and verifies the actual copy against its price evidence. Scoped searches retain the requested card and filters. A resale Buy requires supported positive profit after costs and the buyer's targets. Observed sales in the last 60 days are shown separately from asking-price estimates, without a hard transaction-count veto.
- For a named search, try `2000 Team Rocket Dark Alakazam 1/82 holo`, choose **Buy It Now**, and click **Find deals**. When the search finishes, select **Other cards in the same set** and click **Run deal hunt**. Open **Research steps** to see which alternatives it checked. A resale hunt can try a third or fourth market after empty searches while reserving enough checks to verify a copy.
- After a Buy It Now search finishes, choose a buying goal under **Deal hunt**
  and select **Run deal hunt**. The guide can look for a raw card worth grading,
  a fairly priced slab for a collection or a profitable resale. It picks listings
  within the chosen search scope, reuses saved evidence, and can spend the search's
  remaining allowance to investigate a screened copy. Expand **Research steps**
  to see which checks it chose. A decision about a specific copy opens its
  supporting photos, price comparisons or grading breakdown beside the results.
- Best Offer drafts are conditional, with openings at most 15% below asking.
  Unaccepted offers are separate from Deals.
- To hunt across auctions, type `Find vintage holos from 1999–2003 I can flip for at least $25.` into the search bar. The AI chooses markets with recent sales and decides which listings, photos, sale comparisons or grading costs to check. **Research steps** shows its choices.
- After two misses, the AI compares the remaining eligible markets and explains why it chose the next one. Expand **Research steps** to see that reason and whether the app reused it. On an identified copy without an exact sale price, the hunt can check additional price sources and show a dated reference alongside its decision.
- **Auction opportunities** shows open auctions with strictly less than 10 hours left and a current price below matching sales. Each bid recommendation gives a maximum item bid, the next bid with shipping and estimated tax, and projected resale profit after costs if you win at that next bid. You place the bid on eBay.
- Open **Tracked auction outcomes** in auction Results to see whether an alerted copy sold within its original bid limit. While the local server runs, it refreshes bids near closing and looks for a completed sale for that exact eBay item. Only confirmed sales count toward the displayed result.
- **Competing auctions** compares matching certified slabs ending within 15
  minutes of each other. Each row shows its next bid with shipping and tax and
  the highest item bid supported by that copy's resale economics.
- **Clean-front binder copy** shows where back wear appears and how much it
  saves against a cleaner copy of the same printing. **Same artwork for less**
  offers an optional search for a verified release with the same illustration
  and compares like condition or slab grade.
- In listing analysis, **Compare Cardmarket asking prices** checks PKMNPrices
  for matching offers. Enter your own fees and fulfillment costs to compare a
  hypothetical sale with the eBay purchase total. **Compare with your sales on
  another marketplace** reuses settled US-dollar sales you recorded for the same
  slab in this browser. Both comparisons show the source of the resale figure.
- Shortlist notes and ceilings persist locally. Targeted refresh checks current
  terms independently from accepted photo assessments. For an assessed raw card
  missing its back, use **Check for a new back photo** or enable the 15-minute
  watch while the shortlist is visible. The app checks added photos against the
  saved front, shows the new evidence and compares the verdicts. Changing the
  original photos or identity details requires a fresh assessment.

## Grade a card

Open [Grade a card](http://localhost:3017/?view=camera). Photograph the entire
front and back of one card in even light, or choose pictures from your device.
For a holo card, add a tilted front if reflections hide the surface. Check the
previews, then choose **Estimate grade** to send the photos for assessment.

The result shows one estimated grade, play condition, confidence and the wear
visible in the photos. If an area needed to grade the card is hidden, the app
identifies the view to retake. For a slab it reads the grade on the label.

This installation runs on the Mac. Its camera picker can use a connected
webcam or an eligible iPhone through Apple's Continuity Camera. You can also
transfer phone photos to the Mac and use **Choose photo**.
[Apple's Continuity Camera setup](https://support.apple.com/en-us/102546)

## Auction sniper

Further sniper development and live automatic-bidding setup are on hold while
deal discovery is the priority. Existing reminders remain available.

Choose **Auction sniper** on an eligible auction card in results, your shortlist
or a listing evaluation. The planner opens over the card and checks the next
bid, end time and shipping. It prefills an assessed ceiling when the current
terms support it. Enter your maximum and choose **Set reminder**. Reopening the
same card lets you see or cancel its reminder. You can also paste an eBay link
in the **Sniper** tab.

For a live auction, schedule a reminder and place your bid on eBay. The alert
appears on any screen in the open app. Keep the local server running and the
computer awake. The queue survives a restart and
rechecks the auction when it comes due. You can cancel a scheduled action.

### Sign in with eBay

Open the [Sniper tab](http://localhost:3017/?view=sniper). When sign-in is
available, choose **Sign in with eBay** and approve account linking on eBay.
You can disconnect from the same tab. Reminders also work while signed out.
For live auctions, the buyer places the bid on eBay.

### Operator setup for buyer sign-in

The local pilot uses [the registered HTTPS return page](https://drewclark.io/ebay-return.html)
for both accepted and declined Production sign-ins. It returns the browser to
`http://localhost:3017` on the same computer. The operator keeps eBay’s
generated redirect name in the private `.env`. Each buyer uses eBay's
consent screen. For a hosted service, buyer authorizations and auction jobs
must be isolated by customer before enabling automatic bids.

1. In [eBay Application Keys](https://developer.ebay.com/my/keys), open the
   **User Tokens** link for the app and environment. In the application sign-in
   settings, select or add an OAuth-enabled **eBay Redirect URL name (RuName)**.
2. For the standard localhost installation, host [ebay-return.html](client/public/ebay-return.html)
   on an HTTPS site you control. Set both the **Auth Accepted URL** and **Auth
   Declined URL** to that file's HTTPS URL. Serve it without analytics and disable
   query-string logging for this path. It returns the browser to
   `http://localhost:3017` on the same computer. Start the connection on that
   exact origin. An installation on another port must update that address in
   its copy of the return page.
3. Put the generated name in `EBAY_RUNAME` in the app's private `.env`
   alongside the Production keys. Restart the app. Sandbox uses a separate
   redirect name, key pair and test buyer. Production requests read-only account
   identity (`commerce.identity.readonly`). Sandbox requests permission to test
   auction bids (`buy.offer.auction`).

Disconnect a buyer from the Sniper tab to remove local authorization and request
revocation from eBay. If eBay is unreachable, the app directs you to your
eBay account permissions to finish revocation. See [eBay's authorization guide](https://developer.ebay.com/develop/guides/sell/authorization).

Sandbox authorization and timed test bids are available through the local
operator API. The scheduler rechecks the terms before sending a test maximum
and records an uncertain submission for inspection. Live automatic bidding
requires eBay approval for the application and the buyer’s bidding permission.
[eBay Offer API](https://developer.ebay.com/api-docs/buy/offer/static/overview.html)

## Run locally

Use Node.js 22 or later. From this repository:

```sh
npm install
npm run dev
```

Create a private `.env` containing the necessary provider credentials. Never add
it or provider responses to Git. The server reads it on startup.

| Variable | Purpose |
| --- | --- |
| EBAY_CLIENT_ID | Production Browse app ID |
| EBAY_CLIENT_SECRET | Matching Production cert ID |
| EBAY_RUNAME | eBay-generated Production redirect name for buyer sign-in |
| EBAY_SANDBOX_CLIENT_ID, EBAY_SANDBOX_CLIENT_SECRET | Sandbox app key pair for buyer sign-in and auction details |
| EBAY_SANDBOX_RUNAME | eBay-generated Sandbox redirect name for the same Sandbox keyset |
| OPENAI_API_KEY | Input preflight and authorized AI work |
| PKMNPRICES_API_KEY | Catalog and market research |
| EBAY_SHIP_TO_ZIP | Optional fallback delivery ZIP; a destination saved in the app takes precedence |
| EBAY_SANDBOX_APP_ACCESS_TOKEN | Optional Sandbox application access token for auction details |
| EBAY_SANDBOX_USER_ACCESS_TOKEN | Optional Sandbox buyer access token with the `buy.offer.auction` scope |
| OPENAI_MODEL | Legacy text/vision default override |
| OPENAI_BOUNDED_VISION_MODEL | Bounded photo model override |
| POKEMON_PRICE_TRACKER_API_KEY | Release-year catalog and supplemental product/grade sale statistics |
| PORT | Primary app port. The default of 3017 also serves the app on 3018. A custom primary port runs one listener. |

Open [localhost:3017](http://localhost:3017/) or [localhost:3018](http://localhost:3018/).
Both addresses use the same running app, Azure SQL connection pool and auction
scheduler. Searches, saved assessments and the shortlist use the same server
storage. Browser preferences are specific to each address. eBay sign-in returns
to localhost:3017. If 3018 is occupied, use 3017.

These ports provide local web access. Direct Azure SQL clients continue to use
the configured database server and its SQL connection port.
Port 3000 belongs to another local app. Restart after changing credentials.
Fresh installations start with paid processing paused; starting the server does
not authorize spending.

Money settings, service tiers and verification flags live in
[shared/money/config.ts](shared/money/config.ts). Use actual account terms.
The [money guide](docs/money-calculations.md) explains formulas and rounding;
[financial sources](docs/financial-sources.md) locates primary references.

## Usage, limits and reuse

Useful provider calls are authorized. eBay requests and PKMNPrices credits are
daily quota resources under the user's subscriptions, separate from AI dollars.
The current PKMNPrices subscription supplies 20,000 daily credits. A request and
a returned row are different units; use the provider's reported credit headers.

This installation has no per-search Browse or PKMNPrices request ceiling.
Historical limits, attempts and unresolved usage remain recorded across retries,
nested work and restarts. All production Browse calls protect the last 10% of
the daily allowance. Provider pacing, cancellation and bounded page walks still
apply. Cached reads consume no new request; accepted photo evidence is reused.

Set **Ship to ZIP code** in search options or Settings for calculated delivery
quotes. Only a US ZIP is needed, not a full address. The app stores it locally
and keeps each quote tied to its destination. Saving a different destination
clears current browser results; explicitly rerun the search to obtain new terms
while reusing saved photo research. Searches without a ZIP remain available,
but unquoted shipping cannot support a firm purchase recommendation.

The local operator can configure an AI ceiling or run uncapped. This installation
is authorized to run uncapped while retaining preflight, bounded output,
cancellation, durable reservations, actual usage and unresolved-charge holds.
Search analysis and automatic diagnostic reviews have distinct usage accounts.
Use cheap text and selective photo review where they improve a decision, rather
than duplicating every stage across models.

The usage panel distinguishes search requests, last-observed provider daily
balances, credits, settled AI cost and unresolved holds. Rapid daily depletion
and low remaining usage generate warnings without provider polling. Observed
daily balances can include other work and are not a per-search counter.

Unchanged accepted photo evidence is reused, including negative or unresolved
findings. Price, shipping and availability have separate freshness rules.
Cancellation prevents later dispatch while accepted responses can finish saving.
Corrupt storage or accounting must fail closed, rather than masquerading as a
cache miss and purchasing the same work again.

## Storage and deployment boundary

Select local files or Azure SQL using `POKEMON_FLIPPER_STORAGE=file` or
`azure-sql`. SQL errors never silently select a file cache. Passwordless local
Azure development can use:

```dotenv
POKEMON_FLIPPER_STORAGE=azure-sql
AZURE_SQL_SERVER=your-server.database.windows.net
AZURE_SQL_DATABASE=your-database
AZURE_SQL_AUTH=azure-cli
AZURE_SQL_OWNER_ID=local-owner
```

`AZURE_SQL_AUTH=default` uses the Azure Identity credential chain. Import backs up
source files and preserves evidence versions and timestamps. Keep original image
bytes outside SQL and references/fingerprints inside it.

```sh
npm run db -- import --dry-run
npm run db -- migrate
npm run db -- import
npm run db -- verify
npm run db -- status
npm run db:check
```

Shared response/assessment storage and task-claim foundations exist. Current
runtime spending/quota guards, shortlist, history and usage records still rely
on local files. Full shared transactional accounting, durable server-owned
research and authenticated user ownership remain unfinished. Do not deploy
independent replicas with separate local allowances.

Keep `data/`, credentials, paid evidence and private user settings out of Git.
Back up local state; do not clear caches or ledgers as code cleanup. Use
`POKEMON_FLIPPER_DATA_DIR` for isolated diagnostics.

## Development and validation

| Command | Purpose |
| --- | --- |
| npm run dev | Development server |
| npm run build | Production client build |
| npm start | Serve the production build |
| npm test | Offline tests using isolated file storage |
| npm run typecheck | Server, shared, script and client types |
| npm run evaluate -- &lt;eBay link&gt; | Explicit one-listing evaluation; can use providers |
| npx tsx scripts/bounded-search-benchmark.ts --help | Current benchmark and strict replay options |

Run `npm test`, `npm run typecheck`, `npm run build` and `git diff --check` for
changes. Direct test invocations need equivalent temporary storage isolation.
The [validation guide](docs/validation.md) describes immutable saved-input
replays, duplicate-charge checks, browser verification and separately measured
live runs.

Completed browser searches save listing decisions and can run a short automatic
text review. Private packets under `data/search-diagnostics/` help identify
specific blockers. Verify their claims against saved listing evidence and code;
a review is a proposal, not authority to relax identity or invent resale prices.

The [Deal blocker audit](docs/deal-blockers-audit.md) lists the current rules
that can exclude, hold, reject or hide a card, and the reproduced integration
defects that still prevent some economically profitable candidates from qualifying.

The [audit guide](docs/deal-search-audit.md) distinguishes existing behavior,
reproduced defects, proposed repairs, offline fixtures and live-market evidence.
A test count or a synthetic profitable card does not prove live deal discovery.
The real supported profitable BIN milestone and Best current buy live validation
are still open; remaining work is in [LOCAL_TODO.md](LOCAL_TODO.md).

## Code map

- `server/deals/`: discovery, price-first screening and admission.
- `server/search/` and `server/identity/`: intent, catalog and physical identity.
- `server/analysis/` and `server/ai/`: versioned photo work and saved results.
- `server/pricing/`, `server/ebay/`: guarded data-provider access.
- `shared/money/`: deterministic financial calculations.
- `client/src/App.tsx`: request, queue and cancellation coordination.
- `client/src/search/`: settings, controls and result selectors.
- `client/src/components/`: comparison, detail and evidence views.
- `scripts/` and `test/`: diagnostics and behavior checks.

The app uses TypeScript, React, Vite, Express and tsx. Follow one listing through
the [architecture reading order](docs/architecture.md) before extracting code or
adding another workflow.

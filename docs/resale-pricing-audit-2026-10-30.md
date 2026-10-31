# Resale pricing, shipping and activity audit — October 30, 2026

Developed on `codex/deal-screening-audit` from `d7fd26f`. The user requested
accurate recent eBay resale evidence, shipping fixes, trading activity and a
real investigation of zero Deals. This checkpoint is uncommitted; no merge or
push was requested for this pass. The pre-existing `.env.example` deletion is
unrelated and was left untouched.

## Findings and changes

The primary raw feed was TCGplayer market data, not eBay sold data. The API keeps
these sources separate. Raw resale now prefers a 90-day eBay median with at
least three matching-condition sales; printing, finish, exact attribution,
currency, dates, single-card status and grading claims are checked. Condition
must be explicit and unambiguous; an absent condition is never NM. Numeric HP
means hit points, not heavily played. Production raw comps also receive the
existing AI identity check; missing verdicts do not become verified evidence.
Unconfirmed legacy sale amounts, lots and slabs cannot establish a raw estimate.
Outliers are filtered. Sparse evidence retains the marked TCGplayer fallback;
values can move up or down. Each used price and the comparable-sale links are
visible. Non-positive/non-finite market-feed entries are unavailable prices.

Graded estimates previously accepted multi-currency rows as dollars. The API
adapter now keeps USD only, with a second currency guard in comp validation.
Comp finishes must also match. When at least three matching recent sales remain,
graded pricing prefers 90 days; otherwise it explicitly uses up to 180 days.
Comp windows are selected by evidence count, never by which price creates a
profit. Corrected title/grade/printing metadata invalidates the cached AI verdict.
Equivalent concurrent checks share work while returning verdicts against each
caller's own sale objects.

The $7 unknown inbound-shipping assumption could reject a listing before looking
up its real quote. A zero-shipping optimistic bound now decides whether a quote
could change eligibility. It only authorizes a fresh, reserve-respecting detail
lookup; it never supplies free shipping to underwriting. The returned summary
retains the resolved quote. Known search quotes still win over cached details.
Destination-specific caches prevent reuse across ZIP changes. The user's `.env`
currently has no configured delivery ZIP; calculated quotes can therefore remain
unknown. No ZIP was invented. A delivery-ZIP question remains unanswered.

One real Yanma quote resolved to $1.36 and is propagated through its result; its
$19.49 asking price still exceeds the $6 raw buy limit after seller specifics.
Other sellers still returned no quote, which stays visibly assumed at $7.
The Politoed title containing Pokédex #186 previously produced the wrong collector
number. A failed identification without a provider outage now requests seller
specifics; this example resolves to #8/75. The Entei promo with contradictory
Neo Discovery specifics remains unresolved instead of being assigned a guess.

PSA Standard's cap was disabled, forcing $79.99 grading when its available $59.99
service would cover values through $1000. Standard is enabled; Priority, Express,
Super Express and Premier use the current inclusive caps and fees, including
$199 Express. Value is paused, so it was not enabled. The service must cover the
highest modeled resale outcome, preserving nonmonotonic-grade safeguards. PSA
remains unverified against the user's own invoice. CGC fees and the transaction-
based 13.6% eBay rate were retained. Reducing that rate to public 13.25% changes
the sampled Espeon profit by about $1.10, not enough to explain losses above $100.
Even zero selling fees leave nine of ten earlier full assessments unprofitable.

Full assessments now fetch recorded eBay sales volume for the exact printing and
raw/graded scope: 30-day count, active days, daily average and newest observation.
Raw conditions or slab grades are combined and visibly labeled. These are
observed comps, not total market volume, an exact-grade liquidity measure,
sell-through or a promised sale time. Volume prices are not used to value a
condition-specific copy. A plan-gated volume endpoint is briefly negatively cached
and cannot trigger a global price-service cooldown. Missing volume leaves working
pricing intact.

Saved shortlist financial advice must match the current pricing version and be
less than six hours old. Legacy or expired valuations are not silently reused;
opening them refreshes prices, preserving valid photo/condition work. Active
results remain the current search's snapshot. No photo prompt/model change or
wholesale cache purge was made.

## API limits and evidence

- Raw sold evidence: maximum 40 returned sales per printing, two bounded pages;
  dated 90 days, cached six hours and shared across listings/conditions.
- Graded evidence: one bounded 20-sale page per grader/grade/source label;
  requested within 180 days and cached six hours. Auditing 385 used graded queries
  found no capped page with fewer than three USD rows requiring further paging.
- Volume: one 30-row page per printing/raw-or-graded scope, cached six hours.
  An incomplete page is labeled a lower bound, never an exhaustive total.
- Existing global pacing, provider cooldowns, automatic recovery, eBay reserve,
  full-analysis budget, identity checks and cancellation remain enforced.
- Real paid API calls ran with user authorization. Dollar billing was not
  independently reconciled, so no exact dollar-spend claim is made.

Real marketplace/UI test mutations used isolated caches and saved assessments
under `data/reviews/deal-audit-2026-10-30/isolated-data` on port 3001; the user's
shortlist was preserved. Unit adapters use uniquely named offline cache keys.
A development warmup was interrupted by an in-progress frontend
edit/reload; it is not counted as successful end-to-end validation. Its API/cache
work was reused in the clean production-build test, without forcing repeated
photo assessments.

## Final validation

- 381 tests pass; application typechecks/build and strict compilation of the
  seven new typed test files pass. `git diff --check` is clean.
- One real default-400 `neo discovery holo` search: 43,284 advertised eBay
  matches, 385 retained marketplace rows, 316 primary screens, 32 automatic
  discovery photo checks and 317 unique streamed listings. The retained matching
  result set is 157. This does not analyze all 43,284 market listings.
- All 18 eligible automatic full assessments complete successfully; 126 results
  remain screened only. No test-specific five-analysis cap was imposed.
- Any/Any: Deals **0**, Waiting **0**, Review **15**, Long shots **8**, All **157**.
  Default $50/25%: Deals **0**, Waiting **0**, Review **15**, Long shots **1**,
  All **157**. Target changes did not start another marketplace search.
- One real temporary pricing failure recovered automatically: one ticket checked,
  one priced, zero pending. There were no temporary failures left in Waiting.
  Thirteen unresolved screens reflect identity/grade/sales-coverage gaps; two
  full assessments cannot support a condition/grade price. Review is not cleared
  by inventing a grade, currency conversion or favorable sale estimate.
- A Smeargle auction has modeled $7.75 profit at its current $16 bid; its expected
  auction outcome remains a Long shot, so it is not counted as a confirmed Deal.
- Unown A LP uses four matched sales with a $15.49 median, versus the earlier
  $14.38 market fallback. Its $13 price plus $1.36 incoming shipping, purchase tax,
  selling fees and outgoing shipping still imply an $8.73 loss. Volume records 25
  raw sales across conditions on 19 active days over 30 days.
- Production UI: 22 browser checks, including eight zero-violation axe scans;
  results at 320/390/768/1440 pixels, analysis at 320/390/844/1440, landscape,
  200% text, keyboard access, reduced motion, scroll cleanup and no page errors.
  Phone, tablet and desktop screenshots were inspected.
- Three supplementary real listing-link checks verify current pricing markers,
  zero repeated photo/condition calls for unchanged evidence, touch disclosure of
  the four actual raw sale links, 44px targets, modal keyboard focus and Escape.
  The test initially attempted to open an already-open modal; correcting the test
  selector passed without an application change.
- Main shortlist SHA-256 remains
  `A10AC88C9F78630EBC7F569F289BB6823ACECC6D8E99F32A758303DF07A734B5`.

The final search completed in about 164 seconds with warmed price/photo caches;
first results appeared in 351ms. Cold warmup required substantially more provider
calls and is not represented by the warm timing. No physical-phone, universal
valuation-accuracy or Core Web Vitals certification is claimed.

## Design critique

Internal review heuristics, not measured quality scores: usability 8.5,
hierarchy 8.5, accessibility 9, consistency 9, responsiveness 9, feedback 9,
performance 8. Priorities for remaining sub-9 areas:

1. Provide a clear delivery-ZIP setup path; quotes remain incomplete without one.
2. Put the financial decision before lengthy photo-caution material in the detail
   panel. Current pricing is readable and reachable, but below several disclosures.
3. Profile cold-screening requests before further expansion. Preserve freshness
   and evidence checks; consider an explicit raw-only workflow to avoid irrelevant
   grading lookups when the user only wants raw resale.

## Primary references

- [PkmnPrices eBay sales](https://www.pkmnprices.com/docs/ebay-listings): per-row
  currency, attribution, actual accepted-offer amounts, corrections and pagination.
- [PkmnPrices history and volume](https://www.pkmnprices.com/docs/price-history):
  history is TCGplayer/Cardmarket aggregates; volume counts recorded eBay comps.
- [PkmnPrices coverage](https://www.pkmnprices.com/docs/data-coverage): raw market
  prices and individual eBay sales are separate sources.
- [PSA published service levels](https://www.psacard.com/services/tradingcardgrading).
- [CGC grading fees](https://www.cgccards.com/submit/services-fees/cgc-grading/).
- [eBay selling fees](https://www.ebay.com/help/selling/fees-credits-invoices/selling-fees?id=4822).
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs),
  consulted through the OpenAI Docs skill for the bounded raw-comp checker change.

Full logs, captured source/evaluations and screenshots are local ignored review
artifacts in `data/reviews/deal-audit-2026-10-30/`.

The normal app was restarted on port 3000 with the tested production build
`index-Da2iir0e.js`; the home page returns 200 and the original three-entry
shortlist loads with the unchanged hash above. The isolated port-3001 server
was stopped. The user's existing `tsx watch` parent was left alone.

# Sold-price-first screening — November 3, 2026

Bounded searches now research recent matching eBay sold records through
PKMNPrices before emitting candidates to the browser's automatic AI queue.
This completes the first step of the agreed workflow improvement. It does not
rewrite the full raw/slab assessment paths or establish a long-term market
history database.

## Flow and boundaries

1. Fetch one search page; exclude known wrong cards, reprints, languages, junk,
   selected price/type exclusions and auctions outside the search-start
   twelve-hour window before admitting up to fifty matching metadata rows.
2. `server/deals/price-first.ts` creates one shared sold-research session and
   processes at most four candidates concurrently. The session reuses canonical
   catalog and market requests across listings before any candidate is emitted.
3. `server/pricing/screening-sales.ts` keeps exact grader, grade, printing,
   finish and raw sold-condition scopes separate. Explicitly foreign sold
   titles and contradictions between sold-title grades and provider grade
   fields cannot price an English slab. Actual USD amounts must have confirmed
   sale types and matching attribution; missing prices never become zero.
4. `shared/money/sold-screen.ts` applies existing rounded costs and targets to
   retained public references. Medians rank candidates. A single exact slab
   scope with at least three eligible sales in ninety days can be excluded
   using its upper observed sold value. Unknown shipping uses an explicitly
   optimistic zero only for preliminary screening. Supported optional offers
   remain within ten percent of asking.
5. Raw sold-condition buckets provide priority context without assigning the
   live card a condition or grade. They cannot reject unknown grading upside.
   Unspecified-condition sales never become a condition-matched raw quote,
   purchase ceiling or profit estimate. Sparse/missing evidence remains in
   Sorting; it is not a manual identification task. The existing cheap First
   Edition Base Set investigation exception is preserved.

Preliminary references never create a final Deal. Identity, label and condition
checks still precede final valuation. The UI labels the evidence and shows
separate source summaries. Completed assessments replace that preliminary block.
Local target changes reuse retained references and do not fetch prices again.

## Waste and failure handling

- A price session allows eight new PKMNPrices transports, including catalog
  requests, with no automatic retry and one page of up to twenty sold records
  per requested source market. Credits are charged by the provider's returned
  data, so this request limit is not a credit or monetary allowance.
- The source reuses the configured SQL/file caches and their original timestamps
  and expiry rules. Cached reads can continue after new-request exhaustion.
  Concurrent subscribers share responses without one stopped search cancelling
  another live consumer. Accepted responses still save after Stop.
- Completed portions of a market survive provider/budget interruption as partial
  context. An incomplete scope cannot justify exclusion. Missing/failed pages
  are memoized within the session rather than repeatedly purchased per listing.
- Stop cancels queued research and prevents emission into later paid stages.
  A fatal storage error aborts sibling/queued batch work before releasing the
  failed worker's slot. Storage failures never authorize replacement research.
- This stage makes no OpenAI or eBay requests. Subsequent assessment keeps the
  durable two-cent AI budget and twenty-five Browse requests per search, plus
  the independent account-wide daily protection. No model or limit changed.

## Verification and limits

All 801 offline tests, both TypeScript projects, the production build and
whitespace checks pass. New regressions cover shared fifty-row research, deferred
emission, metadata exclusions, missing/partial markets, exact slab exclusions,
raw grading-upside preservation, target changes, cancellation/fatal failure,
new-inventory scans, cache/transport bounds and preliminary UI rendering.

A read-only replay against the real Azure SQL cache prohibited provider
transports and set the price source's new-request limit to zero. Existing raw
Charizard sales loaded as separate sparse condition buckets and unspecified
context; the missing PSA 5 source page stayed deferred. The replay made zero
new OpenAI, eBay or PKMNPrices requests. Its private report is retained under
ignored `data/financial-audit/2026-11-03/price-first-saved-sql-replay.json`.
The running localhost3017 storage check reports Azure SQL ready.

These checks do not establish full live-search deal quality, complete market
coverage or cost per useful deal. Fifty matching metadata rows do not mean fifty
paid assessments or profitable cards. A full useful-search benchmark follows
the next assessment-path work. False photo/language warnings and the user's
positive newly listed example remain explicitly deferred. Dedicated long-term
sold observations and their migration are also future work.

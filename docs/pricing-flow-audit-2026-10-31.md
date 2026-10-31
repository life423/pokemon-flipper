# Pricing and analysis flow audit - October 31, 2026

Developed on `codex/deal-screening-audit`; the user authorized committing,
merging into `main` and pushing on October 31. Consult Git for delivery status.
This report supersedes the
October 30 description where behavior differs. Normal local port: **3017**.
Port 3000 belongs to another application and must not be stopped.

## What happens to a listing

1. **Understand the search.** Interpret the card/set, finish and existing slab
   grade constraints. Obtain matching live eBay results. Known unrelated sets,
   languages, products, grades, lots and unavailable items stay excluded.
2. **Build a preliminary estimate.** Read the title with AI, fill omitted item
   fields, find the exact catalog printing/finish, and read price evidence. Raw
   seller condition and a fixed optimistic grade table are preliminary guesses.
   Screening already uses paid title, comp and sometimes main-photo checks; old
   comments calling it a completely free/no-AI check are inaccurate.
3. **Prioritize AI work.** Preliminary profitability ranks the queue. It no
   longer prohibits full analysis of matching photographed listings merely
   because they look above target. Missing identity/finish/grade/price evidence,
   unusual low prices and temporary price failures can also enter the queue.
   Explicit analysis caps, Off, cancellation, account/configuration failures,
   unsupported known graders, missing photos and invalid terms still apply.
   The queue scales to eight concurrent evaluations and reduces pressure after
   failures. New-listing discovery retains its five-full-assessment limit.
4. **Establish the actual card.** Inspect up to 24 listing photos, then make up
   to two focused metadata readings when needed. Verify the slab label or assess
   a raw card twice. Save completed stages so retries do not buy them again.
   A corroborated physical identity can survive an absent catalog record;
   alternative price sources must still match it exactly.
5. **Find comparable prices.** Matched eBay sold evidence is primary. Match card,
   printing, finish, language, currency and either raw condition or exact grader
   and grade. Fetch up to forty rows using two bounded pages. Graded valuation
   prefers 90 days with three matches, otherwise the labeled 180-day window.
   A graded price can currently use one accepted sale with low confidence; it
   does not require forty transactions. The median drives valuation; the mean,
   range, count and dates are supporting information.
6. **Recover missing evidence.** Temporary failures retry with provider pacing,
   before extra discovery work. Empty card/sold lookups expire after five
   minutes. Successful sold pages remain cached for six hours. If a verified
   slab lacks usable sold evidence, search current eBay Buy It Now competition.
   Examine at most six details and buy at most three new photo checks per lookup;
   reuse unchanged photo work. Require the exact physical card/printing/finish/
   grader/grade, readable cert, usable original front, acceptable case, no
   authenticity flag, and a seller with at least 100 feedback at 98.5% positive.
   Exclude the subject item/cert, auctions, duplicate certs, unknown shipping,
   known mismatches, signed/error variants and unavailable items. Compare item
   plus shipping. A fallback resale target is 5% below the cheapest accepted
   buyer total. Label this **current competition**, never a sold transaction.
   Current competition does not count as liquidity. Quotes have a two-minute
   application cache; photo evidence is cached separately.
7. **Calculate profit and display the result.** Use deterministic math for
   acquisition tax/shipping, eBay sale fees, outbound shipping and any grading
   service/round-trip costs. Choose a viable resale route and calculate the
   highest purchase price meeting both targets. Final verified purchases go to
   Deals; priced rejections remain in All; unfinished work is Waiting; unresolved
   identity/evidence or absent usable values go to Review. Auction long shots
   remain separate. Any/Any means approximately break-even, not free fees.

## Raw sold-copy condition

The six categories are Mint, Near Mint, Lightly Played, Moderately Played,
Heavily Played and Damaged. Mint uses PSA 9 terminology; Gem Mint 10 is separate.
Raw condition is assessed from photos rather than adopted from seller claims.
Historical ended eBay listings can expose photos through Browse. Final raw
pricing reviews up to twelve eligible sold copies per card lookup, with at most
one corroborating opinion for an otherwise usable medium-confidence wear read.
Missing views, printing conflicts and unsupported Mint claims cannot be voted
away. Three accepted same-condition sold copies are required for an eBay median;
other conditions retain a clearly marked market fallback. Tests cover grouping,
seller/AI disagreement, missing photos and paid-work limits. A real ended
Charizard supplied eight photos; its two condition readings did not establish
an accepted consensus. Do not describe that specimen as a verified condition comp.

TCGplayer fallback quotes are checked against an exact secondary market quote,
better-condition quotes and sufficiently supported equivalent slab evidence.
These checks prevent an unsupported raw premium; they do not create raw sold
evidence. PkmnPrices' market prices and eBay sold endpoints are separate feeds.

## Confirmed defects and evidence

- In the user's live Aquapolis tab, 94 of 172 results were in Review: 64 had
  never received full photo analysis, 23 had completed photos but no usable
  price, and seven had identity conflicts. None showed Analysis failed.
- An isolated 200-result Aquapolis run after the first queue correction completed
  80 automatic attempts: Deals 2, Waiting 0, Review 69, Long shots 4, All 165.
  This measurement predates the subsequent broader above-target eligibility and
  current-listing fallback. It is not a final count for those newer features.
- **False Shadowless Venusaur:** item 257827112860, PSA cert 51702940. Two AI
  readings wrongly described the artwork shadow as absent. The corroboration
  path accepted that premium despite the ordinary PSA label. Fifteen Shadowless
  PSA 8 comps produced the false $662 purchase limit. A complete ordinary PSA
  English 1999 Base Set label now prevents that upgrade, including for cached
  readings. Partial labels cannot authorize Shadowless prices.
- Re-evaluating that exact item used its saved photos, made no new AI call,
  selected Unlimited PSA 8 sold evidence with a $300 median and returned PASS.
  At $350 plus $0 shipping, modeled loss is $131.34; the $50/25% purchase limit
  is $182. The direct-link UI also showed the corrected identity and decision.
- A real competing-listing lookup found ordinary Unlimited PSA 8 copies at
  $325 delivered and $331.76 delivered ($320 item plus $11.76 shipping).
  Initial broad search also returned cheap modern reprints; their photo checks
  correctly rejected them. The query now includes the normalized collector
  number and excludes known contradictory products before paid inspection.
- "Metal Energy" was wrongly treated as a novelty metal card. Its exception
  now preserves legitimate Energy cards while actual replicas stay excluded.
- Failed browser assessments previously survived new searches and prevented
  another automatic attempt. New searches clear failures; transient evaluations
  retry once, retaining completed paid photo/condition answers.

## Validation and remaining limits

The latest complete unit run passed **428 tests**, both TypeScript projects and
the production build. Review artifacts are ignored under
`data/reviews/codebase-audit-2026-10-31/`. Real API tests use isolated data.
The normal shortlist's SHA256 remained
`A10AC88C9F78630EBC7F569F289BB6823ACECC6D8E99F32A758303DF07A734B5`.
No bids, purchases, offers or seller messages were submitted.

The corrected direct-link panel was inspected at 320/390/768/1440 CSS pixels,
with a 44px Close target and no viewport/panel horizontal overflow. A separate
controlled proxy returned one temporary 503, then the real assessment: the
browser retried exactly once and completed. A controlled missing-sold-data view
used actual observed current listings; it showed the $308.75 competing-price
target, shipping-inclusive comparison links and seller evidence on mobile,
without turning asking listings into sold volume. Keyboard focus stayed inside
the panel and closing it restored page scrolling.

A final bounded real `Venusaur Base Set PSA 8` run used 200 marketplace results,
automatic discovery and a five-full-assessment cap. All five above-target
listings received full analysis automatically and failed the selected $50/25%
targets. Discovery checked 32 photos. The finished visible groups were Deals 0,
Waiting 69, Review 0, Hidden 1, Long shots 0, All 74. The queue additionally
counted one unconfirmed candidate outside the visible matching-result filter;
do not describe this capped run as analysis of every found listing.

Earlier Aquapolis result
checks passed at 320/390/768/1440 with accessibility scans; those scans predate
the latest comparison panel. Do not claim physical-phone or universal pricing
accuracy from these checks.

The normal application and the 3018 preview were restarted with the corrected
backend. The obsolete preview search was stopped through its UI before that
update; its paid records and shortlist were retained. On Any/Any targets the
corrected Venusaur limit is $228 rather than the $182 limit at $50/25%; its
-$131.34 profit at the $350 asking price is unchanged.

Open audit items: shared/unknown sale attribution is rejected before the AI comp
checker can adjudicate it; legacy graded rows with unknown sale_type can still
enter deterministic summaries although the provider warns some may retain an
accepted offer's asking amount; no full secondary graded-price adapter exists.
Current-listing checks are a bounded sample and seller/photo signals are not an
external authentication service. These are concrete limits, not proof of no
market opportunity. Public paid access still requires accounts/authorization,
transactional credit reservation, durable jobs and payments; local API origin
checks are not that system.

## Implementation map

Search/relevance: `server/search`, `server/deals/find-deals.ts`,
`shared/search-criteria.ts`. Preliminary prices: `server/deals/prescreen.ts`.
Queue/display: `shared/analysis.ts`, `shared/analysis-priority.ts`,
`client/src/App.tsx`. Physical identity: `server/identity`,
`server/analysis/resolve-evidence.ts`. Evaluation/resumption:
`server/analysis/evaluate.ts`, `condition-runs.ts`, `store.ts`.
Prices/comps: `server/pricing/{pkmnprices,raw-prices,raw-comps,graded-comps,
cross-check,active-comps}.ts`. Historical photos: `server/ai/sold-condition.ts`.
Recovery: `server/deals/{pricing-retries,recover-pricing,search}.ts` and
`server/pricing/recover.ts`. Final math/rating: `shared/money`. Evidence display:
`DealCard`, `DetailPanel`, `AuctionSummary`, `PhotoReview`, `shared/liquidity.ts`.

## Primary documentation

- [PkmnPrices eBay sold API](https://www.pkmnprices.com/docs/ebay-listings): exact,
  shared and unknown attribution; actual accepted-offer amounts vs legacy rows;
  cursor pagination and sale-date windows.
- [PkmnPrices data sources](https://www.pkmnprices.com/docs/data-coverage): market
  quotes are separate from eBay sold transactions.
- [PkmnPrices history/volume](https://www.pkmnprices.com/docs/price-history): daily
  market-price aggregates are not sales counts; volume is recorded observations.
- [PSA Base Set printing guide](https://www.psacard.com/info/tcg/pokemon-basics-guide).

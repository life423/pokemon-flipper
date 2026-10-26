# Project memory and user preferences

Updated October 26, 2026. This file records the user's agreed requirements so
future work can continue without losing the conversation context.

## Working agreement

- Understand the complete search, screening, pricing, analysis, and UI workflow
  before changing it. Preserve working behavior and add meaningful regressions.
- The user is willing to pay for AI when it improves accuracy or throughput.
  Avoid duplicate, cancelled, or irrelevant work; do not remove useful checks
  merely to minimize AI usage.
- Preserve eBay response caching and the daily request reserve. Avoid wasteful
  broad live tests and unnecessary repeat detail requests.
- These improvements were developed on `improvements-review`, created from
  `main` after commit `93f4867` fixed the five initial audit findings. The user
  authorized merging them into `main` and pushing to GitHub on October 25,
  2026. Read Git status and remote refs for the current delivery state.
- Run tests, type checks, production build, and relevant workflow/UI checks
  before declaring a change ready. Commit/push only when requested.

## Current agreed checklist

1. Investigate and fix slow or stalled searches, including provider waits,
   retries, duplicate lookups, and misleading progress.
2. Make AI analysis concurrency adapt to eligible candidates and service health.
   The user objects to a fixed three-card limit. Keep a bounded global API load
   and back off when requests fail or are rate limited.
3. Honor Any profit / Any ROI throughout server screening and client repricing.
   Any removes minimum targets; it does not make losing purchases profitable.
4. Deals must meet the user's targets at the listed purchase price. An
   unaccepted hypothetical offer must not be counted as a confirmed deal.
5. Offer discovery has a strict maximum discount of **10% below asking**.
   Show the exact suggested offer. Rounding must not exceed that discount.
   Accepts Best Offer is not evidence that a seller will accept the amount.
6. Provide a persistent toggle to include/exclude opportunities that REQUIRE
   a Best Offer. With it off, listings that accept offers can still qualify
   at their full Buy It Now price. Keep offer opportunities separate from Deals.
7. Clarify card UI: asking price/current bid, estimated profit OR loss at that
   price, total invested, return on total cost, resale value before expenses,
   and any proposed offer/conditional profit. Do not require mental subtraction.
8. Show liquidity/resale activity based on dated, relevant sold comps. Distinguish
   sales cadence from time-to-sell. Show unknown when evidence is absent,
   especially for raw cards; never promise how many days a copy will take to sell.
9. Review ten substantially different search phrases through the app, recording
   first-result time, completion, failures, screening outcomes, sample full
   analyses, and eBay usage. Be explicit about samples or incomplete runs.
10. Preserve useful AI batching, saved photo assessments, exact-printing pricing,
    conservative identity checks, and eBay budget protection while verifying
    all of the above together.
11. Make the minimum Buy It Now price easy to set. It must not filter low
    auction starting bids. Reuse the existing minimum-price behavior.
12. Add a persistent minimum POTENTIAL grade control, such as potential 7 or
    above. The user explicitly corrected the rule: use the UPPER end of the
    AI's range. A 4–7 qualifies for potential 7. Explain that 7 is the optimistic
    end, not the likely or guaranteed outcome. Slabs use their read label grade.
13. The AI must independently assess raw condition (Near Mint, Lightly Played,
    etc.) AND a PSA-style grade range from photos. Seller condition is an
    unverified claim, never the final condition used to price an analyzed card.
14. Explain grading confidence using the available photo evidence: usable
    front/back views, close-ups, glare, exposure, cropping, holders, and
    background contrast. A white/light background may hide edge wear when
    contrast is poor; do not assume it proves damage or seller deception.
    Do not invent calibrated percentage odds of attaining the upper grade.
15. Run overlooked-listing discovery automatically on every search; remove the
    Dig deeper / Dig again button. Specific-card searches include misspellings,
    number-only titles and other categories; broad searches expand categories
    using the original query, without inventing a target card. Stream normal
    results first, deduplicate listings before extra checks, honor cancellation,
    and keep eBay's reserve. Photo matching has an adaptive bounded budget.
16. Proactively look for seller mistakes, including misspelled names, omitted
    1st Edition stamps, Shadowless cards called Unlimited, holo cards called
    non-holo, incorrect sets, and generic titles. Explain each mismatch using
    observed photo evidence. Scan beyond candidates priced on seller claims;
    those claims may be why an underpriced card was initially rejected.
    A mistake is not proof of profit. Preserve exact-printing, reprint, fake,
    stock-photo and condition safeguards. Require corroborated photo identity
    before correcting seller claims for a higher valuation.
    Shadowless upgrades need additional HP-font/artwork confirmation; missing
    artwork shadows alone cannot establish premium Trainer or Energy printings.
    Full analysis must remove a disproved lead and its bargain-score boost.
17. Grade scenario weights used for pricing are assumptions, not measured
    probabilities. Label them accordingly; do not present them as "Chance."

Offer-note generation currently produces a draft on request. The app does not
send it to the seller or submit an eBay offer. No automatic sending is authorized.

## User-reported examples

- `1999 base set holo` is slow/appears stuck; the user also struggles to find
  useful deals even with both profit and ROI set to Any.
- A $125 Blastoise appeared under Deals with an estimated loss of $52.99 and
  maximum purchase price $76 because the old code included offers up to 40%
  below asking. That is not a deal at asking and is outside the new 10% cutoff.
- $600/$650 Charizard listings similarly showed losses of $197.28/$250.97,
  negative ROI, and hypothetical maximum prices around $417/$418. The UI must
  explain that the red amount is already the estimated net loss, not another
  amount the user must subtract.

## Earlier improvement backlog (not all authorized for implementation)

1. Guided Find me a flip setup using budget, desired profit, grading preference.
2. Budget-appropriate search suggestions grounded in available market evidence.
3. Explain empty results and rejection reasons; preview target changes locally.
4. Discover realistic Best Offer opportunities earlier in screening.
5. Distinct resale strategies: raw resale, buy-and-grade, auction watching.
6. Put total investment and conservative downside on each result.
7. Rank by evidence quality, comparable sales, downside, and capital required.
8. Give a concrete next step for a listing: buy below limit, offer, request a
   specific photo, check a printing mark, or pass at the current price.
9. Persistent shortlist with targeted refresh instead of rerunning whole searches.
10. Adapt searches within an eBay request budget and share overlapping lookups.

## Next branch and proposed priorities

The user requested a new branch and further improvement ideas after release
`6b67170` was merged and pushed to `main`. Branch `faster-real-deals` was created
from that release. The following are proposals, not blanket authorization to
implement every item or start recurring searches:

The user subsequently authorized priorities **1 and 3 only**, with explicit
requirements to preserve working behavior and keep AI/eBay usage reasonable.

1. Review the extreme-underpricing exclusion. `prescreen.ts` marks a fixed-price
   listing below 20% of the cheapest known raw price as junk, and discovery
   excludes junk. Price alone should not prove a counterfeit; consider bounded,
   stronger photo verification before discarding a potentially genuine bargain.
2. Prioritize fresh listings with deduplicated refreshes, rather than repeatedly
   reviewing the same best-match inventory. Preserve caching and the eBay reserve.
3. Prioritize analysis by conservative achievable profit, photo coverage,
   comparable-sale quality and capital required. Current waiting order uses
   best-case price room, which can favor optimistic grading assumptions.
4. Give raw resale, buy-and-grade and auction strategies distinct search modes.
   A raw-resale mode should prioritize profit without requiring a grade increase.
5. Explore overlapping independent discovery with normal screening. Discovery
   currently starts after the normal stream finishes. Keep shared service caps,
   deduplication, cancellation and normal-result streaming intact.
6. Recover only failed price lookups after provider cooldowns, retaining completed
   photo assessments and successful results instead of restarting a whole search.
7. Finish the guided budget setup, evidence-based search suggestions, explanations
   for empty results, persistent shortlist, conservative downside on cards and
   specific next-action guidance from the earlier backlog.
8. Extend liquidity only when reliable turnover evidence is available; raw-card
   resale speed is still unknown. Repeat the ten-query evaluation on the final
   workflow with explicit API budgets; the saved timings predate that workflow.

Already delivered in `6b67170`: offer-aware screening and separate offers within
10%, automatic sampled discovery, adaptive analysis concurrency, visible price
and potential-grade controls, photo confidence and independent raw condition,
clearer money labels and total investment, observed graded resale activity,
shared lookups, bounded provider waits and cooldowns. At that release, budget-aware
search adaptation, ranking, strategy modes and shortlist work remained incomplete.

### Current local work on priorities 1 and 3

- Very cheap fixed-price listings now await photo verification in Review rather
  than being marked junk by price alone. Auctions remain exempt from this flag.
- Recovery uses the existing cached discovery scan plus an independent matching
  photo check. Stock, ambiguous, multiple-card, wrong-identity, mismatch and
  cancelled cases do not trigger comp/detail requests. A successful preliminary
  check only restores ordinary screening; full analysis still decides Deals.
- These listings receive at most a quarter of the existing discovery scan
  ceiling (at most 30 listings out of a 120-scan ceiling). They do not get an
  additional search budget. Existing global AI caps, per-search full-analysis
  limits, cancellation and eBay reserve remain in force.
- Automatic analysis and unverified Best sorting prioritize lower resale
  estimates meeting the user's targets, then as-is resale, then grading-dependent
  opportunities. Supporting comps, available unique photos, preliminary photo
  matches and capital required contribute to ordering. It adds no provider calls
  and does not change underwriting, profit thresholds or grade assumptions.
- Availability of photos is not proof of front/back coverage. Duplicate images
  and different resolutions of the same eBay photo count once for queue ordering.
- Validation uses mocked providers and an offline browser preview; no paid AI
  or live eBay calls are needed for these checks. Work was developed on
  `faster-real-deals`; consult Git for the commit and delivery state.
- All 235 tests, type checks and the production build pass. The offline browser
  preview confirms conservative raw resale before a speculative grading jackpot,
  with an unverified low price in Review and zero confirmed Deals.

### Listing-evidence cleanup at the stopping point

The user asked to improve the system and remove the redundant "Bargain" stamp.
The card badge and displayed numeric score are removed. The detail panel now
groups listing clues, checks/risks and discovery/auction context. Limited seller
history and weak photos are cautions and do not improve opportunity sorting.
Repeated evidence of the same printing/name/finish/set issue is deduplicated;
stronger actual clues precede accumulated weak metadata. Retrieval method alone
does not prove a title mistake. Default financial ranking remains separate.

### Stopping point and saved UI requests

The user requested a stopping point, a working commit on the current branch,
and then no further work. Commit locally on `faster-real-deals`; no merge or
GitHub push was requested for this stopping point. All 239 tests, type checking,
production build and diff checks pass before the commit.

The following requests were saved at that checkpoint and implemented when the
user resumed UI work on October 26, 2026 (see validation below):

- Auction cards currently mix the current bid with profit at another winning
  price and total investment at the current bid. Show an explicit max snipe/bid
  ceiling, and tie each profit/ROI/total-cost figure to the same winning price.
  Show time left, bid count, shipping assumptions, and when the current bid
  already exceeds the ceiling. Any-profit/Any-ROI can mean a break-even ceiling;
  clearly distinguish that from an attractive profit target.
- Show an evidence-based comparable-sale guide/range for possible auction
  closing prices, including sample size and uncertainty. Raw market quotes are
  not auction-ending predictions; missing/uncertain data must remain unknown.
- Raw cards need both PSA and CGC grading routes visible. Current condition AI
  produces one shared PSA-style grade range used to price both graders, so do
  not imply independent or certified grade predictions. Compare separate fees,
  resale evidence and limits using existing data. Slabs retain their actual
  certified grader/grade.
- Perform a full UI/UX layout pass: fix overlapping components, unwanted scroll
  bars, inconsistent type and spacing scales, and dense card content. Test
  desktop and phone layouts with offline fixtures, including auctions, missing
  photos/prices, long titles, side panels, filters and grading comparisons.

## October 26 UI and auction update

The user resumed work on `faster-real-deals`, authorizing UI cleanup, both
PSA/CGC routes and clearer snipe instructions. After offline validation, the user
authorized committing the work, merging into `main` and pushing to GitHub on
October 26. Consult Git for the resulting commit and synchronization status.

- Auction cards and analysis share a prominent current bid / max snipe ceiling.
  The profit, ROI and total investment all use the explicitly stated winning
  price. Above-limit auctions show the current-bid loss/outcome and a pass
  message rather than hypothetical green profit at an unattainable lower bid.
- Any profit / Any ROI is labeled a break-even ceiling. Weak photo/grade evidence
  marks a limit provisional; missing pricing supplies no numerical snipe advice.
  The app still does not place bids or offers.
- Closing-price guides use the existing condition-matched raw quote, or dated
  slab comps from the past 180 days with sample size and observed range. Unknown
  condition/weak photos do not supply a raw guide. After-grading resale values
  never substitute for the raw auction price. References are not calibrated
  auction forecasts; outlook copy now describes the comparison honestly.
- Raw cards display both PSA and CGC with the existing shared photo range and
  separate resale evidence/costs. The chosen route is labeled. Missing prices
  remain unavailable; slabs display their actual certified label only.
- Fixed type/spacing scales, wrapping tabs, wider readable cards and a modal
  analysis panel prevent results from being squeezed by the panel. Settings and
  analysis lock the background scroll, trap Tab and restore focus on Escape.
  Photo navigation uses a collapsed gallery and wrapping thumbnails. Its URLs
  come from details already fetched for analysis; no extra eBay/photo AI call.
- Search progress starts compact unless the user saved an expanded preference.
  All original analysis reasons, cost assumptions and auction concerns remain
  available in the panel. No prompts, provider concurrency, caching, reserves,
  pricing models or discovery budgets were changed.
- All 247 tests, both TypeScript projects, typed new test fixtures, production
  build and diff checks pass. Offline browser checks covered 320/375/768/1280/
  1440px layouts, auctions, BIN, slabs, unknown photos/prices, long titles,
  over-limit losses, Any/Any repricing, gallery navigation, filter settings and
  keyboard/focus behavior. No AI or eBay calls were used. See
  `docs/ui-review-2026-10-26.md` for the scope and limits of this verification.

## Validation commands

`npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
Live diagnostics may consume paid API credits; prefer cached or offline fixtures
for regressions. Keep secrets and ignored API-response caches out of commits.

## Current implementation and review status

- The user approved the agreed improvements for merge into `main` and push to
  GitHub. The release checks passed again before committing; consult Git for
  the resulting commit and remote synchronization status.
- Tests, type checks and production build pass. Browser validation confirmed
  automatic discovery, persisted offer/price/grade controls, and reuse of saved
  full photo assessments. Final test total: 216.
- Ten-query diagnostics are recorded in `docs/search-review-2026-10-25.json`.
  Nine streams completed; the broad vintage run was stopped at 150 seconds
  after price-service rate limits. Full analyses were sampled. The report's
  timings predate the final automatic-discovery workflow, so they are not final
  performance benchmarks.
- A live provisional Shadowless Mewtwo lead was disproved by full photos:
  Unlimited, damaged, estimated range 1–4 / likely 3, losing money at asking.
  The app correctly returned PASS. Quick photo scans can be wrong and must
  remain provisional until the full identity/condition checks settle them.
- Raw resale speed remains unknown without turnover evidence. Graded resale
  activity reports observed dated comps, not a promised time-to-sell.
- Reference for extra Base Set printing checks:
  https://www.psacard.com/info/tcg/pokemon-basics-guide

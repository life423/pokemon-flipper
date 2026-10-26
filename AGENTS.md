# Project memory and user preferences

Updated October 25, 2026. This file records the user's agreed requirements so
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

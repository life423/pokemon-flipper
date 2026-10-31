# Project memory and user preferences

Updated October 31, 2026. This file records the user's agreed requirements so
future work can continue without losing the conversation context.

## October 31 pricing-gate and physical-identity corrections

Developed on `codex/deal-screening-audit`. On October 31 the user authorized
committing these fixes, merging into `main` and pushing to GitHub. Consult Git
for delivery status. Read
`docs/pricing-flow-audit-2026-10-31.md` and the saved deal-alert/roadmap report.
The user explicitly wants preliminary pricing to be far less restrictive:
use it to rank AI work, not to veto matching photographed listings above target.
Missing exact-grade sold data may use photo-checked current Buy It Now competition
of the same card/printing/finish/grader/grade. Keep sold data primary and current
asking references distinct from transactions/liquidity. Compare item plus shipping,
exclude self/duplicate certs, inspect physical labels and seller history, preserve
the user's analysis budget and never inflate values simply to populate Deals.

The user caught a false Shadowless PSA 8 Venusaur, item 257827112860, cert 51702940.
Two agreeing AI border readings overrode its ordinary PSA label and selected
Shadowless prices. Complete ordinary PSA English 1999 Base Set labels now prevent
that upgrade; partial labels cannot authorize a premium. Real reevaluation reused
saved photo work with zero new AI calls: Unlimited, $300 sold median, PASS at $350,
-$131.34 after costs and $182 limit at $50/25%. Do not restore the old test that
allowed unlabeled PSA slabs to become Shadowless from artwork guesses.

Use six raw categories: Mint, Near Mint, Lightly Played, Moderately Played,
Heavily Played, Damaged. Mint is PSA 9 terminology; Gem Mint is 10. Historical
sold-copy photos, not seller claims, establish condition when available. Missing
views remain unknown. Keep seller/AI comparisons useful and remove repetitive
generic guarantee disclaimers. Certified slabs do not need raw-grading warnings
or unusable raw-only deeper-review buttons. Card headers state Auction/Buy It Now.

Normal port is **3017**. Port 3000 belongs to another app; never stop it. Keep
isolated QA data separate. The 3018 test instance has been used interactively by
the user: do not casually terminate it mid-search or overwrite its data. Latest
complete unit run: 428 passing; typechecks/build pass. Live Aquapolis counts in
the report precede the newest broader gate and active-comparison fallback, so
do not misrepresent them as final release counts. The October 31 release request
covers the pricing gate, current-listing comparisons, false Shadowless correction
and their supporting audit/recovery changes.

The corrected Venusaur direct-link UI passed 320/390/768/1440 checks. A controlled
503 retried once successfully; a separate controlled missing-sold view rendered
real current-listing evidence without changing the stored primary sold result.
A final bounded live Venusaur PSA 8 search auto-analyzed five above-target
listings: all completed and failed the selected $50/25% targets. This proves the
broader gate, not that all 74 visible matches received full analysis. The normal
3017 server and 3018 preview now run the correction; the old preview search was
stopped before its backend update. Keep the user's preview tab available.

## October 30 recent eBay resale, shipping and liquidity audit

Current work is uncommitted on `codex/deal-screening-audit`, from `d7fd26f`.
Read `docs/resale-pricing-audit-2026-10-30.md` for findings, evidence and limits.
The user prioritized fixing shipping and accurate recent eBay resale evidence,
and asked for observed trading activity. No market prediction was implemented.

- Prefer a raw eBay median only with at least three explicit same-condition,
  same-printing/finish USD sales within 90 days. Keep marked TCGplayer fallbacks;
  never assume unstated raw condition is NM or inflate prices to create Deals.
- Graded comps are USD only, same finish/grader/grade/printing. Prefer 90 days
  when supported by three matches; otherwise label the 180-day fallback.
- Shipping's zero-dollar optimistic bound only triggers a fresh quote check.
  Missing shipping remains visibly assumed at $7. Cache by delivery destination.
  A delivery ZIP has been requested but not supplied; do not invent one.
- PSA Standard is available through $1000 at $59.99; current published caps/fees
  apply, including $199 Express. Value is paused. Account verification remains
  false. Preserve the user's effective eBay rate and all-grade cap coverage.
- Volume means recorded eBay comps for the printing, all raw conditions or all
  slab grades combined; it is not total volume, sell-through or promised speed.
  Optional plan-gated volume must not disable working price lookups.
- Reuse unchanged photo assessments while refreshing stale/legacy shortlist
  pricing. Current pricing version is in `shared/pricing-freshness.ts`.
- 381 tests, typechecks/build, 22 final browser checks/eight axe scans and three
  listing-link checks pass. Live default-400 Neo search retained 157 matches;
  all 18 eligible full assessments finished. Deals 0 at Any/Any and $50/25%;
  Waiting 0; Review 15 (13 real screening gaps plus two full price gaps).
  One real temporary pricing ticket recovered automatically. Real API/UI test
  mutations used isolated data; the user's shortlist is preserved. The normal
  app runs the tested production build on port 3000; isolated port 3001 is stopped.
  Do not claim every listing was assessed.

## Future proposal: market trends and forecasts

On October 30 the user proposed, for later, using connected APIs to build our
own historical card-price/sales charts and trend data, then score likely upward
or downward movement using other relevant metrics too. This is a saved proposal,
not an implemented feature or authorization to interrupt current validation.
Keep exact printing/finish and raw condition or certified grader/grade separate.
Show observed history, data coverage and confidence alongside any forecast;
validate predictive scoring against past outcomes before it affects rankings.
Keep current executable-profit calculations separate from hoped-for appreciation.

## October 30 default-window Deals measurement

The user requested another live `neo discovery holo` run after `d7fd26f`, with
automatic recovery, mobile checks and an explicit Deals count. See
`docs/neo-discovery-release-check-2026-10-30.md`. The default 400-result window
produced 155 retained matches; all 10 eligible automatic full assessments
completed, with 0 Deals under both Any/Any and $50/25% targets. There were 12
genuine unresolved data/identity screens and no temporary failures left.
One isolated controlled interruption recovered after 30 seconds; nine screening
jobs resolved automatically, seven priced and two unavailable-data outcomes.
The normal app/data were untouched. Supplementary phone/tablet/desktop and
landscape checks passed, including six axe scans. This is a sampled app verdict,
not a claim that every market listing was fully photo-assessed or unprofitable.

## October 30 Neo Discovery automation follow-up

The user requested a real `neo discovery holo` test, questioned screening/cache
behavior, and clarified that routine failures should recover automatically.
Developed on `codex/automatic-pricing-recovery` from `baaf804`. The user
subsequently authorized committing the changes, merging into `main` and pushing
to GitHub. Consult Git for delivery status. Read
`docs/neo-discovery-automation-2026-10-30.md`.

- Temporary screening-price failures recover within the cancellable search,
  including new-listing discovery, using trusted tickets and guarded updates.
  Keep batches of five, provider cooldowns, five-second batch spacing, two
  automatic attempts per listing, 300-listing cap and a 20-minute window.
  The existing queue's global pacing/mutex/three-attempt limit still applies.
- Show temporary price work in Waiting with automatic-recovery progress, not
  immediate manual Review. Genuine ambiguity/missing evidence still needs care.
  Never manufacture Deals to clear the backlog or expand the user's AI cap.
- Full assessments can resume a typed temporary price failure once after a
  cooldown of at most 90 seconds, without repeating completed photo/condition
  work. Keep existing comp checks and account/credit safeguards.
- Match Unown letter forms through species metadata plus exact card number.
  Empty card-name results use a five-minute negative cache; preserve successful
  price caches and unchanged-photo assessments. Expired tickets cannot retry.
- Two actual 100-match samples had 50 and 9 incomplete screenings respectively.
  The first had 31 rate-limit cases and 14 Unown lookup failures; the second was
  warm and had no temporary failures, so do not attribute every improvement to
  automatic recovery. Three fresh pricing comparisons matched cached values.
- Validation: 361 tests, typechecks/build, 48 browser checks with 11 axe scans,
  real raw/slab assessments, and separate controlled screening/full-assessment
  recovery. Main data/shortlist stay separate from test mutations. No physical
  phone, universal valuation accuracy or production performance certification.

## October 30 result visibility and assessment audit

The user requested finishing the audit and result visibility fixes with mobile
verification. Developed on `codex/search-result-visibility` from `1b2eb12`.
The user subsequently authorized committing the changes, merging into `main`
and pushing to GitHub. Consult Git for delivery status. Read
`docs/result-visibility-audit-2026-10-30.md` for evidence and limitations.

- New keyword searches start in All; explicit view selections survive streaming.
  Empty Deals links to found listings. New-listing discovery still opens New.
- Incomplete screening and failed analysis belong in Review, not invisible
  outcomes or Waiting. Preserve confirmed Deal/profit and identity safeguards.
- Show incomplete pricing during search, but wait for search completion before
  manual pricing retries. Distinguish completed photo reviews from screening;
  search completion does not imply every listing received a paid assessment.
- Keep test faults and mutations off the user's active server: use a separate
  port and POKEMON_FLIPPER_DATA_DIR, copying named caches when needed.
- Validation: 346 unit tests, typechecks/build, 74 recalculations of 37 saved
  assessments, prior live Aquapolis/pricing recovery evidence, and 28 final
  browser checks including seven axe scans. Controlled UI states replay actual
  captured data; isolated saved-assessment and shortlist endpoints stay real.
  Marketplace/model accuracy is sampled, not certified for every result.

## October 30 pricing retries, card details and motion

The user requested pricing retries and visible grade/finish on every card while
preserving behavior, reasonable API use and mobile usability. They subsequently
requested some animations from their portfolio's `animations.js`. Work is on
`codex/pricing-retries-card-details` from `08be1a3`. The user subsequently
authorized committing the changes, merging into `main`, and pushing to GitHub.
Consult Git for the resulting revision and remote synchronization. No deployment
was requested. Read
`docs/pricing-retries-card-details-2026-10-30.md`.

- Retry only structured temporary pricing failures, not identity failures,
  absent comps, exhausted credits or configuration errors. Identity deliberately
  catches lookup failures, so preserve a separate typed pricing signal across
  that boundary instead of classifying by reason text.
- Use explicit batches of at most five, one global batch at a time, paced work,
  provider cooldown/Retry-After, three attempts per server-held snapshot, and
  bounded 30-minute in-memory tickets. Successful duplicate requests reuse work.
  No arbitrary browser listing payload may start a pricing retry. No polling or
  expanded AI budget; retry pricing uses deterministic comp rules without new
  title/photo/AI-comp calls. New candidates still follow the existing AI setting.
- Keep assessments and unrelated results. Reject late replies for changed
  title/photos/attributes/terms; skip evaluated or analyzing IDs. Cancellation
  stops subsequent queued work. Pricing retries do not refresh eBay terms.
- Show seller attributes as Listed, checked slabs as Label checked, raw cards as
  Raw, and uncertain/qualified readings as needing review. Never substitute a
  potential raw grade for a slab grade. Fresh details replace old attributes;
  preserve them on shortlist save/refresh. Unknown finish stays unknown.
- Adapt only short purposeful portfolio effects: card slide/fade entrances,
  active-mode underline, pricing feedback fade and a one-shot saved check.
  Keep current tokens/brand, capped stagger, and explicit reduced-motion stops.
- Validation: 345 unit tests, typechecks/build, 15 live browser checks plus 12
  supplementary motion/UI checks (nine axe scans total). One test-only network
  interruption exercised cooldown, followed by recovery of two real listings
  with one real pricing call and no retry-time eBay/OpenAI calls. UI-only motion
  checks replay captured actual search data to avoid another provider batch;
  save/remove and cached retry endpoints stayed real. Test shortlist mutations
  were reversed and verified. Phone/tablet/desktop/enlarged-text screenshots
  were inspected; physical-device and production performance checks remain.

## October 30 flexible natural-language search

The user requested flexible queries such as “aquapolis cards psa 7 or better
holo”. Implemented on `codex/flexible-search` from main `4173839`. The user
subsequently authorized committing the changes, merging into `main`, and pushing
to GitHub. Consult Git for the resulting revision and remote synchronization.
No deployment was requested. Read
`docs/flexible-search-2026-10-30.md` for scope and live verification.

- Interpret card/set, grader, inclusive slab-grade bounds and finish; show the
  reading visibly. A grade range must not become an exact-grade eBay keyword.
  Holo excludes reverse holo and non-holo. Numeric common operators retain a
  deterministic fallback; existing card/set interpretation still uses the model.
- Reject known grade/grader/finish conflicts before pricing/photo work, and
  repeat checks against item specifics, discovery and final photo assessments.
  Unknown required criteria cannot queue full automatic analysis. Never use a
  raw card's predicted grade as a requested existing slab grade. Direct links
  remain independent of keyword search constraints.
- Keep one cached intent request, existing title/comp/photo caches, concurrency,
  reserve, cancellation and automatic-analysis settings. Broad graded-set
  discovery needs one targeted extra query rather than unrelated raw searches.
- Live Aquapolis verification returned matching PSA 7/8/9/10 cards, but 73 were
  unpriced or incompletely screened (65 affected by provider cooldown). Do not
  equate zero Deals with a fully priced marketplace. The UI now reports partial
  screening and points to All. Follow provider cooldowns; do not force retries.
- Validation: 331 unit tests, typechecks/build, four real intent queries, 14 live
  browser checks (five axe scans), one real paid slab analysis, and six UI-only
  checks (four axe scans) replaying the captured real stream. Touch phone,
  tablet, desktop and enlarged-text screenshots were inspected. This is not a
  physical-device or production performance certification.

## October 30 direct listing links

The user requested pasting/dropping a listing link into the app for direct
evaluation and supplied eBay item 267743966894 (Mewtwo). Work is on
`codex/listing-link-evaluation`. The user subsequently authorized committing the
feature and UI changes, merging into `main`, and pushing to GitHub. Consult Git
for the resulting revision and remote synchronization. No deployment was
requested. Read `docs/listing-links-2026-10-30.md`.

- Reuse the main search field: keywords still search, recognized links/item IDs
  show an explicit paid evaluation action. Dropping a link fills the field but
  does not start paid work until submitted. Show a separate Listing evaluation
  workspace and preserve search results and shortlist actions.
- The user explicitly requested visible link-entry affordances with a clean,
  responsive UI. Keep the Search cards / Evaluate eBay link choices visible,
  preserve separate drafts, and require explicit submission for paid work.
  Use a full-width evaluation button on phones, 44px clear/mode targets and
  full-row input on tablets. Hide empty result controls before the first search;
  financial targets remain available in Menu. Preserve text-enlargement reflow.
- Validate on both client and server. Extract a strict eBay.com item ID, remove
  tracking, and use the existing Browse API. Never fetch arbitrary submitted
  URLs. Variations, obvious lots/proxies, ended listings and absent photos stop
  before paid AI. Current details feed the existing title/photo/assessment gates.
- One direct listing does not launch search/discovery or inherit search result
  filters. It does use the user's financial targets. Successful analyses remain
  reusable; duplicate resolution/evaluation work shares the existing guards.
- Live verification used the supplied Mewtwo link, real paid analysis, reuse,
  saving, cancellation, malformed/not-found handling, request counts and actual
  phone/tablet/desktop renders. Keep its observed PASS separate from a claim of
  market accuracy. Preserve the user's preference for real API validation.

## October 30 live API validation and correctness

The user authorized committing the fixes and shortlist/discovery features,
merging them into `main`, and pushing to GitHub on October 30. Consult Git for
the resulting revision and remote synchronization. No deployment was requested.
Keep `.env` private and the unrelated local `.env.example` deletion outside the
release; the repository retains its blank setup template.

The user explicitly authorized spending money and using the real APIs, and said
this is the best way to build the app. Use representative live searches and paid
analyses to validate end-to-end behavior. Unit tests remain useful regressions;
do not substitute an entirely mocked workflow for live verification. Preserve
useful checks and caches, avoid duplicate paid work, and report measured usage
and incomplete samples honestly. Do not ask again merely because a relevant
development/test request consumes API credits.

The initial 401 came from starting the app without `.env`. The user supplied the
file; a fresh process authenticated with eBay, OpenAI and both pricing services.
Never copy key values into reports or commits. `.env` stays ignored. Restart the
server after configuration changes. Missing keys now fail before a token request;
rejected pairs share a 60-second failure cooldown and give an actionable message.

The supplied audit's four correctness issues were confirmed and corrected:
fresh analysis ignores browser terms, fresh server snapshots reach cards and the
shortlist, assessment reuse requires matching saved title context, AI-checked
comp labels require checks on every retained sale, and identical evaluations
share work while differing snapshots for one item serialize. Preserve the
identity safeguards, two cautious condition assessments, fee math and discovery.
See `docs/live-validation-2026-10-30.md` for live evidence and limits. Public paid
access still needs accounts/authorization, a transactional credit ledger, nested
provider-budget enforcement, durable jobs and payment/refill handling. Those are
not implemented or approved by this local correctness pass.

## October 29 shortlist, refresh and discovery

The user authorized implementing a persistent shortlist, targeted refresh and
new-listing discovery while preserving behavior and controlling API usage. Work
is on `codex/shortlist-discovery`; commit/push only when requested. Read
`docs/shortlist-discovery-2026-10-29.md` for behavior, limits and verification.

- Store listing snapshots, trusted server evaluations, notes and ceilings locally
  on the server. Save/edit/remove/load must never trigger provider work. Preserve
  user data on read errors and concurrent updates. No account sync is implied.
- Refresh only selected saved IDs (at most ten), with global concurrency two,
  same-ID sharing, a durable one-minute success cooldown and 30-second failure
  backoff. Preserve the eBay reserve. Refresh terms/photos, never paid AI.
- Same title/full photo evidence reuses the assessment and reprices current terms.
  A fresh unknown shipping quote replaces an old known quote. Changed evidence
  clears advice until explicit analysis; unavailable/ended listings cannot retain
  buy/bid recommendations or start paid reanalysis. Keep notes and historical data.
- New-listing discovery is an explicit newest-page action: one page of 200,
  at most 20 unseen screenings and five automatic full analyses (or the user's
  lower cap). Existing screening may still use paid title/photo checks. Exclude
  seen IDs before those checks, persist history per query/minimum, preserve prior
  results, reserve, cancellation and caches, and do not add background polling.
- Preserve the prior audit fixes and normal search behavior. Verify actual phone,
  tablet and desktop renders and request counts; a build alone is insufficient.
  Final verification: 298 unit tests, type checks, strict new-test typing, build,
  74 browser checks (27 accessibility scans), actual server-restart persistence
  and zero audit vulnerabilities. Providers were replaced with offline fixtures;
  this does not validate live marketplace accuracy or production Core Web Vitals.

## October 29 audit corrections

The user authorized fixing the audit findings, starting with pricing and stale
photo assessments, while preserving behavior and testing end to end. Work is on
`codex/audit-fixes`. The user subsequently authorized committing the fixes,
merging into main and pushing to GitHub on October 29; no deployment was
requested. Consult Git for delivery status. Read
`docs/audit-fixes-2026-10-29.md` for exact changes, evidence and limitations.

- Missing grades in a nonmonotonic observed price range now block that grading
  route instead of inheriting a lower-grade premium. Complete ranges and supported
  raw resale still work; the existing monotonic fallback remains an assumption.
- Reuse assessments only for current title/photo evidence, normalizing eBay image
  sizes. Changed evidence and late old responses must not restore a stale result.
  Full reanalysis refreshes listing details. Preserve unchanged-photo reuse and
  never fetch URLs merely because the browser submitted them as evidence hints.
- Preserve cancellation through initial pagination/provider requests, explicit
  terminal stream completion, and the user-controlled rerun when widening a
  server-side minimum price. Do not silently spend on a rerun while typing.
- Modal focus must survive shortcuts and loading/result DOM transitions. Keep
  ordinary Tab/Escape restoration and named progress feedback.
- Portable Windows production startup and compatible security updates are included.
  Verification: 285 unit tests, both TypeScript projects, direct strict regression
  typing, build, dev/production smoke checks and 35 browser checks pass. The browser
  count includes 13 accessibility scans. Zero live paid/provider calls were used.
  These checks do not establish marketplace accuracy or measured production speed.

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

## October 26 ten-search review — follow-up work

The user approved the recommendation to audit ten varied searches on a new
branch. `search-workflow-review` starts from `8b0574a` on `main`. The initial review
added diagnostic scripts/tests and reports only. The user subsequently authorized
the three priority corrections described below.
The user subsequently authorized committing this review and its corrections,
merging into `main`, and pushing to GitHub after validation. Consult Git for
the resulting revision and remote synchronization status.

- Findings and exact sample limitations are saved in
  `docs/search-review-2026-10-26.md` and its JSON companion. All ten primary
  phrases were sampled; discovery was capped, and the final two used fresh
  primary pages with cached-only screening after the resource ceiling.
- Transport instrumentation recorded 152 Browse, 120 AI and 55 price requests.
  The account Browse count rose 190; the extra 38 are not attributable from
  available evidence. Four full evaluations were sampled. Do not describe this
  as an exhaustive ten-search benchmark or repeat paid searches by default.
  Actual result snapshots and full evaluations are ignored local files under
  `data/reviews/2026-10-26/`, available for offline regression work.
- Highest priority: `gradePath` assumes higher numerical grades have higher
  prices. The damaged Umbreon sample has grade-1 resale $1,739.04 but grade-5
  resale $1,395. It chooses the configured Regular fee using grade 5 instead of
  covering the maximum scenario value with Express. Using the existing config's
  applicable tier changes modeled profit +$45.64 to -$49.37. PSA fee verification
  remains separate; no current invoice/fee amount was established by this audit.
- Same assumption makes `downsideNet: outlook[0].net` unsafe. That sample's
  reported downside +$291.70 overlooks a -$242.81 scenario before correcting
  fees (-$337.82 after correction). Use minimum modeled net for financial
  downside and audit missing-grade price fallback. Lowest grade and lowest
  financial outcome are different concepts. This also affects the Raichu's
  unselected grading route. These bugs were reproduced and corrected in the follow-up below.
- A CGC 8.5 Lugia was incorrectly held because `NM/MINT+` was read as a special
  qualifier. CGC's official standard scale uses that ordinary description for
  8.5. The follow-up now recognizes ordinary grader-specific descriptions while
  preserving genuine qualifiers, special tiers and other slab safeguards.
  Confirming the label does not establish a profitable listing.
- Later priorities: enforce explicit search finish/grader/numeric-grade
  constraints (non-holo cards survived the holo search; PSA 3/5/7 and CGC 8
  survived a PSA 8 search), and distinguish small-margin/low-confidence leads
  from stronger opportunities. Any/Any still must not count a loss as a deal.
- First results in the first eight rows arrived in 0.70–1.74s with warm caches;
  sampled streams returned in 34–69s. Discovery added 19–44s in the first seven.
  The serial sampled full analyses are not live UI time-to-first-deal measures.
- Recorded-result UI replay verified the low-confidence Umbreon under Deals
  and its misleading low-grade reassurance, without additional provider calls.
  All 249 tests, type checks, production build and diff checks pass. The added
  two tests cover diagnostic guard behavior, not fixes to the identified bugs.

## October 26 priority corrections

The user approved fixing the service-tier, modeled-downside and CGC-description
issues on `search-workflow-review`, then authorized committing them, merging
into `main` and pushing to GitHub. See `docs/grading-corrections-2026-10-26.md`
and consult Git for delivery status.

- `gradePath` selects its tier using the maximum resale value among modeled
  scenarios and uses the minimum net proceeds for modeled downside. Existing
  fee amounts, grade weights and missing-grade fallback remain unchanged.
- The shared qualifier normalizer accepts ordinary CGC descriptions only at
  the matching numeric grade, for slab checks and comp filtering. Real, mixed,
  unknown, special and legacy designations remain protected. No AI prompt/model
  changes or cache clearing are needed; saved photo readings remain reusable.
- Offline replay changes the $999 Umbreon from BUY_AND_GRADE to PASS, with
  -$49.37 estimated profit and -$337.82 modeled downside. Both sampled raw
  resale profits remain unchanged. The Lugia slab check now passes but missing
  cached verified prices correctly remain unavailable rather than inventing a
  profitable resale estimate. Conditional offers remain separate from Deals.
- Labels say modeled downside and lowest modeled resale scenario; do not
  promise that actual losses cannot exceed those figures. Sparse grade-price
  fallback still needs its own review and is not guaranteed conservative.
- All 259 tests, type checking, production build, direct typing of the new
  fixture/test and diff checks pass. Recorded-result browser verification
  confirmed the corrected loss, Deals removal, tier and downside on desktop
  and a 375px phone. No AI/eBay/price-provider calls were made for these fixes.

## October 26 AI photo-review clarity and optional second opinion

The user agreed to clear AI-review status and an optional deeper AI photo-review
button. Work was developed on `ai-photo-review` from `8b8911b`. The user then
authorized committing it, updating `main` and pushing to GitHub as the latest
commit. Consult Git for current delivery status.

- Cards and analysis now distinguish preliminary AI matching from completed
  photo analysis. Show checked photo count, original assessment date, condition
  confidence and **Your review needed** with concrete reasons. A successful
  photo check alone does not establish high grading confidence.
- The optional **Deeper AI photo review · paid** uses one request on the existing
  model, at most eight unique useful cached listing photos, an output-token cap,
  no SDK retries and the existing global AI limiter. It makes no eBay or price
  requests. Normal automatic initial analysis and its cache version are unchanged.
- Save the focused report separately, keyed to the photos and initial assessment.
  Reopen saved results without paying again; deduplicate concurrent clicks and
  preserve successful answers across a temporary disk-write failure in a bounded
  recovery cache. Failed AI attempts have a short retry cooldown.
- Keep the original assessment visible during/following the second opinion.
  The report cites listing photo numbers and requests specific missing views.
  It cannot increase grades, confidence or bid limits. A new visible concern
  holds purchase/offer advice for review without weakening existing hard stops.
  Stock-only/obscured-front inputs ask for better photos before allowing payment.
- All 274 tests, both TypeScript projects, directly typed new tests, production
  build and diff checks pass. Offline browser checks cover desktop and 320/375px
  phone layouts, pending/saved/error states, new-risk removal from Deals, and
  stock-photo rejection. No AI/eBay/price-provider calls were made in validation.
  See `docs/ai-photo-review-2026-10-26.md` for scope and limitations.

## Validation commands

`npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
The user authorizes paid live diagnostics. Combine meaningful unit regressions
with representative real-API workflow checks; use caches to avoid duplicate work.
Keep secrets and ignored API-response caches out of commits.

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

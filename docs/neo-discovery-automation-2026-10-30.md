# Neo Discovery live validation and automatic recovery — October 30, 2026

Developed on `codex/automatic-pricing-recovery` from `baaf804`. The user asked
for a live `neo discovery holo` workflow test, questioned screening ceilings and
caching, and clarified that routine failures must recover automatically. These
changes were subsequently authorized for commit, merge into `main` and push to
GitHub. Consult Git for the resulting revision and remote synchronization.
No deployment was requested.

## Changes

- Temporary screening failures recover inside the existing search stream after
  normal results and discovery. Recovery uses trusted snapshot tickets, batches
  of five, provider cooldowns, five seconds between batches, two automatic
  attempts per listing, at most 300 distinct listings and a 20-minute window.
  The existing queue also retains its global mutex, pacing and three-attempt
  server limit. This is a cancellable local search, not a durable background job.
- Recovery runs deterministic pricing only. It does not rerun eBay discovery,
  title/photo checks or AI comp checks. New candidates follow the user's existing
  automatic full-analysis setting; discovery still screens only 20 unseen items
  and allows at most five full analyses. Limits or account problems leave an
  explicit unresolved status; missing evidence is never turned into a Deal.
- Typed temporary failures appear in Waiting with a Waiting for price badge.
  The progress panel reports automatic recovery and keeps Stop search available.
  Manual retry controls are unnecessary during the active search. Review keeps
  identity, evidence and genuinely unavailable-data cases.
- Recovered rows have a dedicated stream message with the original pricing
  snapshot key. Changed terms/title/photos and loading/completed evaluations
  reject late replacements, preserving the earlier stale-result safeguards.
- Full assessments also resume a failed price stage once after a typed temporary
  failure, waiting up to 90 seconds. Completed photo and condition steps are not
  repeated. Missing comps, account/configuration problems and longer waits do
  not cause uncontrolled retries. Existing AI comp validation stays enabled.
- Unown letter names now query the provider's species name and retain the exact
  collector-number check. The old `unown a` query returned no cards while the
  provider's `Unown [A]` record existed. Fourteen listings in the first sample
  were affected by that lookup failure.
- Successful-but-empty card-name searches expire after five minutes, rather
  than remaining negative answers for 24 hours. Positive metadata, market-price
  caching and unchanged-photo assessment reuse retain their existing behavior.
  Retry hints now expose expiry so expired work is not queued again.

## What the live searches showed

Both runs used one primary page (200 fetched listings), normal automatic
discovery, Any profit/Any ROI and five automatic full analyses. They used real
providers, copied caches and separate data folders; the user's shortlist was
not changed by the tests.

| Observation | Initial run | Corrected run |
| --- | ---: | ---: |
| Retained matches | 100 | 100 |
| Incomplete screening | 50 | 9 |
| Automatic full assessments | 5 | 5 |
| Time to first listing | 1.96 seconds | 1.99 seconds |
| Search stream completion | 115.1 seconds | 182.7 seconds |

The initial 50 incomplete screens included 31 rate-limit failures and 14 failed
Unown lookups. A baseline manual batch recovered four of five listings. The
corrected warm run had no temporary pricing failures, so the 50-to-9 change
reflects corrected metadata lookup and successful pricing availability, not a
claim that automatic recovery alone fixed every original entry. Fifteen retained
Unown A listings were identified/screened in the corrected run, and Unown cards
entered full analysis automatically. The run still produced zero confirmed
Deals at asking/current conditions. This is a sample, not proof about the entire
market or the user's separate 289-item Review screenshot.

Opening screened-out listings still performs full analysis. Two samples:

- Wobbuffet 16/75, asking $129.99: initial screening ceiling $13; the full raw
  assessment was Moderately Played, limited range 3–7, with estimated loss
  $134.84 and an Any/Any ceiling of $5. Both grading paths lacked supported
  low-grade prices. Standard-print pricing does not establish premiums for the
  seller's swirl/holo-bleed claims. This sample remained a Pass.
- Yanma 17/75, asking $225.25 plus $6 shipping: the label photo visibly reads
  CGC 9. Full assessment confirmed Unlimited holo, with $70 median sold pricing,
  estimated loss $199.01 and a $41 Any/Any ceiling, matching screening. This
  sample also remained a Pass.

Actual seller-photo galleries, the CGC label, card headers and assessment panels
were visually inspected. Condition estimates remain model judgments, not
professional grading or independently certified market valuations. The cropped
$345/$6 screenshot did not establish an exact listing in this Neo Discovery
page; no claim is made that its specific valuation was validated.

## Freshness and recovery evidence

Three direct cache-bypassing provider requests compared Espeon/Smeargle market
prices and an Espeon PSA 7 comp page with cached responses aged 32–35 minutes.
All three normalized price/comp datasets were unchanged. That rules out stale
cache values for those samples, not every possible price. The negative-result
TTL fix addresses a separate, real failure mode without discarding useful photo
assessments or refreshing an entire market on every click.

Two controlled interruptions ran only on isolated test servers/data:

1. A single temporary Poliwrath lookup failure produced six recovery jobs. All
   six resolved automatically; five became priced screens and one remained a
   genuine unavailable-data case. The real provider request began 30.02 seconds
   after the injected failure. During recovery, only one price-provider request
   was sent, with no eBay/OpenAI or manual-retry requests. Full analysis was Off
   in this scenario and remained Off.
2. A saved Smeargle full assessment encountered one temporary PSA comp failure.
   The same assessment resumed after 30.01 seconds and obtained real PSA prices.
   Original condition, grade range and assessment timestamp stayed unchanged;
   both photo and condition steps were reused, with no new OpenAI requests.

The real, fault-free search and targeted samples recorded 23 successful browser
checks. Recovery fault tests added seven, UI race/cancellation checks added seven,
and full-assessment recovery added five: 42 checks with 11 axe scans. Six final
startup/menu/link-entry/layout/data-preservation checks on the normal app bring
the total to **48 browser checks**. UI race
tests replay controlled stream states; the saved evaluation endpoint stayed real.
Phone 320/390px, tablet 768px, desktop 1440px, landscape panels, 200% root text,
touch galleries, shortlist save/remove restoration, reduced motion, waiting-state
feedback and late-result guards were checked. No page errors or final axe A/AA
violations were found. The initial harness needed selector/response-order fixes;
these were test-harness faults, and its completed search was retained as baseline
evidence rather than repeatedly issuing the same paid search.

361 unit tests, server/client typechecks, strict typing of the four new regression
files, production build and whitespace checks pass. The native user app was
observed idle before the normal server restart. Test-only fault/logging servers
are stopped at handoff; the normal app uses the user's original data folder.

## API accounting and limits

Isolated provider traces across the two live searches, follow-up checks and fault
scenarios, plus the three direct freshness comparisons, recorded 65 eBay requests
(including OAuth/usage), 210 pricing requests (including one real 429) and 161
OpenAI requests. Two additional failures were injected before a provider request.
Counts include title, discovery, comp and assessment work; they are not all full
photo analyses. Dollar cost and per-item pricing-credit cost were not measured.
No offers, bids, purchases or seller messages were sent.

Evidence is ignored local data under `data/reviews/neo-live-2026-10-30/`,
`data/reviews/neo-automatic-2026-10-30/` and
`data/reviews/neo-automatic-fault-2026-10-30/`. Physical phones and production
Core Web Vitals remain unmeasured. Internal design heuristics: usability 8.5,
hierarchy 8.5, accessibility/consistency/responsiveness/feedback 9, performance 8.
The next UI improvement is reducing the vertical space above cards on narrow
phones while keeping view choices and recovery status visible. Production
performance needs measurements with large searches; these scores are not metrics.

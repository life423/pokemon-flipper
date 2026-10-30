# Live API validation and correctness — October 30, 2026

The user explicitly authorized paid API usage and prefers real-API validation for
building the app. Developed on `codex/shortlist-discovery`, preserving the previously
implemented features. On October 30 the user authorized committing these changes,
merging them into `main` and pushing to GitHub. Consult Git for delivery status.
Deployment was not requested.

## Authentication failure

The checkout had no `.env`, and no configured key variables were present in the
process, user or machine environment. eBay token requests therefore failed with
401, while the UI only reported “Failed to screen listings.” The user supplied
`.env`. A new process authenticated and returned a real Charizard listing; the
development watcher restarted and the app responded on port 3000.

All four services were checked with the real configuration: eBay Browse, OpenAI
model access, pkmnprices and PokemonPriceTracker. Both pricing health requests
returned HTTP 200 with one row each. Key names match the existing `.env` contract.
No key values were printed, copied to reports or added to version control.
`.env` remains ignored; the user's local removal/rename of `.env.example` is
preserved outside the release, so the repository retains the blank setup template.

Missing eBay keys now fail locally before a network request. Rejected Production
key pairs share a one-minute failure cooldown, including concurrent usage/search
requests; a changed pair can retry immediately. Token response shape is validated
before a Bearer request is sent. Known configuration, provider timeout and reserve
messages reach the search UI, while arbitrary exception bodies remain hidden.

## Four audited correctness issues

1. **Fresh terms:** a fresh evaluation now ignores the browser's supplied price,
   shipping, bids, end date, title/photo hints and obtains current eBay details.
   A server-checked timestamp carries the authoritative snapshot into client
   repricing, cards and saved entries. A later selected refresh wins. Saving an
   old browser snapshot cannot undo newer locally verified terms.
2. **Title changes:** assessment reuse requires the saved title context as well as
   photos, model and prompt version. A changed title or legacy record without a
   saved title requires a new assessment. Matching current records still reuse
   their paid work.
3. **Comp-check labels:** failed, empty or partial AI verdict maps no longer imply
   every retained comparable sale was AI-checked. All retained sales must have
   an actual verdict. Existing deterministic filtering and prices remain intact.
4. **Concurrent evaluations:** identical requests share the entire evaluation.
   Different snapshots of one item serialize, then reuse saved AI work when it
   still matches. Successful and failed work releases both coordination states.
   Fresh requests with different stale browser values share the same current
   server evaluation.

There is no model migration, prompt change, fee change or relaxation of identity,
printing, qualification, photo or downside rules. Raw grading still uses two
condition assessments and keeps the more cautious valid result.

## Live observations

Evidence and harnesses are local ignored files in `data/reviews/live-2026-10-30/`.
The desktop helper failed to initialize, so live UI testing used installed Edge
through Playwright against the actual server. Provider responses were real.

- `1999 charizard` requested the existing 400-result search window and reused its
  eBay cache. The first run completed primary screening of 352 eligible listings
  at roughly 88 seconds. Extra discovery progressed but did not finish inside
  the three-minute test window. That run was bounded and remains recorded as
  incomplete, not a successful full discovery benchmark.
- A warm repeat completed primary screening in roughly 3.3 seconds, displayed
  335 listings, opened an analysis and saved a listing. Extra discovery was
  explicitly stopped for the sample. No automatic full analyses were enabled in
  this test browser. These timings do not predict cold searches or time to a deal.
- The first selected slab was an autographed/authentic-label Charizard. Its
  existing assessment was reused and it correctly remained NEEDS_REVIEW because
  that qualified label is not priced. This is not a confirmed deal.
- A separate raw-card probe evaluated `v1|920052711213|0` twice concurrently with
  deliberately stale browser prices of $1 and $2, an old title and old end date.
  Both callers received the same current $349.99 eBay snapshot. Exactly one
  successful paid photo check and two successful paid condition assessments ran,
  with one Browse detail request. No pricing request was needed because those
  responses were cached. The 4-photo sample finished in about 36.9 seconds and
  returned PASS; its estimated range was 4–8 with no likely grade supplied.
- The instrumented raw probe used approximately $0.0107864 of OpenAI tokens at
  published uncached rates. This is an estimate for that probe, not the total bill
  for the user's concurrent search or all live testing. The model's current
  [official pricing](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
  is $0.20 per million input and $1.20 per million output tokens. Pricing-provider
  credits are separate. No bids, offers, payments or seller messages were submitted.
- The corrected live browser run also performed paid **Reanalyze full listing**
  through the actual route with stale $1 request terms, displayed $349.99 in the
  analysis, and persisted the fresh snapshot. It then refreshed only that saved
  listing, retained the assessment and rendered it without horizontal overflow
  at 375px. Desktop rendering was inspected at 1440px. The final UI run reported
  no page errors. Its photo/condition calls used 31,186 input and 3,185 output
  tokens. The card remained PASS: its modeled 20.97% ROI was below the 25% target,
  and the photos also required human review because of glare and covered edges.

Nine named live workflow checks passed across the bounded search/save sample,
instrumented concurrency probe and corrected UI reanalysis/refresh sample. Service
health checks are separate. The earlier full-discovery timeout remains a limitation.

Two test-harness problems were corrected during the live pass: a hidden settings
dialog was selected instead of the visible analysis, and a default 30-second
response wait was shorter than the measured model run. The timed-out browser
request's server evaluation still completed and saved its result; it is not
reported as a successful UI transition until the corrected run passed.

## Regression and release limits

All 311 unit tests, both TypeScript projects, direct strict typing of the new
regressions and the production build pass. Regressions cover absent/rejected keys,
authentication recovery/cooldown, secret-safe errors, title invalidation, current
terms versus stale input, comp-check coverage, duplicate evaluations and saved
snapshot ordering. Live request counts complement those checks.

Discovery latency remains a measured improvement opportunity. This pass did not
remove useful checks or silently reduce the discovery budget to improve a timing.
Real condition estimates, comp matching and grading outcomes still require human
review; these observations do not establish valuation accuracy.

The app remains a local tool bound to loopback. It is **not ready for public paid
access**: accounts and paid-route authorization, a transactional reserve/settlement
ledger, enforced budgets for nested calls/retries/photos, durable jobs, safe shared
caching and payment/refill controls remain separate release work.

# AI throughput and Base Set verification — October 31, 2026

Local work on `codex/base-set-e2e-validation`, based on merged `78ef0c6`.
On November 1 the user authorized committing these changes together with the
existing-slab grader correction, merging into main and pushing to GitHub. Consult
Git for delivery status. The user's pre-existing `.env.example` deletion is
unrelated and remains excluded. Final combined verification is 446 passing tests,
both typechecks and production build; the live-run limitations below still apply.

## Current behavior

The user explicitly requested removing AI bottlenecks, allowing about 100
concurrent AI calls, and retaining a cap on eBay's daily requests.

- One shared 100-request AI ceiling replaces the smaller stage ceilings.
  Browser scheduling, title batches, main-photo checks, comparable checks and
  sold-copy reviews can use that capacity. Queued live work precedes historical
  condition reviews. Recent failures still reduce browser scheduling pressure.
- Historical photo review checks every eligible record in the returned sample,
  replacing the 12-copy cutoff. Raw and graded feeds still fetch up to 40 sales
  per printing/grade lookup, matching the selected recent-sales scope. This is
  a sample, not total market volume.
- Sold-copy assessment receives every available unique photo up to eBay's
  24-photo listing limit, replacing the former four-view selection.
- Concurrent listings of the same printing share a complete in-flight raw
  market-evidence job. Completed results are not retained by that sharing layer;
  existing provider freshness and unchanged-photo caches govern subsequent use.
- Discovery checks every eligible returned candidate, without the old 120-check,
  quarter-share or 24-unproductive-check cutoffs. Families remain interleaved.
- New-inventory scans screen all unseen matches in their 200-row eBay page and
  follow the user's full-analysis setting, without a separate five-analysis cap.
- Current slab comparisons inspect all eligible candidates in their targeted
  eBay page, replacing the six-detail/three-new-photo limits. Exact identity,
  printing, finish, grader, grade, shipping, seller and certificate checks remain.
- Focused raw review can use up to all 24 listing photos. Focused identity and
  Shadowless confirmation receive all relevant available views.
- Explicit user search/full-analysis settings, cancellation, schema/input-byte
  constraints and evidence requirements remain. Independent condition opinions,
  exact matching and fee/profit calculations have not been loosened.
- Price-provider pacing and shortlist eBay-refresh limits remain separate from
  AI throughput. The inline-image fallback retains a small download pool to bound
  memory use; it does not impose an AI-call or sold-copy sampling allowance.

## eBay allowance

Every actual Browse request reserves a daily call inside `ebayGet`, including
nested historical-photo access and current comparisons. Caller-side prechecks
cannot bypass that boundary. Cached reads, OAuth and Analytics do not consume
this Browse ledger.

An atomic ledger and short file lease are shared by local processes with the same
hashed application ID, under the OS temporary directory. Analytics observations
reconcile with the ledger's high-water count; stale observations cannot refill
spent calls. Requests and failures count conservatively. Invalid accounting fails
closed. Optional calls preserve the last 10%; all Browse calls stop at exhaustion.
The provider's reset is preferred, with a conservative 24-hour fallback when it
does not report one. Other applications outside this ledger remain visible only
through the provider's Analytics observations and its own enforcement.

Ended sold-copy photos can reuse their historical cache. This exception applies
only to historical inspection; current listings still refresh ended availability
and current quotes under their existing rules. It prevents repeated eBay calls
for unchanged historical photos while keeping market-price freshness separate.

## Credit exhaustion correction

The live rerun returned HTTP 429 with type `insufficient_quota`, code
`credit_balance_exhausted` and a no-credits-remaining message. The old handler
misreported this as a temporary rate limit and retried it.

It now returns `AI_CREDITS`, without retrying that paid request. A short account
failure circuit prevents queued calls from repeatedly hitting the empty balance;
it permits another probe after 30 seconds. Actual temporary network/server/rate
failures retain retry/cooldown behavior. The UI pauses automatic analysis, leaves
unfinished cards in Waiting, preserves completed assessments and exposes Resume.
No billing settings or account funding were changed.

## Verification and exact limits of the live evidence

- 441 tests pass; both TypeScript projects, production build and diff checks pass.
  Tests cover 100 active AI jobs, priority/FIFO ordering, slot release on failure,
  100 sold-copy workers, all 40 available copies, shared pricing jobs, discovery
  beyond the former cutoffs, permanent-credit versus transient retries, and
  independent instances racing for seven remaining eBay calls.
- Original live `1999 base set` run: 200-result search setting, All matching AI,
  $50 profit/25% ROI. Primary screening plus discovery completed 265 checks.
  There were 207 unique snapshots, 193 visible matches and 194 eligible analyses.
  It finished 30 full evaluations before the user requested the throughput change;
  the old queue was deliberately stopped and allowed to drain before restart.
  Visible counts then were Deals 0, Waiting 164, Review 15 and Long shots 0.
  Offline retargeting of those completed evaluations also found zero Deals at
  Any/Any. This is not a complete 194-assessment Deals result.
- AI began about 100 ms after the first streamed listing. The first listing
  arrived after 1.24 seconds. Preliminary above-target listings did receive full
  analysis. Independent cost/profit checks found no arithmetic mismatch.
- Fourteen temporary pricing tickets were automatically checked before discovery;
  thirteen became priced and no temporary tickets remained pending. A hard
  evidence gap is distinct from a transient lookup failure.
- Corrected PSA Venusaur item 257827112860, cert 51702940: Unlimited; 36 matching
  sold comps, $300 median, PASS at $350 asking, -$131.34 net and $182 default limit.
  At Any/Any its limit is $228 and it remains PASS. No Shadowless clue survives.
- A separate real current-listing probe found four photo-checked PSA 8 references,
  cheapest $325 delivered, followed by $331.76. The subject/cert was excluded.
  The active-only target is $308.75; the genuine sold evaluation retains $300.
  A controlled missing-sold UI scenario rendered this real evidence and recovered
  once from a controlled 503. It did not change the stored primary sold result.
- The upgraded live rerun stopped at 106 streamed results after the account
  rejected all 12 new AI transport attempts for exhausted credits. Four cached
  assessments completed. Successful live throughput at 100 and a final full-run
  Deals count therefore remain unverified until the account has credits.
- A controlled credit-pause UI test showed Waiting 1, Review 0, then Resume
  obtained the real cached Venusaur evaluation with zero new AI steps. Switching
  its targets to Any/Any changed the limit to $228 without another evaluation.
- Actual rendered checks cover 320×740, 390×844, 768×1024, 844×390 and 1440×1000.
  No horizontal overflow was observed. Close remains a visible 44×44 target while
  reading deep evidence; drawer filters now have 44-pixel heights. Tab remains
  within the analysis dialog and Escape dismisses it. No browser console errors
  were captured. These are browser viewport checks, not physical-device tests.
- User shortlist SHA-256 remains
  `A10AC88C9F78630EBC7F569F289BB6823ACECC6D8E99F32A758303DF07A734B5`.
  Ports 3017 and 3018 serve the updated app; port 3000 remains Ascend Avoid.

Artifacts are under `data/reviews/base-set-release-check-2026-10-31/` for the
baseline/comparison probes, and `data/reviews/base-set-throughput-check-2026-10-31/`
for the upgraded rerun, unit log, controlled credit recovery and final screenshots.

## UI review follow-up

Internal review heuristics: usability 9, hierarchy 8.5, accessibility 8.5,
consistency 9, responsiveness 9, feedback 8.5, performance 6 pending a funded run.
These are review judgments, not measured scores. Next priorities are to measure
funded end-to-end latency at the new ceiling, distinguish current-photo work from
historical-price work in each card's progress, group the long analysis into clearer
progressive sections, and complete full focus-cycle, zoom and physical-phone checks.

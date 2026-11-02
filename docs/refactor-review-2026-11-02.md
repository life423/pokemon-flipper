# Workflow organization refactor — November 2, 2026

The user requested code cleanup before more feature work, so the app can be
understood and its deal-finding workflows improved safely. This branch starts
from GitHub main `1681cf6` in `/Users/andrewclark/programming/pokemon-flipper`.
The two older local-only commits were preserved on
`backup/local-main-2026-11-02` before synchronizing main; they are not mixed into
this cleanup.

## What changed

| Original module | Before | After | Responsibility moved |
| --- | ---: | ---: | --- |
| `client/src/App.tsx` | 1,641 lines | 1,038 lines | Pure result selection, settings readers, labels, filters and target controls |
| `client/src/components/DetailPanel.tsx` | 838 | 126 | Financial, evidence, price, offer and assessment sections |
| `server/deals/find-deals.ts` | 315 | 127 | Per-listing screening and shipping checks |
| `server/pricing/graded-comps.ts` | 359 | 178 | Shared pure sold-evidence matching and summaries |

- `client/src/search/results.ts` exposes pure filtering, grouping, sorting and
  progress-count selectors. App retains the existing memo dependencies and
  network/queue/cancellation lifecycle. These selectors can be tested without
  rendering React or calling providers.
- `settings.ts` keeps the existing storage keys, defaults and failure behavior;
  `presentation.ts` owns search/usage wording; `SearchControls.tsx` and
  `TargetFields.tsx` own the controls and their existing event callbacks.
- `client/src/analysis-state.ts` removes the leaf components' type dependency
  on the App coordinator. App keeps a compatibility type export.
- `components/analysis/` contains six focused detail modules, using the same
  `DetailPanel.module.css`. Repeated resale-activity computation was reduced
  to one calculation. Offer draft/copy state remains in its section.
- `server/deals/screen-listing.ts` owns listing screening; normal search and
  discovery share it directly. `find-deals.ts` retains its existing exports.
- `server/pricing/sold-comps.ts` contains shared pure comp checks and summary
  calculations. Raw pricing imports these rules directly; graded pricing keeps
  lookup orchestration and compatibility exports.
- `docs/architecture.md` provides a workflow diagram, source map, reading order,
  safeguards and verification guidance. README links to it; AGENTS records the
  current Mac path and the user's equally prioritized three resale strategies.

All inspected server modules have consumers. CLI tools and historical reports
are also intentional entry points/evidence, so no files were deleted merely
because application code does not import them. This cleanup removes large
blocks from mixed-responsibility files rather than discarding working features.

## Preserved behavior

No fee, profit, ROI, grading weight, offer cutoff, evidence threshold, pricing
fallback, prompt, model route, cache/version key, request budget or provider
transport was changed. The search lifecycle, stale-response guards, cancellation,
shortlist persistence and initial assessment reuse remain in their existing
coordinator. No new dependency or polling/background job was introduced.

The extraction does not yet implement the user's 30–60 day resale goal or new
Buy It Now/auction strategies. It creates clearer boundaries for that next work.

## Verification

- Baseline: **456 tests**, both TypeScript projects and production build pass.
- Final: **465 tests**, both TypeScript projects, strict standalone typing of
  the new client tests, production build and `git diff --check` pass.
- Nine new practical selector regressions cover expired/unavailable/disproved
  results; Buy It Now minimums versus low auction bids; upper potential grades;
  slab/search criteria; conditional offers and the 10% cutoff; hidden/new groups;
  deal/evidence order; new-only progress; immutable inputs and zero fetch calls.
- Extracted screening, sold-evidence and search-selector function bodies match
  the baseline after their intended module/parameter substitutions. Existing
  targeted screening/pricing tests also pass.
- Vite SSR renders the original and refactored detail panel to identical HTML
  in ten cases: empty, loading, error, auction, Buy It Now, unavailable, existing
  slab, Best Offer, missing prices and saved deeper photo review.
- Four full App SSR cases also match byte-for-byte: defaults, Any targets with
  offers/grade/minimum price, capped AI/results with recent searches, and corrupt
  stored preferences. A fetch guard observed zero provider requests.
- These are static rendering and regression checks, not a new live browser or
  marketplace audit. Focus trapping, clipboard access, transitions and live
  provider behavior were not exercised interactively in this pass. Their existing
  hooks/handlers/styles remain unchanged. The build used the existing local
  dependencies; this refactor does not upgrade them.

Temporary before/after SSR output and harnesses live under `/tmp/pokemon-*-ssr*`
and `/tmp/pokemon-*-before.json` / `after.json`; they are not application data.
No AI, eBay or price-provider requests were made. No saved listing, assessment,
API-response cache, credential or quota ledger was cleared.

# Workflow cleanup — November 3, 2026

The browser already used bounded search and assessment, but older CLI commands,
tests and imports kept a second multi-stage pipeline alive. This cleanup makes
the active workflow easier to trace and removes those obsolete alternatives.
It is not a model change, a full UI redesign or proof of improved deal detection.

## Changes

- Search and Find new listings share `searchDeals` and one `findDeals` pipeline:
  one source page, local metadata screening, sold-price research, then at most
  50 admitted rows. Removed legacy broad discovery, unused `/api/dig`, automatic
  pricing recovery, dormant stream events and their unreachable client states.
- The single-listing CLI now uses `evaluateBoundedListing`, like HTTP and the
  benchmark. Removed the separate evaluator, repeated fresh-opinion command and
  old broad ten-search script. `evaluate --fresh` now fails explicitly before
  importing the evaluator or making provider calls; ordinary evaluation refreshes
  listing terms while retaining unchanged paid photo evidence.
- Removed unused full-photo/identity/second-condition/sold-copy request writers
  and their exclusive comparison, volume and recovery helpers. Current bounded
  raw/slab requests, focused deeper review, original request keys and models stay.
- Kept exact legacy version identifiers and record types in a small compatibility
  module and retained saved-evidence readers. Fixed an existing gap where saved
  identity corrections could be skipped when an old financial checkpoint was
  missing or expired. Reconciliation now reuses the paid correction; conflicting
  saved finishes remain blocked rather than starting another paid assessment.
- Removed dead hidden-view UI and obsolete progress branches. Existing views,
  queue/cancellation, manual controls, offer restrictions and budget reporting
  remain. Useful lifecycle/filter/slab/cancellation regressions now exercise the
  active pipeline instead of the retired implementation.
- Condensed project instructions to current invariants and updated the code map
  and README. Historical reports and the private roadmap remain available.

Fourteen source/CLI files and fourteen implementation-specific test files were
retired. The before/after import inventory decreased from 191 to 179 non-test
code files and roughly 19,954 to 17,481 source lines during this pass. Static
relative-import checks found no dangling imports or unreferenced source files.
Tests and type-only dependencies were counted when checking callers; being
absent from the browser import graph alone was not a deletion criterion.

The repository has no duplicated emitted JavaScript beside TypeScript sources.
`client/vite.config.js` and the `.mjs` launch/test scripts are intentional tooling.
Ignored dependencies/build artifacts are not redundant application source.

## Preserved limits and known boundaries

The persistent two-cent ceiling covers OpenAI generations sharing a search ID,
including concurrent/nested work and retained unresolved charges. Exact input
preflight and maximum output reservations still run before dispatch. The next
request can be denied below two cents if its maximum charge will not fit.

eBay Browse has a separate 25-request/search ceiling plus daily account quota
protection. PKMNPrices has an eight-uncached-request preliminary screening
allowance; returned rows determine credits. Later valuation is outside that
eight-request allowance. The two-cent ceiling does not cover marketplace quota,
price-data credits or optional catalog transports. No limit was raised or reset.

The manual pricing-retry consumer, endpoint and ticket UI remain compatible.
The bounded price-first path already did not issue new retry tickets before
this cleanup. Reconnecting a bounded explicit retry or retiring that surface
is separate work; no new recovery requests were added here.

Current search cost is not reduced merely by deleting code that HTTP did not
execute. The gain is one traceable assessment path and fewer obsolete ways to
start redundant work. Saved paid evidence and real accounting were not cleared.

## Verification

- 766 offline tests pass. Retired implementation-only tests account for the
  lower count; meaningful current workflow tests were preserved or migrated.
- Server/shared/scripts and client TypeScript checks pass.
- Production build and whitespace checks pass.
- Local page returns HTTP 200; storage readiness reports Azure SQL ready.
- No live eBay, PKMNPrices, OpenAI generation or token-preflight calls were made
  for this cleanup. Read-only SQL readiness is not a marketplace validation run.

This does not establish label/photo accuracy, a completed useful-deal benchmark,
universal cache freshness or a repaired deferred early-completion report.
Remaining product/strategy work stays in the ignored private plan and TODO.

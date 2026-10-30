# Result visibility and assessment audit — October 30, 2026

Developed on `codex/search-result-visibility` from `1b2eb12`. The user requested
finishing the audit and result visibility fixes, preserving behavior and testing
mobile. The user subsequently authorized committing these changes, merging into
`main` and pushing to GitHub. Consult Git for the resulting revision and remote
synchronization. No deployment was requested.

## Findings and corrections

- A search could find hundreds of listings while the initial Deals view showed
  an empty illustration. New keyword searches now start in All. An explicitly
  selected Deals view stays selected as results arrive; when empty it gives a
  compact found-listing count and a keyboard-accessible View found listings
  action. New-listing discovery still opens New listings.
- Generic UNSCREENED listings were absent from Review despite appearing in All.
  They now appear in Review. An analysis transport failure also goes to Review
  and carries an Analysis failed badge, instead of remaining under Waiting.
  Existing PASS, offer, long-shot and confirmed Deal classification is preserved.
- Incomplete-screening feedback was hidden until the whole search finished.
  It now appears during screening, with pricing retries disabled until search
  completion to avoid overlapping work. Retry eligibility, batch size, cooldown,
  server tickets and paid-analysis limits remain unchanged.
- Results distinguish completed AI photo reviews from screened-only listings.
  Completed progress reports actual check counts without claiming every planned
  check or every listing received a full assessment. Failed attempts are not
  described as successfully analyzed candidates.
- Restored the 44px touch minimum for result tabs, which had a 42px phone override.

No valuation thresholds, identity/finish/grade gates, photo prompts, fee settings,
cache invalidation, API concurrency or discovery budgets were relaxed.

## Assessment audit

Reviewed the path from seller-based screening through automatic eligibility,
full photo/condition or slab assessment, repricing and result grouping. Full
analysis is deliberately focused on promising candidates; hundreds of All
results do not mean hundreds of completed paid assessments. Missing comps and
unresolved evidence are not proof that the marketplace has no opportunities.

Recomputed all 37 available saved evaluation snapshots under Any/Any and the
default $50/25% targets: 74 scenarios. Checked supported purchase ceilings,
nonnegative Deal profit, identity/availability requirements, cost/profit
consistency (allowing one cent for independently rounded display values), and
lowest modeled grading outcome. No losing Deal emerged in these recalculations.
This checks internal consistency, not the accuracy of every model reading or
every marketplace comp.

The observed Neo Discovery Poliwrath 9/75 sample is identified as English,
1st Edition, holo. Photo assessment is Lightly Played, potential range 5–8,
likely 6. Its condition-matched raw quote is $84.99, asking price $145 and
unknown shipping uses the configured $7 assumption. Independently recomputed
fees/tax/shipping agree with its $98.43 loss and $54 break-even purchase limit.
Both grading paths stop at missing supported grade prices. The actual card UI
correctly says Raw rather than using the potential grade as a slab grade.

## Verification and API scope

- 346 unit tests; server/client typechecks; direct strict typing of the new
  result-visibility regression; production build and whitespace check.
- Earlier live Aquapolis run on this release: 18 browser checks including
  104 retained matches, real bounded pricing recovery, seller photos, assessment
  reuse, checked card details, phone/landscape layouts and five axe scans.
  Automatic full analysis was disabled for that search. In its retry window,
  seven pricing requests were observed: one relevant Nidoking request and six
  from a simultaneous user search. No eBay/OpenAI requests occurred in that
  retry window. Those concurrent calls prevent attributing the global total
  solely to the retry batch.
- Final visibility suite: 28 checks including seven axe scans, using the captured
  live Aquapolis stream for controlled UI states. Actual isolated-server
  shortlist save/remove, forged-ticket rejection and cached slab/raw evaluation
  endpoints remained real. Cancellation/delayed replies and pricing feedback
  used recorded pricing responses; they did not purchase another search batch.
- Checked 320/390px touch layouts, 768px tablet, 1440px desktop, a 320px analysis
  panel, 844×390 landscape, 200% root text, keyboard result navigation, failed
  analysis recovery, saved status, card details and reduced-motion behavior.
  No page errors or axe WCAG A/AA violations in the final suite.
- One supplemental test selected an uncached additional Aquapolis listing and
  used one real photo-check request (8,127 input and 1,508 output tokens). It
  stopped with blocked grading rather than inventing an assessment. Final reuse
  tests explicitly target the saved Nidoking and Poliwrath cases and report no
  new AI usage. Dollar cost was not measured.

Final tests run on port 3001 with copied caches and a separate data folder, so
their mutations do not affect the user's shortlist. Shared port 3000 was not
restarted during this pass. Its earlier review preloader has completed its
one-shot fault/recovery and no longer bypasses cache or injects failures; its
request logging remains until the next ordinary server launch. Future fault
tests must use a separate server/data directory from the user's active search.

Evidence scripts, JSON and screenshots are ignored local artifacts under
`data/reviews/result-visibility-2026-10-30/`; the preceding live evidence is
under `data/reviews/pricing-release-2026-10-30/`. The supplied PDF was no longer
available at its local path when extraction was attempted, so none of this
report claims to have reviewed its contents. No physical phone or production
performance measurement was performed.

## Conservative interface review

Internal heuristics, not measured quality scores: hierarchy 8.5, usability 8.5,
accessibility 9, consistency 9, responsiveness 9, feedback 9, performance 8.
Phone/tablet/desktop screenshots were visually inspected. The main remaining
UI improvement is reducing the vertical space occupied by the wrapping tabs,
query interpretation and status text on narrow phones, so the first card appears
sooner. Retain visible view choices and review/retry feedback when addressing
that layout in a separate focused pass. Performance needs production Core Web
Vitals measurement with large real result sets; passing these checks does not
establish those thresholds or subjective marketplace accuracy.

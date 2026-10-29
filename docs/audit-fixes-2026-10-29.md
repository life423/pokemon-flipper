# Audit corrections — October 29, 2026

Developed on `codex/audit-fixes` from main `294de80`. The user authorized
committing these fixes, merging them into `main` and pushing to GitHub on
October 29. Consult Git for the resulting revision and remote synchronization
status. Deployment was not requested.

## Pricing and evidence

- A missing grade cannot inherit a lower-grade premium when observed prices
  within the modeled range decrease with grade. That grading route is unavailable
  with an explanation. Fully observed nonmonotonic ranges still work, and an
  independently supported raw resale route can still qualify.
- The existing lower-grade fallback remains for nondecreasing observed ranges.
  It is a modeling assumption, not a guaranteed floor. Grade weights, configured
  fees, taxes, profit/ROI targets and printing safeguards are unchanged.
- Regression: the synthetic $1,000 purchase with grades 6/8 at $2,000/$1,000
  and no grade 7 now cannot be priced for grading. Adding supported grade-7
  sales at $1,000 produces PASS, -$214.50 and an $801 item ceiling. These are
  test inputs, not market valuations.
- Invalid and future-dated comparable sales are rejected. The past-only
  180-day window includes its exact endpoints.
- Client assessment reuse now includes the listing title and photo identity.
  eBay thumbnail size changes reuse the same evidence. Changed, reordered or
  removed photos invalidate the visible old assessment; late old responses
  cannot overwrite the current revision. A manually requested refresh waits
  for in-flight work for that listing rather than paying for parallel duplicates.
- Evaluation requests send title/photo hints solely to validate saved details.
  The server obtains actual image URLs from eBay; it never fetches these
  client-supplied URLs. Cached details compare search snapshots, with a compatible
  migration for old caches. A deliberate full reanalysis refreshes eBay details
  before rereading photos, even when current purchase terms were supplied.
- Unchanged title/photo evidence retains assessment reuse. The normal detail
  cache, eBay reserve, shared provider caps and optional-review protections remain.

## Workflow and platform corrections

- Stop reaches initial search pagination and the active Browse request. Search
  intent and discovery-plan cancellation also reach the AI request. Shared token
  acquisition and already-running full analyses retain their existing behavior.
- Stream parsing consumes a final record without a newline and requires an
  explicit terminal `done`. Early EOF retains partial results with an incomplete
  state. Failed searches no longer claim all candidates were checked.
- Lowering/removing a minimum Buy It Now price shows why excluded results are
  absent and provides **Rerun search**. No paid rerun occurs while typing. Auctions
  remain exempt from the minimum.
- Ctrl+K and programmatic focus stay inside a modal. Tab/Escape/focus restoration
  remain intact, including when reanalysis removes the previously focused button.
  The progressbar now has an accessible name.
- `npm start` uses a portable Node launcher that sets production mode before
  importing the server. It starts successfully on Windows.
- Compatible dependency updates: Vite 6.4.5, body-parser 2.4.0 and qs 6.17.1.
  Final `npm audit` reports zero vulnerabilities.

## Verification

Verified against the actual checkout at
`C:/Users/aiand/Documents/programming/pokemon-flipper`:

- 285/285 unit tests pass, including pricing, provider cancellation, cache
  freshness, byte-fragmented UTF-8 streams and final-record handling.
- Both TypeScript projects pass. The new/changed typed regression files also
  pass a direct strict TypeScript check; the normal project check excludes tests.
- Production build passes using Vite 6.4.5. Windows `npm start` serves the build;
  the development server serves its page and transformed entry module on a
  separate port.
- 35 browser checks pass, including 13 axe-core WCAG-tag scans with zero reported
  violations in the tested states. No browser page errors occurred.
- Browser cases include unchanged/resized/changed photos, price-only repricing,
  explicit reanalysis, disabled review actions, an older in-flight response, automatic refresh, unsupported
  grading prices, early EOF and HTTP failure, widened minimum-price rerun, Any/Any,
  potential-grade upper-bound filtering, persisted settings, Stop, deeper-review
  concerns, seller-note drafting and an intercepted eBay handoff.
- Results, analysis and filters were checked at 320, 375, 768 and 1440 CSS pixels.
  Phone cases used touch emulation. An 844×375 landscape case checked normal-motion
  closing; the other runs used reduced motion. No page horizontal overflow was
  detected. Closing restored background scrolling.

Local logs, browser JSON, screenshots and the browser harness are saved in the
ignored `data/reviews/2026-10-29-audit-fixes/` folder. No provider cache was cleared.
No live eBay/OpenAI/pricing calls or seller messages were made. The eBay handoff
was intercepted; no offer, bid or purchase was submitted.

## Limits and follow-up

This does not validate live inventory, upstream photo accuracy, real grading
outcomes, resale values, fee accuracy or Core Web Vitals. PSA fees and the grade
scenario weights retain their existing unverified/model-assumption status.
Automated accessibility scans are not a screen-reader audit or WCAG certification.

Internal UI review after these corrections: usability 8.5, hierarchy 8,
accessibility 8.5, consistency 8.5, responsiveness 8.5, feedback 8.5 and performance
7 (limited local evidence). These are conservative review heuristics, not measured
quality scores. Remaining recommendations are to move the optional deeper-review
action below the decision while keeping cautions prominent, selectively enlarge
the existing small touch controls, improve empty-result guidance and measure
real-provider timing/Core Web Vitals in a separately budgeted follow-up.

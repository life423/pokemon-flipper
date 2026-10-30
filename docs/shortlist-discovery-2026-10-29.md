# Shortlist, targeted refresh and new listings — October 29, 2026

Developed from main `4df4766` on `codex/shortlist-discovery`. The user requested
implementation, preservation of working behavior, reasonable API use and end-to-end
testing. On October 30 the user authorized committing these features and the later
correctness fixes, merging them into `main`, and pushing to GitHub. Consult Git
for delivery status. Deployment was not requested.

## User workflow

Save from a search card or its analysis. **Shortlist** holds up to 100 snapshots,
latest locally available assessments, 2,000-character notes and an optional personal
bid/purchase ceiling. Saving an unopened listing does not analyze it. Opening the
shortlist pauses further automatic queue starts; already-running analyses finish.
Filters on the search results do not hide saved entries. Notes are progressively
disclosed and provide saving/error feedback. Above-ceiling listings are flagged;
the personal ceiling does not alter the app's valuation or submit a bid.

Refresh one saved listing or select up to ten. A refresh obtains its current price,
shipping, buying options, bids, end time, seller, title, full photo set and reported
availability from eBay. Current terms reprice a matching assessment without another
model/pricing lookup. A fresh unknown shipping quote uses the existing conservative
shipping assumption instead of retaining old free shipping. If the title or photo
identity changes, the saved advice is cleared and **Analyze listing (paid)** is an
explicit next action. Thumbnail size changes alone do not invalidate photos.

Unavailable or ended listings retain notes and historical figures, but lose
buy/bid advice and paid reanalysis actions. Unknown availability is labeled for a
manual eBay check. Network failure preserves the prior snapshot and shows an error.
An in-flight refresh cannot restore a removed entry or overwrite concurrent notes.

After a search, **Find new listings** appends unseen inventory. **New listings**
shows that action's batch; previous results remain in the other views. This is a
bounded newest-inventory window, not a guarantee of complete eBay coverage.

## Request and persistence boundaries

| Action | Provider work / limit |
| --- | --- |
| Save, load, notes, ceiling, remove | Local JSON only; no eBay, model or pricing calls |
| Refresh | At most 10 selected IDs; at most 2 detail requests at once; same-ID single-flight |
| Repeat refresh | Successful check reused for 60 seconds across restarts; failure retry backs off 30 seconds in memory |
| Find new listings | One newest-sorted search page, at most 200 results; independent 60-second cache |
| Screening new inventory | At most 20 unseen eligible listings; existing title/photo/pricing caches and limits apply |
| Automatic full analysis | At most 5 per new scan, or the user's lower setting; only that scan's IDs enter the queue |
| More full analyses | Explicit **Analyze 5 more (paid)** through the progress panel |

Refresh and new discovery preserve the existing daily eBay reserve. Overlapping
equivalent new scans are refused. Stop propagates through the existing search
pipeline; emitted IDs survive cancellation. There is no timer-driven polling.
Screening itself can use paid title/photo checks, independently of the full-analysis
setting. No useful assessment checks or normal search discovery were removed.

`data/shortlist.json` and `data/search-history.json` are versioned local server
files, atomically replaced through serialized updates. A corrupt file produces an
error instead of being erased. Seen history is scoped by normalized query and
minimum Buy It Now price, bounded to 50 searches and 20,000 IDs per search. The
browser supplies at most 500 additional known IDs. No account sync, automatic
expiry or cross-process database locking is provided. Run one app server per data
directory and back up the files. `POKEMON_FLIPPER_DATA_DIR` permits isolated tests.

Saved financial evaluations come from a version-matching server record, never
client-submitted advice. Current cached full-photo evidence must also match before
an old evaluation can be saved again. Completed analyses and matching deeper
reviews update saved entries; target changes still recalculate locally.

eBay's [search documentation](https://developer.ebay.com/develop/api/buy) specifies
`sort=newlyListed`; its [Browse overview](https://developer.ebay.com/api-docs/buy/api-browse.html)
describes availability checks using end dates and estimated availability. Refresh
uses full details because this workflow must also compare photos.

## Verification and limits

Final actual-checkout verification: **74 browser checks pass, including 27
accessibility scans**, with no page errors. This includes 34 feature checks,
three analysis-budget checks, the delayed-note response, an actual server restart
and all 35 earlier audit browser checks. Evidence and harnesses are saved locally
under `data/reviews/shortlist-discovery-2026-10-29/` (ignored by Git).

- 298 unit tests, both TypeScript projects, direct strict typing of the new test
  suites, production build and whitespace checks pass. `npm audit` reports zero
  vulnerabilities; dependencies were not changed.
- Browser scenarios cover save without upstream work, browser persistence,
  notes/ceiling, selected refresh and cooldown, fresh unknown shipping, changed
  photos with explicit analysis, failures/backoff, unavailable listings, newest
  sorting, seen-ID exclusion before screening, cached repeat scans and the reserve.
- A 50-unseen-listing fixture produces batches of 20/20/10/0 from one cached
  search page and exactly 50 detail requests. A separate 20-candidate fixture
  proves five automatic full analyses, no cap bypass through saved settings and
  five further unique analyses only after the explicit paid action.
- Rendered Edge checks at 320, 375, 768 and 1440 CSS pixels cover shortlist,
  notes, saved analysis, overflow and modal keyboard/scroll recovery. Accessibility
  scans include WCAG 2.2 AA tags. Visual inspection caught and corrected a nested
  button-style collision, saved-note naming and an eBay link's small touch target.
- The earlier audit browser suite exercises existing search, filtering, pricing,
  stale responses, offers, optional reviews, keyboard containment and Stop.

Provider traffic was replaced with deterministic offline fixtures, with unexpected
upstream access blocked. These results establish application behavior and request
bounds, not live listing coverage, actual model accuracy or production Core Web
Vitals. No bids, offers or messages were sent.

## Design review

Conservative internal review heuristics, not measured quality scores:

| Dimension | Score | Evidence / next improvement |
| --- | --- | --- |
| Usability | 8.5 | Save/refresh/notes are visible and recoverable; consider a compact saved-list view after real usage demonstrates a need |
| Hierarchy | 8 | Existing detailed cards preserve familiarity but need considerable phone scrolling; measure the value of a concise saved-card summary |
| Accessibility | 8.5 | Automated scans, touch targets and keyboard checks pass; add a human screen-reader session before claiming comprehensive coverage |
| Consistency | 9 | Reuses existing cards, money math, tokens, modal and paid-analysis controls |
| Responsiveness | 9 | Actual 320/375/768/1440 renders fit without horizontal overflow; device-specific virtual-keyboard testing remains useful |
| Feedback | 9 | Save errors, refresh failures, history, stale photos, unavailable items and personal ceilings have visible text |
| Performance | 8 | Request-count and cache boundaries verified; measure real LCP/INP/CLS and image loading on representative connections |

Prioritize screen-reader and measured performance checks over visual polish.
No broad redesign was needed to implement these workflows.

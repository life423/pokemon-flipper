# Direct listing links — October 30, 2026

Implemented on `codex/listing-link-evaluation` from main `8f3ece2`. The user
requested direct evaluation of an eBay link, supplying item `267743966894`.
The user subsequently authorized committing the feature and UI changes, merging
into `main`, and pushing to GitHub. Consult Git for the resulting revision and
remote synchronization. No deployment was requested.

## Workflow

The existing search field accepts keywords or a listing link. Keywords retain
**Find deals**. A recognized link changes the action to **Evaluate listing · paid**.
Native paste works; dropping a link onto the
field fills it without automatically spending. Enter or the button submits it.
Once resolved, the field shows the canonical link with tracking removed.

The **Listing evaluation** workspace preserves previous search results. Current
eBay details appear in the existing analysis panel and the same card layout.
Analysis proceeds through the existing identity, photo, raw-condition, grading,
comp and deterministic money checks. Financial targets still apply; search result
filters, including minimum potential grade, do not hide this explicit listing.
Save, notes, personal ceilings, selected refresh and deeper review remain available
through the existing controls. Search automatic-analysis limits do not suppress
this manually requested single analysis.

An active broad search is stopped when a valid link is submitted, retaining its
loaded results. No broad search or discovery is started for the link. Existing
paid analyses already running finish as before. Repeated submission of the same
in-flight direct analysis cannot queue another evaluation. Cancel during detail
resolution prevents a late response from starting paid analysis; the already-sent
detail request can still finish. Failed input leaves the previous listing available.

## Inputs and provider boundaries

- Full HTTP/HTTPS `ebay.com/itm/...` URLs, including `www`, mobile, slugged paths,
  tracking queries and fragments. Scheme-less eBay.com links are supported.
- Bare 9–15 digit legacy item numbers and strict Browse IDs also work.
- Variations remain unsupported: use a listing for one actual card. Shortened
  sharing links and other regional domains need the full eBay.com item link.
- The parser validates the host, path, protocol, length and variation parameter.
  User information in URLs, custom ports, lookalike hosts and arbitrary URLs are
  rejected. The server repeats validation independently of the client.
- `POST /api/listings/resolve` extracts the item ID and calls the existing Browse
  client. It never fetches or follows the submitted URL. The existing full-detail
  cache then supplies the normal evaluation route, so there is normally one
  current detail request for a link, not one per step. Concurrent resolution
  shares the same item request. Successful full analyses retain existing reuse
  and concurrency protections.
- Variations/invalid input stop before provider work. Existing lot/proxy/product
  exclusions, availability, end-date and photo checks stop before paid analysis.
  Photo/identity safeguards still decide what a supported listing actually shows.
  Deliberate single-item checks use the same reserve policy as manual evaluation.

This remains a local app. Adding direct links does not implement public accounts,
credits, transactional billing or durable public jobs.

## Verification

All 318 unit tests, both TypeScript projects, direct strict typing of the new
tests, production build and whitespace checks pass. New regressions cover tracked
and slugged links, input spoofing, variations, current snapshot construction,
unsupported/ended/photo-less cases and provider failures.

Live evidence and harnesses are saved locally under
`data/reviews/listing-link-2026-10-30/` (ignored by Git). Provider responses were
real. The cancellation test held an actual server response to exercise a race;
it did not replace the response or the provider.

- **16 live browser checks**, including four WCAG-tagged accessibility scans,
  cover paste, explicit evaluation, tracking variants, assessment reuse, saving,
  invalid-host rejection, drop without auto-spending, normal keyword action,
  independent grade filtering, 320/375/768/1440px layouts, focus/scroll recovery
  and absence of page errors. Actual screenshots were inspected.
- **Four live error/cancellation checks** cover a canceled real detail response,
  independent server validation, variation rejection and a real eBay not-found
  response. No analysis was started after cancellation or failed resolution.
- **Three instrumented live request checks** prove that concurrent tracked links
  share one Browse detail request, evaluation does not fetch those details again,
  and repeated evaluation reuses saved AI work. That probe made only OAuth and
  one Browse getItem request, with zero OpenAI or broad search requests.
- The first live Mewtwo analysis used one photo check and two condition runs:
  21,808 input and 2,674 output tokens recorded by those three steps. Subsequent
  tracked-link evaluations returned empty AI usage, preserving the assessment.
  These step counts do not measure all possible title/comp/provider charges.

The supplied listing was active at $350 plus $6.40 shipping, with two photos.
The observed analysis returned PASS, HEAVILY_PLAYED, limited evidence, range 2–6
and no likely grade. Glare, perspective and bright spots required human review.
That is one model assessment and current-data sample, not a verified appraisal,
guaranteed grade or guarantee that the listing will remain available.

Visual review caught an overly broad heading selector and misleading button
accessible names. Styles now target only the new section heading, saved-button
names include their visible text, and responsive paid-action names match their
labels. Canonicalizing the visible link removes distracting tracking text.

## Conservative design review

These are internal review heuristics, not measured quality claims.

| Dimension | Score | Evidence / next improvement |
| --- | --- | --- |
| Usability | 9 | One existing input and primary action; explicit payment label, cancel and recoverable errors |
| Hierarchy | 8.5 | Clear single result and reused analysis panel; evaluate a compact summary if long card content impedes comparison |
| Accessibility | 8.5 | Four automated scans and keyboard/label fixes pass; add a human screen-reader session |
| Consistency | 9 | Existing tokens, cards, analysis, targets and shortlist behavior are reused |
| Responsiveness | 9 | Actual phone/tablet/desktop states fit without horizontal overflow |
| Feedback | 9 | Resolving, analyzing, failure, previous result, cancellation and paid action states are explicit |
| Performance | 8.5 | Request deduplication/reuse is measured; measure real Core Web Vitals and analyze latency on more listings |

Prioritize screen-reader review and representative latency measurements before
additional visual polish. No broad redesign or provider-budget reduction was needed.

## Discoverability follow-up

The user requested that link evaluation be obvious while keeping the UI clean
and responsive. The header now offers visible **Search cards** and **Evaluate
eBay link** choices above the shared input. Each mode remembers its own draft;
switching focuses the input, and pasting a URL still selects evaluation directly.
Contextual placeholder, help and empty-state copy explain the next action.
The paid evaluation button uses a separate full-width row on phones so the URL
remains editable. Tablet search uses a full-width row beneath the brand/menu.
The clear control is 44px and the duplicate native search-clear icon is removed.
Empty result filters/counts are hidden before the first search on all sizes;
financial targets remain accessible in Menu. Existing brand and tokens remain.

The follow-up live browser harness passed **19 checks**, including **nine
WCAG-tagged axe scans**, against the real local app and providers. It covered
320/375/768/1440px viewports, 844px landscape, 200% root text enlargement,
draft switching/focus, 44px controls, zero paid requests from typing or mode
changes, pre-search financial targets and the supplied live Mewtwo evaluation.
The completed analysis reused saved photo/condition evidence with empty AI usage;
no broad search/discovery request was made. No page errors were recorded.
Screenshots caught and corrected tablet input crowding, a narrow-screen paid
button clipping at enlarged text and brand text failing to wrap. Final phone,
tablet, desktop and enlarged-text screenshots were inspected. Evidence and the
reproducible harness are in `data/reviews/link-discovery-2026-10-30/` (ignored).
All 318 unit tests, both TypeScript projects, production build and diff checks
also pass. These viewport checks do not replace real-device or human
screen-reader testing; no production Core Web Vitals claim is made.

Follow-up internal review: usability 9, hierarchy 9, accessibility 8.5,
consistency 9, responsiveness 9, feedback 9, performance 8.5. Prioritize a human
screen-reader/real-device session, then measured production Web Vitals and
representative provider latency. These are review heuristics, not measured
quality scores. No further visual redesign is required for this request.

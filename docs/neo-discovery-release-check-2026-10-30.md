# Neo Discovery release check — October 30, 2026

Revision: `d7fd26f10aebb7599357847fa316478e0ed4cc43` on main.
Query: `neo discovery holo`. This run measured the actual Deals tab rather
than stopping at a five-assessment validation cap.

## Live result

Used the default 400-result fetch window, automatic overlooked-listing discovery,
Best Offers off, and **all eligible automatic assessments enabled**. The search
returned 385 live fetched listings; 314 entered primary screening, with 32 extra
discovery checks. After relevance/identity filtering, 155 listings remained in All.

| View | Any profit / Any ROI | $50 profit / 25% ROI |
| --- | ---: | ---: |
| Deals | **0** | **0** |
| Waiting | 0 | 0 |
| Review | 12 | 12 |
| Long shots | 8 | 1 |
| All | 155 | 155 |

Every eligible full-analysis candidate completed: **10 assessments**, comprising
eight reused photo assessments and two newly assessed listings. Other listings
were screened rather than receiving full paid condition assessments. Target
changes repriced these results locally without a second provider search.

First listings appeared after 2.66 seconds. The search/recovery stream completed
after 71.7 seconds; all eligible full assessments finished after 73.6 seconds.

Nine full assessments remained Passes at asking/current bid under Any/Any. For
example, Ursaring at $30.62 had an estimated $17.82 loss, while a $50 Scizor
auction showed a $30.07 loss after photo-based condition/pricing. Smeargle showed
$7.75 modeled profit at its $16 current bid, but remained a Long Shot because its
purchase ceiling was below the market reference and the winning price can rise.
It was not promoted into Deals just because its current bid was low.

These are app classifications under configured costs and evidence rules, not
proof that the broader market has no opportunities or that every screened-out
listing received a full photo appraisal.

## Automatic recovery

One controlled temporary comp-lookup interruption was introduced only on the
isolated test server. All subsequent successful responses came from real APIs;
no listing/price payloads were fabricated during the live run. The normal user
app at port 3000 was not fault-injected or restarted.

- The interrupted full-assessment pricing lookup succeeded after **30.013 seconds**.
- Nine temporary screening jobs resolved automatically: **seven became priced
  screens**, and two became genuine unavailable-data outcomes.
- Final temporary screening failures: **zero**. No manual `/api/pricing/retry`
  requests were made, and no eligible AI candidate remained waiting.
- All ten full evaluations returned HTTP 200. Saved photo work remained reusable.

The 12 remaining incomplete screens were six cases lacking verified exact-grade
sold comps, two missing grader/grade, two missing the required raw-printing price,
and two unresolved card identities. The latter titles included a Politoed with a
conflicting collector number and an Entei promo described as Neo Discovery.
Those remain unresolved rather than being assigned an unsupported valuation.

## Mobile and UI checks

Actual live results were checked at 320/390px phone, 768px tablet and 1440px
desktop widths. Supplementary checks replayed the completed real stream after
the harness encountered an ambiguous duplicate Any preset selector; a subsequent
harness variable-scope error was also corrected. There was no second market
search. The ten real evaluation endpoints reused their saved photo/condition work
with empty new-assessment usage arrays on each continuation.

The completed supplementary suite passed **14 checks including six axe scans**:
result layouts, both financial-target counts, zero temporary leftovers, automatic
recovery, touch gallery navigation, existing assessment reopening without another
evaluation, 320px and 844×390 landscape panels, reachable bottom actions, body
scroll restoration, 200% root text and reduced-motion behavior. No page errors or
axe WCAG A/AA violations remained. Result/recovery/panel screenshots were visually
inspected. Physical devices and production Core Web Vitals were not measured.

Internal review heuristics remain usability/hierarchy 8.5, accessibility,
consistency/responsiveness/feedback 9, performance 8. The highest remaining UI
improvement is reducing the space above cards on narrow phones while preserving
the visible recovery state and result views. These scores are not measured metrics.

## Scope and accounting

Provider traces recorded 23 successful eBay requests (including OAuth/usage),
25 successful pricing requests and 22 successful OpenAI requests, plus the one
injected failure before transport. Counts include screening/title/comp work and
the supplementary reuse checks; they are not counts of full photo assessments.
Dollar cost was not measured. No offers, bids, purchases or seller messages were
sent. Main shortlist/data files were not modified by the isolated tests.

Evidence scripts, provider metadata, JSON results and screenshots are ignored
local artifacts under `data/reviews/neo-release-2026-10-30/`. The fault/logging
server is stopped at handoff; the normal app remains available at localhost:3000.
No application-code changes were needed in this validation pass. The user's
market-history/forecast-score proposal was saved in AGENTS.md for later work.

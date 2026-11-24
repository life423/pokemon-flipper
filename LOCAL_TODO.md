# Pokémon Flipper — current to-do list

Updated November 10, 2026. This file is tracked at the user's request. It is the
current index, not a chronological work log. LOCAL_PLAN.md and dated docs retain
research details; Git retains earlier versions of this list. Credentials,
provider payloads, photos and data/ stay excluded. No computer handoff is pending.

## Immediate milestone: one verified Buy It Now deal

- [ ] Find one live, available BIN with the correct English card/printing/finish,
  supported resale value and positive net profit after all costs. Verify it
  reaches Deals through the normal workflow; never inflate values or relabel an
  unverified opportunity to meet a count.
- [ ] Measure how often below-market Buy It Now leads survive the photo and
  after-cost checks across different cards. Preserve the original listing IDs,
  asks, comparison sales and observation time in private validation records so
  a later rescan can explain every change in the count.
- [x] Show a Buy It Now competition check when an exact slab search retains no
  candidates. Compare the lowest checked delivered ask with the ceiling at that
  shipping cost. Reuse compatible saved slab evidence and distinguish it from
  matching eBay details. Keep the check inside the search's eBay allowance.
- [x] Validate the competition check through the app on Lost Origin Giratina V
  186/196 holo PSA 9 with a shipping destination configured. The November 9
  newest-first Any/Any scan returned zero under the $701.51 item ceiling. The
  lowest checked exact match by listing details was $859.99 plus $6.82 shipping,
  $165.30 above the $694.69 shipping-adjusted item ceiling. Five eBay Browse
  requests, zero new PKMNPrices credits and zero AI spend. This sample found
  no missed listing below the ceiling. The live Deal milestone remains open.
- [x] Pick a new liquid slab from cached exact sold activity and run one
  newest-first Buy It Now search with shipping and Any/Any. The November 9
  Scarlet & Violet 151 Venusaur ex 198/165 holo PSA 9 search showed Deals 0.
  eBay returned zero under $86.80. The lowest checked match by listing details
  was $119.27 plus $5.80 shipping, $38.27 above the shipping-adjusted item
  ceiling of $81.00. Five Browse requests, one PKMNPrices request (20 credits),
  and zero AI calls. This verified another empty price window in the browser.
- [x] Compare recent saved asks against exact sold prices before picking the next
  live target. The November 10 replay matched 352 Buy It Now asks across 76
  slab markets. None cleared purchase costs, even treating unquoted shipping
  as free for the replay. A separate older $169 Lugia V TAG 9 lead was a title
  mismatch: its slab showed 185/195 rather than the advertised 186/195.
  No live provider calls were made.
- [x] Sample one newest-first Buy It Now page of Evolving Skies PSA 9 slabs
  with destination shipping and Any/Any. The November 10 scan used one Browse
  request. The same page was replayed offline after correcting the diagnostic's
  cache reader to load native catalog variants. Of 196 screened, 97 had exact
  cached pricing and 88 were excluded on price. None supported positive profit
  at asking. The closest was Gyarados V 28/203 PSA 9 at $48 plus $5.99 shipping,
  with a $45.34 item ceiling and a modeled $2.86 loss. No new PKMNPrices calls,
  listing-detail reads, or AI calls. The 99 without exact pricing are unresolved.
- [x] Replay the 99 unresolved Evolving Skies PSA 9 rows and target the strongest
  17 listings across 12 card identities. Exact sold evidence projected losses
  for 13. One Pikachu 049/203 had a modeled $8.09 margin at a $65 reverse-holo
  resale, but current eBay details identified the $30 plus $5.99 listing as
  non-holo. No photo work and no Deals. The follow-up used 35 PKMNPrices
  requests (81 reported credits) and one eBay Browse detail request.
- [ ] Measure how often the automatic screen misses a market when the title's
  set and collector number agree with the catalog but extra title text obscures
  the name. Replay the targeted rows before changing matching rules. Keep
  genuine finish and printing ambiguity separate from those parser misses.
- [ ] Use fresh listing discovery and shared exact-market sold evidence to pick
  candidates before photo spending. Reuse original search accounts and accepted
  findings; inspect only decision-relevant candidates. Avoid another repetitive
  negative search matrix.
- [x] Apply a sold-based item-price ceiling before fetching newest Buy It Now
  inventory for an exact slab market. Four live browser scans found no listings
  under their ceilings, using four Browse requests, one PKMNPrices request and
  no new AI generation. This verifies discovery behavior and leaves the live
  Deal milestone open.
- [ ] Once a supported candidate exists, verify current price, shipping and
  availability, then check holder/grade or raw condition and printing. Confirm
  replay adds no duplicate photo charge and changed terms reprice correctly.
- [ ] Measure where promising inventory is lost: eligibility, missing prices,
  unresolved physical evidence, actual negative margin or a budget/queue stop.
  Keep genuine missing evidence separate from rejection.
- [x] Add a separate raw-to-grade research lane when exact raw sales are absent.
  Reuse exact recent graded sales, screen for a margin at a realistic non-gem
  grade after costs, then assess the actual copy. Keep estimated grade and
  completed-sale evidence separate; do not turn a research lead into a Deal.
- [x] Run a raw-only Shadowless Alakazam BIN search at Any/Any. All 50 retained
  rows lacked usable raw sold evidence; both relevant native provider pages
  were empty. No photos were purchased. Fix the known listing's separate
  printing issue: a readable card and agreeing title can correct an overstated
  seller field. The ended listing remains a historical example.
- [x] Complete one saved Arcanine candidate through current terms, reused photo
  assessment, one sold-copy review and a provider-blocked replay. It remains
  Sorting/CANT_PRICE because the reviewed LP+ sale supplies no accepted LP price;
  it is not a verified Deal. New AI cost 0.32264 cents; replay adds zero calls.
- [x] Test existing lowest-price discovery alongside newest-first under the
  original accounts. The Crown Zenith slab sample found no supported margin;
  the raw Mew follow-through cost 0.56404 cents, remained Sorting with no manual
  hold, and reopened free. No production second source or model change added.
  These diagnostics do not complete the verified BIN milestone above.
- [x] Validate the conditional lower-price pass through the live browser queue.
  Crown Zenith Galarian Gallery PSA 9 at Any profit and Any ROI found 122
  additional unique summaries and five additional assessment candidates.
  The completed run screened 151, excluded 98 on price, and assessed 19.
  Sixteen priced below break-even and three needed evidence. Deals stayed at
  zero. Both attempts shared one search account and used 3.41686 cents of AI,
  23 Browse requests and 141 PKMNPrices requests with 381 reported credits.

## November 9 audit repair checklist

The supplied bundle reviewed `dd789c2`. The priorities below reflect the
comparison against local `main` at `7c27270` and the working-tree cleanup.

### 1. Fix what can keep a viable listing out of Deals

- [x] Keep PSA and CGC grading routes running when an optional AI check on a
  sold raw copy cannot reserve its allowance. Mark raw resale deferred and
  keep the original accounting. Storage or ledger failures still stop work.
  Replay the same fixture with and without the denial. Both runs should return
  Buy and Grade when the exact graded sales support it. (Bundle finding 1)
- [x] Use the same protective-case rule in discovery and final identity.
  Accept ordinary cards advertised with a custom case and still reject custom
  cards and proxies. Replay the original fixture through evaluation.
  (Bundle finding 2)
- [x] Reprice preliminary screens with the latest known shipping, listing
  format and Best Offer terms. Replay the $70 slab with shipping changing
  from $100 to $0, and test the reverse change.
- [x] Carry structured condition and wear notes from eBay summaries into
  research priority when present. Treat them as seller clues. Verify the
  adapter with a mocked Browse response. (Bundle finding 4)
- [x] Keep Prismatic Evolutions and Evolutions distinct in queries and exact
  market matching. Test both cold and populated catalogs.

### 2. Make recovery predictable and prevent repeat charges

- [x] Give completed assessments with missing prices an explicit price-only
  retry. Reuse saved photos and the original search account. Bound the lookups,
  keep the previous assessment visible if refresh fails, and show a clear
  outcome when prices remain unavailable. (Bundle finding 5)
- [x] Stop new automatic assessments after a discovery stream error or early
  end. Cancel work safely, keep completed results visible, and keep Stop usable
  while work can still be cancelled. (Bundle finding 6)
- [x] Retain AI answers that fail semantic validation with their request and
  failure reason. Reuse that record on repeat requests and preserve any prior
  valid answer. Cover the file backend and SQL replay. (Bundle finding 8)
- [x] Drain accepted response and ledger writes on shutdown before closing
  storage. Test restart and timeout with unresolved claims preserved.

### 3. Verify Deals through the normal workflow

- [x] Run mocked profitable, losing, missing-price and interrupted searches
  through the real stream, evaluation and result grouping. Include the raw
  grading regression and one exact slab. Verify a replay adds zero paid
  requests and that Stop and price expiry work in the mounted app.
- [x] Record the targeted live Pikachu ex 238/191 PSA 9 Buy It Now scan.
  Exact sold evidence set a $166.60 item-price ceiling at Any profit and Any
  ROI. eBay returned zero listings under that ceiling. The scan used one
  Browse request, four PKMNPrices requests and 23 reported credits, and zero
  AI calls. No listing advanced to availability or shipping verification.
  The live Deal milestone stays open.

### 4. Finish the supporting audit work

- [x] Use corroborated photo evidence for the displayed raw or slabbed status.
- [x] Update sold-sample wording to reflect the current paging bounds. Use the
  current holder values in fixtures that exercise corroborated identity.
- [x] Align the diagnostic benchmark with the app's current text stages and
  photo settings. Extend saved replays to cover missed candidates where the
  necessary evidence was recorded.
- [x] Connect explicit deeper photo review to current saved assessments using
  original photos and the original search account. Repricing restores the
  saved review and preserves material photo concerns.
- [x] Verify a production-only install and add a build and test
  workflow. Keep public authentication and shared quota accounting on the
  release checklist.

### Follow-up validation and discovery

- [x] Separate discovery coverage from the 50-row display limit. The same
  fixture went from zero candidates after the first 50 unresolved rows to three
  supported candidates in 54 screenings, using one mocked Browse page and no
  provider calls. Four unresolved rows exceeded the display and six were left
  unscreened after reaching the candidate target. Retained rows keep their reasons.
- [x] Save screened overflow IDs, the completed screening stage and stable
  stopping reasons under the original search ID. Distinguish missing evidence
  from otherwise eligible rows beyond the display limit. Keep old count-only
  diagnostics readable. Benchmarks preserve these rows on replay.
- [x] Offer a marketplace Lowest price first mode alongside Newest first.
  The local Sort results control remains separate. The new option reuses the
  bounded Browse path and reserve. Find new listings still scans newest first.
- [x] Use a usable USD shipping quote for the configured US destination. Treat
  confirmed zero as free shipping. Keep potentially profitable Buy It Now
  listings with unquoted shipping in Sorting with a provisional estimate and
  an option to refresh terms. Offline raw and slab examples cover both outcomes.
- [x] Correct an erroneous seller set claim for a raw card when the literal
  title, high-confidence photos, full collector number, finish and exact
  catalog variant agree. The original Blastoise 2/102 and Base Set 2 Blastoise
  2/130 still price separately. Conflicting physical evidence remains unresolved.
- [x] Normalize clear affirmative reprint observations from saved photo
  evidence. Preserve visible marks across staged photo passes and recheck old
  saved Deals without new photo calls. Negative, unreadable and conflicting
  observations cannot establish a printing on their own.
- [x] Recover missing prices under the original search account without a new
  photo call. Separately verify an optional sold-copy AI allowance stop still
  permits independent Buy and Grade evaluation. Storage and ledger stops keep
  failing closed.
- [x] Stop saved-only benchmark misses before provider reservations. Replay
  the 50-row Tyranitar report: 112 unique listings were loaded originally, 50
  reached sold screening, 22 were eligible for photos and 28 lacked usable sold
  evidence. All four saved assessments replayed, two still lacked cached price
  evidence, and zero Deals resulted. Replay sent no provider requests, changed
  no quota counters, and spent $0. The older report cannot account for each
  unseen row individually.
- [ ] Expand saved baseline comparisons to record source and screening counts,
  exclusions, unresolved reasons, final classifications and provider spend for
  the 50-row overflow, Blastoise, a real loss and a supported profitable case.
  Freeze minimal inputs, settings and evidence versions in private storage so
  later cache refreshes cannot erase the reason a listing stopped. Use Giratina
  for the live-market price gap and the profitable fixture to exercise Deals.
  The offline search fixture now covers Deals, Projected losses and Sorting
  with identical inputs on replay and zero additional paid generations. The
  benchmark records screened overflow and the change in eBay Browse requests,
  PKMNPrices requests and credits, and AI spend for each run.
- [x] Show per-listing reasons for rejection and for rows never screened after
  finding enough candidates. Keep screened overflow separate. Persist coverage
  under the search ID, mark older records with incomplete coverage, and leave
  listings outside eBay's returned pages unclassified.
- [ ] Add per-buyer destination preferences when account settings are ready.
  Verify address-specific quote selection and invalidate only the affected
  purchase terms when the destination changes. Preserve reusable photo evidence.
- [x] Run one approved newest-first Buy It Now scan for Evolving Skies Rayquaza
  V 194/203 holo PSA 9. eBay returned zero listings under the $311.41 item-price
  ceiling. The completed diagnostic recorded one Browse request, three
  PKMNPrices requests (22 reported credits), and zero AI spend. The verified
  live Deal milestone remains open.
- [x] Use the collector numerator in exact-slab Browse queries while keeping
  the full identity and sold-derived ceiling. Offline coverage admits `#194`
  for verification and rejects a wrong set, a wrong denominator and an
  above-ceiling price. Prefer the median of up to five recent matched Buy It
  Now sales when at least three exist within 30 days. Show sale formats in
  comparison evidence. Saved Rayquaza evidence models a $323.23 ceiling with
  the new estimate and the same costs.
- [x] Run one newest-first Buy It Now scan for Lost Origin Giratina V 186/196
  holo PSA 9 at Any profit and Any ROI. eBay returned zero under the $701.51
  item-price ceiling. One Browse request, three PKMNPrices requests
  (22 reported credits), and zero AI generation requests.
- [x] Compare the cheapest current exact Giratina PSA 9 Buy It Now listing
  with the $701.51 ceiling. The lowest verified ask was $859.99 plus $6.82
  destination-quoted shipping. A wider search found no cheaper exact match.
  The app modeled a $178.92 loss at its $899.99 resale estimate. This was a
  market price gap. The cross-check used four Browse requests and no AI calls.
- [ ] Add a narrow sold-title normalization case for the observed `Pokemon Co.`
  publisher prefix. It excluded one otherwise plausible Rayquaza comparison
  without changing the five-sale median.

## Deal debugging and earlier audit fixes

- [x] Keep current eBay purchase terms ahead of older snapshots, separate
  printing prices, block purchase advice for explicitly unconfirmed availability,
  and make drawer opening free. Cancel detail work when its last consumer stops
  and share duplicate Browse work. Retain readers for accepted legacy evidence.
- [x] Use immutable image input for deeper photo review. Keep a first-photo
  multi-card finding through later assessment stages. Preserve the eBay quota
  lock during suspended processes and let SQL-backed paid work retry after a
  confirmed provider rate limit.
- [x] Reconcile contradictory First Edition stamp and artwork-shadow readings.
  Count distinct seller photos in the disclosed-wear check, reject malformed
  slab grades, and block pricing when strong photo identity disagrees with the
  seller. Reuse accepted photos on re-evaluation.
- [x] Apply new seller wear disclosures when repricing saved results or
  refreshing the shortlist. Block Best Offer recommendations for suspected
  creases using the same photo evidence as the buy decision.
- [x] Reject invalid maximum prices and malformed provider responses before they
  can produce a broader search or a false empty result. Keep unrelated cards
  out of seller-title raw comparisons. Reuse the app's eBay link parser in the
  evaluation CLI and retire the duplicate.
- [x] Expire old pricing in open tabs while preserving photo evidence. Refresh
  explicitly, protect edited shortlist fields from stale responses, and remove
  unreachable auction rendering from the Buy It Now detail view. Keep sales at
  a neighboring grade out of the exact-grade liquidity count.
- [x] Replace paid offer notes with a local draft and apply the Best Offer
  preference to the result and detail views.
- [ ] Follow up on other findings from the source audit.
  - Normalize reprint marks, reject malformed collector fractions, and account
    for condition clauses with independent negation. Use semantic finish claims
    to invalidate old pricing when eBay specifics change.
  - Give automatic diagnostic reviews a bounded retry after a confirmed failure.
    Preserve the original accounting scope and unresolved holds.
  - Preserve historical rate snapshots when changing AI prices or retiring models.
    Define SQL retention by data type with protection for paid and unresolved work.
  - Use transactional shortlist and history writes and shared provider quota
    accounting before running multiple processes or machines.
  - Exercise SQL-backed spend and retry accounting through the full transport
    path. Reject corrupt image bytes before paid dispatch.
  - Verify storage-import freshness ordering and add repeatable browser coverage
    for shortlist edits.

The [November 8 search audit](docs/deal-search-audit-2026-11-08.md) preserves
the PDF findings, the 50-row reconstruction, the browser checks and the live
Mew ex replay.

- [x] Explain skipped retained listings with the queue's own reason and report
  loaded listings and completed assessments separately. Reconstruct the
  original Blastoise search from surviving evidence and record 12 unknown rows.
- [x] Exercise a profitable, losing and blocked Buy It Now fixture through
  the real browser queue with mocked endpoints. Run one live Mew ex search.
  It reached zero Deals. The saved replay recovered 28 additional price
  exclusions before photos.
- [x] Run a text-only OpenAI review on the saved Crown Zenith diagnostic and
  have Codex verify its proposed tasks. The review cost 0.04358 cents under the
  original search cap. Of 322 unique summaries, 171 did not reach sold-price
  screening; the saved run cannot break down their individual exclusion reasons.
  Of 50 retained rows, 31 lacked usable sold evidence and 19 were assessed.
- [x] Save the completed search's retained listing decisions, funnel totals,
  provider usage and original search ID. Run one automatic text review with
  separate usage accounting and save numbered listing references for
  Codex. Keep up to 50 recent scans for 30 days.
- [x] Use the automatic review on a live Crown Zenith Gallery PSA 9 search.
  Of 151 screened, 103 were excluded on price and 48 remained. The 19 priced
  listings projected losses. The review identified 20 unresolved markets.
  Fix the short Gallery title and GG collector-number alias. A cache-only
  replay ruled out Suicune, Adaman and Gardenia before a photo charge using
  exact sold prices. Roxanne's exact 180-day provider lookup returned zero
  confirmed transactions. The review cost 0.03253 cents separately.
- [x] Run a broad Scarlet & Violet 151 PSA 9 check. Of 134 screened, 34
  were excluded on price. The 50 retained rows did not reach photos. The
  automatic review prioritized matching, and a replay recovered 11 names
  from release-code and illustration-rare title abbreviations. Replaying
  all 50 retained rows with cached prices yielded three verification leads
  and zero supported preliminary margins. The live review cost 0.03286 cents.
- [x] Replay the two Unlimited Mewtwo examples with saved photos. A clearly
  observed artwork-frame shadow can settle ordinary English Base Set printing
  even when the stamp area is unreadable. Keep the Machamp exception, actual
  printing conflicts and reprint checks. A third Mewtwo has an assessed raw
  condition and an unresolved price. Its back-photo limitation stays in notes
  when there is no actionable manual grading task.
- [x] Inspect the $45 Mewtwo example that had no positive shadow finding in
  the saved assessment. The original photos show the Unlimited frame shadow
  and repeatable scratches. The only positive preliminary comparison assumed
  Near Mint. Update the raw prompt's instructions for the actual frame edges
  and repeatable surface marks. Reuse existing paid photo answers unchanged.
- [x] Trace the $80 Unlimited Mewtwo with six reviewed photos. The saved
  assessment recognized the English Base Set holo and marked both printing
  clues inconclusive. Explain that distinction on saved results. Reserve
  further artwork-edge review for listings where resolving printing can
  change the purchase decision.
- [x] Run the raw `Blastoise Base Set 2/102 Holo` Buy It Now query at Any/Any.
  It resolved the original set, retained 50 from 199 unique summaries and
  completed 35 photo checks. The test runner stopped the queue after 230 seconds
  with seven waiting and no Deals or automatic report. The settled search cost
  was $0.0832618 for 24 new photo requests, with 25 Browse and 17 PKMNPrices
  requests. Inspected all 35 saved outcomes without provider calls. Two listings
  had a positive shadow reading blocked by the phrasing of the negative reprint
  observation. Both now resolve to Unlimited from saved evidence, and cases
  where the reprint area was cropped still require evidence.
- [x] Replay the saved raw Blastoise admission and audit its sold-copy evidence.
  The $649.99 listing ($661.99 delivered) was queued because any available raw
  sold evidence admitted it despite its low priority. The highest recent
  matched raw sale was $277.05. It now stays in Sorting without automatic paid
  photos. The raw sold sample returned 40 records. Of those, 32 passed title
  and sale checks, two had accepted Damaged photo evidence, six saved reviews
  were inconclusive, and one had unavailable or unusable photos. Final pricing
  now explains the gap and skips a new sold-photo check when the remaining
  relevant sale amounts cannot meet the user's targets. Saved photos remain
  reusable if the targets or purchase terms improve.
- [x] Check the first Buy It Now photo before sending other views. Stop for
  a supported slab loss or decisive front identity/authenticity evidence.
  Reuse saved front observations after a price change or cancellation.
  Keep grading possibilities open when raw front wear alone cannot price
  the whole deal. Validate the dispatch order with provider mocks.
- [ ] Finish auditing other raw Blastoise stops. Separate genuine printing
  conflicts from photo errors, and preserve explicit anniversary marks even
  when the model does not mark the entire listing a mismatch.
- [ ] Add a replay covering listings excluded before the retained batch, using
  their own decisions and evidence versions instead of inferring why they stopped.
- [x] Keep `Base Set 2/102` in the original market through reprint screening,
  title parsing, saved title reuse and final identity. Explicit Base Set 2 and
  Base Set II remain separate.
- [ ] Resolve remaining market identity examples using exact catalog evidence.
  Start with `Bubble Mew`, `Special Illustration`, and `Contender`.
- [x] Keep usable sales from later printings when an earlier market cannot
  finish. Incomplete scopes remain ineligible for price exclusions. Both
  catalog orders now preserve the same matched sales under simulated deferral.
- [x] Let a readable slab label, agreeing title and exact catalog match
  outweigh a conflicting seller Card Name field. Saved PSA 9 assessments
  repriced Mew GG10 and Cynthia’s Ambition GG60 at projected losses of $59.62
  and $30.40. Conflicting names and grades still went to review. The replay
  used saved photo, catalog and sold evidence without paid provider calls.
- [ ] Test a focused slab-label follow-up when an unexamined photo could supply
  the grader, grade or certificate and matched sales could support a positive
  margin. Magmortar GG03 is a negative example: its PSA 9 scenario would
  still lose money, so a new photo call was not justified on that evidence.
- [ ] Document local reproduction and refresh the tracked environment template
  to match port 3017 and current settings. Preserve the loopback API boundary.

## Working foundations to preserve

- [x] Default to Any profit and Any ROI while requiring positive net profit.
  Preserve explicitly saved targets. Use matched eBay sales for raw pricing
  and ignore unsupported estimates from saved results.

- [x] Shared Azure SQL Basic provider/assessment caches; persistent per-search
  OpenAI and provider request accounting; exact input/output reservations;
  cancellation and accepted-response saving.
- [x] Local AI spending runs uncapped with usage recorded. The queue checks all
  eligible listings in automatic mode. Maintain 100 actual eBay Browse requests
  per new search and 128 uncached screening/256 all-stage PKMN requests.
  Provider ledgers retain their limits and spent/unknown counts. PKMN's 20,000
  daily credits and eBay's daily quota are separate from AI dollars. Daily
  depletion warnings exist. Fresh installs still require operator setup.
- [x] Up to 200 source summaries per discovery pass and 50 retained matching
  rows. Buy It Now searches start newest-first and can add one lower-priced
  pass when fewer than three candidates clear preliminary financial screening
  and inventory remains. Both passes share sold research and deduplicate rows.
  Listing format, raw/graded and purchase-price controls remain visible. Search
  is English-only, with a fixed next-12-hours window for automatic auctions.
- [x] Shared sold-price screening before photos, confirmed transaction filters,
  bounded sparse pagination, safe legacy cache/cursor reuse and exact graded
  matching. One applicable sale can support sparse research/LOW-confidence
  prices; three sales are not a universal admission requirement.
- [x] Separate compact slab-label and combined raw-photo paths, accepted-answer
  reuse, explicit deeper review, at most three adjacent raw grade possibilities
  when supported, and both PSA/CGC comparisons.
- [x] Raw resale reads accepted sold-copy conditions first, then permits at most
  one relevant bounded acquisition. Negative observations are reused. Seller
  labels and other estimates stay out of the raw price. A supported lower
  condition can establish a conservative profitable route.
- [x] Audited cents-based money calculations, tax-inclusive fee bases, target
  limits, realistic optional offers within 15% of asking, and price-only versus
  physical-review states. No automatic purchase, bid, offer or seller message.
- [x] Long-shot code/hidden-find buckets retired; All matching, Sorting and
  honest paused states retained. Prominent eBay action, default-open gallery,
  original-image zoom/pan/keyboard controls, listing dates and favicon supplied.
- [x] Caller-proven orphan paid photo writers/exclusive tests removed while
  preserving accepted keys and legacy readers. Current source is TypeScript;
  retained JavaScript build/tool configuration is not automatically legacy code.

## Pricing accuracy and economical evidence recovery

- [x] Weight newer exact sales for resale estimates. Use the average of the
  four newest distinct matched transactions when all closed within 48 hours.
  Show the newest pair versus the prior pair when their order is known. Keep
  the observed range and the existing identity, condition and sale checks.
- [x] Allow prices up to 15% over the preliminary slab purchase limit through
  verification. Preserve actual targets and take the cheapest pass's supported
  candidates ahead of newest listings that only qualify for the buffer.
  Cache-only replays admitted 15 buffered Crown Zenith rows and two buffered
  Scarlet & Violet 151 rows. Neither replay found a supported preliminary margin.
- [ ] Use the lowest trustworthy, available Buy It Now total for the exact
  card, printing, finish, grading company and grade as a competition reference.
  Start with saved label assessments and fresh, available listing terms with
  known shipping. Deduplicate relisted slabs and expire the comparison using
  the terms check time. Use matched completed sales for resale value and
  activity; show the cheapest verified delivered ask as competition.

- [x] Audit other ways matched evidence and profitable results disappear. Keep
  the raw resale route open when a lower-condition estimate or grading falls
  short without matching raw sales. Parse anchored cert/condition wording on
  sold slabs and follow the existing page budget past saved vetoes. Normalize
  set prefixes and Nidoran gender symbols in the final results filter. Saved
  replay reached Deals for a historical auction; a live BIN is still unverified.
- [x] Share the existing literal collector-number parser and recover numbered
  slab publisher wording with a plain partial #number, numeric grade and mapped
  release. Preserve promo codes/unknowns and full-fraction-only rarity rules.
  Live Evolving Skies rerun excluded 66 rows versus 21 initially; no paid AI.
  Exact Medicham/Rayquaza examples reject losing asks. All 1,049 tests pass.
- [x] Recover numbered four-word printed names in the existing literal reader.
  Real Palkia/Dialga slab markets now reach price research; neither saved ask
  supports a profitable median, so no photo check was purchased. Preserve
  unnumbered behavior and unknown words. Fix the holder-note regression exposed
  by the full suite; all 1,048 tests, typechecks and build pass. SQL replay is free.
- [x] Reconcile observed CRZ, Holo UR and split Galarian Gallery metadata in the
  existing name cleaner with written release/full GG number/numeric slab anchors.
  Saved SQL replay excludes five more overpriced slabs with zero provider/photo
  calls. Special labels, printed forms and omitted-set uncertainty survive;
  1,046 isolated tests, typechecks and production build pass. No Deal claimed.
- [x] Keep First Edition/Unlimited/Shadowless research separate even before final
  valuation. Ambiguous or query-only markets no longer supply preliminary profit,
  ceilings or positive financial priority. Retain references/identity research;
  saved money and local retargeting share the same scope check. No paid rechecks.
- [x] Revalidate identity when Edition/Features/Printing specifics change or
  disappear before reusing financial advice. Preserve accepted photos; protect
  legacy/private evaluation and shortlist refresh/resave from stale reuse.
- [x] Consolidate title-based special slab/parenthetical qualifier checks across
  screening and final prices. Reject contaminated saved graded comparisons
  without invalidating paid photo answers or bumping all valuation versions.
- [x] Recover catalog pricing for observed parenthetical Secret Shining labels
  without erasing printed Shining forms. Anchored Sun & Moon publisher metadata
  now reaches exact sold screening. The saved 25-row Mewtwo replay excludes 21
  overpriced rows with zero provider calls; full 1,033 isolated tests pass.
- [x] Explicit query printing/finish narrows research when seller claims omit
  them, without turning requested identity into confirmed metadata. Broad
  queries retain plausible scopes. Cached intent/keywords cannot silently add
  an edition or substitute holo/reverse/non-holo. Saved 50-row Fossil replay
  removes 25 incorrect positive priorities with zero provider calls. All 1,028
  isolated tests, typechecks and build pass; paid photo records are unchanged.
- [x] Use one correction-aware duplicate-sale rule across acquisition,
  screening, raw and slab pricing. Honor provider revision timestamps and newer
  retractions; do not choose the highest amount or best target fit. Pricing
  revision 14 retains paid photo versions. All 1,024 isolated tests pass.
- [x] Replay 12 intent phrases and fix free parsing of spelled-out slab grades
  and spaced "Reverse Holo Foil" or "Non Holo Foil" wording.
- [x] Run a single bounded text check on saved catalog candidates. It identified
  Moonbreon, abstained on the sleepy Mew description, and left both broad
  controls open. Cost $0.0001202 with a free replay.
- [ ] Validate catalog candidate retrieval for nicknames and descriptions.
  The current bounded text assistance only cleans up phrasing. Preserve typed
  filters and broad searches, measure correct listings reached and photo calls
  avoided, and treat delivered-price phrases as separate constraints.
- [ ] Review bare OC/MC/Error qualifier wording consistently across sold
  screening and final pricing, while preserving ordinary seller lot suffixes.
- [ ] Finish bounded sparse-market recovery: exact recent sales, labeled older
  matches, verified active competition, then explicitly estimated alternatives
  if useful. Adjacent-grade/similar-card ratios need provenance, uncertainty and
  validation; estimates must not silently become confirmed sold evidence.
- [x] Remove individual-profit selection from raw sold-copy acquisition. Gate
  useful research by condition cohort, then review its newest unreviewed sale
  even if that sale loses money. Accepted losing evidence completes a rejection;
  no favorable replacement is purchased. All 1,032 isolated tests pass, with
  saved photo keys, valuation version and spending limits unchanged.
- [ ] Evaluate remaining raw-comp sampling uncertainty: seller-clue cohorts and
  one accepted observation are not an unbiased condition market. Preserve
  reviewed negatives and original charges; avoid repeating fresh valuations
  until a favorable comparison creates a Deal.
- [ ] Investigate targeted recovery of unknown transaction amounts only when it
  can change a candidate decision. Prefer provider corrections; use AI extraction
  only when a source establishes sold state, listing ID, currency and actual
  final amount. Cached bids/asking prices and model guesses are not confirmation.
- [ ] Store normalized long-term sold observations in SQL beyond cached API
  responses: IDs, printing/finish/language, raw condition or grader/grade/tier,
  amounts/currency, source and sold/ingested/updated times. Add incremental
  ingest, updates/corrections, deletion reconciliation and coverage tracking.
- [ ] Retire the remaining seller-title-only raw final-price compatibility path
  after the accepted physical-condition route covers its useful behavior.

## Search, photo quality and automation

- [ ] Improve equivalent-query/catalog interpretation and useful natural phrases
  while preserving card forms/owners, printing, set, number, language and finish.
  Holo, reverse holo and non-holo must remain distinct throughout.
- [ ] Resolve demonstrated residual descriptors using real catalog context;
  preserve unknown words, explicit release conflicts and grading qualifiers.
  Remaining examples include seller-title Secret Shining residue and MewTube;
  the catalog suffix, anchored Sun & Moon era and anchored CRZ/Holo UR/split
  Gallery wording are corrected. Check parent-release titles under explicit
  subset queries against native catalog identity before broadening admission.
- [ ] Improve whole-gallery sampling, front/back versus close-up coverage,
  stamp/copyright/set-symbol/reprint recognition and false obstruction/language
  warnings. Preserve actual reviewed photo numbers and prior paid evidence.
- [ ] Fix prose photo references that use input ordinals instead of original
  listing numbers, without blindly rewriting accepted prose or buying rechecks.
- [ ] Preserve visible damage/scratches despite glare elsewhere. White backgrounds
  can hide whitening but prove neither damage nor deception. Seller condition
  is a clue; assess actual raw condition independently.
- [ ] Evaluate negation/holder-aware structural-condition clues for research
  priority. Do not invent details missing from summaries, assign physical grades
  from keywords or blanket-exclude lightly played cards with better potential.
- [ ] Calibrate narrow grade possibilities/probabilities against real outcomes;
  show unsupported estimates honestly rather than manufacturing numerical odds.
- [ ] Evaluate cheap text/OCR/label tasks and focused stronger-model escalation
  against accuracy, latency and total useful-result cost. Existing text-ranking
  and cheaper-label pilots do not establish net savings. Reuse accepted findings
  and necessary original pixels instead of repeating entire assessments.
- [ ] Verify the focused edition-stamp path on a suitable real listing with a
  verified current quote and exact sold evidence for both possible printings.
  The mocked decision flip passes. The saved live gate check skipped the crop.
- [ ] Persist reusable source-linked observations/crop regions with model/schema
  versions and correction provenance for later targeted follow-ups.
- [ ] Reduce routine manual holds. Automatic correction of seller metadata must
  rely on corroborated physical identity; material authenticity/holder conflicts
  remain explicit. A missing market price belongs in Sorting.

## Auctions, liquidity and strategy

- [ ] Rank the best currently available matching purchases within the disclosed
  search coverage when a verified profitable flip is unavailable. Distinguish current after-cost value from
  speculative upside, using sourced trends, liquidity, competition and holding
  time to explain an outlook. Do not use a forecast to relabel a loss as a
  verified Deal. This idea is saved for later, not implemented in the cap change.
- [ ] Forecast closing ranges using matching sold auctions and available bid/watch
  evidence, separately from a profitable maximum snipe. Missing watchers remain
  unknown; distant cheap opening bids prove no opportunity.
- [ ] Cap slab snipes against cheaper verified equivalent BINs on comparable
  terms. Show item bid, shipping/tax/total investment, modeled profit and downside.
- [ ] Compare the saved Mewtwo PSA7 Shadowless example against the implementation
  and preserve the 12-hour auction requirement. Record forecasts/outcomes.
- [ ] Add a snipe assistant for auctions ending within 12 hours. Show the current
  bid, next valid bid, maximum profitable item bid, total cost at that limit and
  a separate expected closing range when supported. Add an ending-soon alert
  and an eBay link for placing the bid.
- [ ] Evaluate in-app automatic bidding after the snipe assistant. Confirm
  production Offer API access and explicit permission for time-scheduled bids
  with eBay. If approved, require buyer authorization per listing and a hard
  cap, use durable scheduling and cancellation, refresh terms before dispatch,
  and reconcile uncertain results before any retry. Test in the sandbox first.
  See [eBay Offer API overview](https://www.developer.ebay.com/api-docs/buy/offer/static/overview.html)
  and [eBay Buy APIs requirements](https://developer.ebay.com/api-docs/buy/buy-requirements.html).
- [ ] Prototype a Chrome extension only if it improves the on-listing workflow.
  Show the verified limit, timing alert and changes to auction terms beside the
  eBay listing. Reuse the app's calculations. Benchmark bid readiness and late
  submissions, including extended-bidding auctions. Treat bid submission as
  the separate eBay approval milestone above.
- [ ] Define understandable liquidity scores and resale-time/confidence ranges
  from exact-market activity, active supply and coverage. Include capital/holding
  preferences and grading/shipping turnaround; avoid a universal 30–60-day cap.
- [ ] Build and backtest market trends, daily plans and daily-movers/stale-BIN
  strategies from shared SQL history. Keep provider aggregates separate from
  actual transactions; do not treat one outlier or asking-price spike as a trend.
  Run once at a random time between 5 and 6 a.m. Central. Use exact eBay sold
  history to confirm movement, then check newer and older active BINs below
  the updated purchase ceiling. PriceCharting Big Movers is an ungraded lead
  source. Integrating its data in the customer app requires written permission.
- [ ] Test misspellings/generic titles, missed edition/Shadowless/holo/set, LP-to-NM
  and NM-to-Mint upside with actual photo evidence and after-cost margin.
- [ ] Test general-merchandise/new sellers, small cached collection-condition
  samples, unusually cheap sales leading to other inventory, watched BINs and
  promotion plus age. Seller intent remains a hypothesis.
- [ ] Test relisting/presentation upside: good cards with weak photos/descriptions
  or titles, improved listings and supported resale margins.
- [ ] Support raw resale, existing slab resale and CGC/PSA grading plays, across
  valuable cards of every era. Original-151 familiarity informs optional strategy.
- [ ] Later validate the saved user-found BIN example, item 227548256279, after
  current evidence paths are ready; its historical price/availability is unknown.

## UX and product polish

- [x] Add camera capture and photo upload for a whole front, back and optional
  tilted holo view. Show one estimated grade, play condition, confidence and
  visible wear, or ask for a specific retake. A readable slab keeps its label grade.
- [ ] Test the camera workflow with a physical phone and a card-show buyer or
  owner. Compare the photo estimate to an independent in-hand assessment.
- [ ] Build the compact always-visible filter workspace, decision-first rows and
  persistent desktop inspector; use full-screen details on phones and a small
  advanced-options popover instead of the overloaded drawer.
- [ ] Finish responsive type/spacing/color, overlap/scrollbar cleanup, smooth
  header/drawer transitions, keyboard/focus/touch and reduced-motion behavior.
  Evaluate Radix with existing CSS Modules rather than a framework rewrite.
- [ ] Show actionable purchase/offer/snipe limits, costs/profit/ROI, pricing
  evidence, photo confidence, liquidity and honest no-deal/remaining-work reasons.
  Keep progress compact and distinguish local recalculation from provider work.
- [ ] Preserve original source/assessment freshness internally, listing dates,
  auction countdowns and sold dates; do not reset provenance on cache reads.
- [ ] Keep saved blue/purple UI drafts as references. Use real decision data,
  avoid fabricated dashboard metrics and excessive AI branding. Refine any
  remaining Bargain labels/layout duplication after checking current callers.
- [ ] Optional sharpening is later, explicitly priced/labeled beside originals;
  generated detail must never establish grade or authenticity.
- [ ] Choose a better product name and plan Android packaging after responsive
  web behavior is reliable.

## Cleanup, shared service and release readiness

- [ ] Continue small caller-traced cleanup at each changed boundary. Remove dead
  writers, duplicate logic and implementation-only tests; preserve behavior tests,
  working tooling and accepted data. Avoid broad rewrites and item-ID exceptions.
- [ ] Build durable server-owned research tasks/progress/cancellation/recovery.
  Shared SQL cache alone does not finish a search after its browser disconnects.
- [ ] Add authenticated users/private settings, shortlists, notes, fee/tax and
  capital/holding preferences. Move reservation/quota authority into shared SQL
  before deploying independent replicas; preserve all spent counts/unknown holds.
- [ ] Verify account-specific grading fees, taxes, tiers, turnaround, batch/return
  shipping, no-grade costs, weights and downside assumptions. Keep audited money
  arithmetic and distinguish grading capital lock-up from immediate slab resale.
- [ ] Validate SQL capacity, backup/restore, retention, external photo storage,
  least privilege, observability and failure/scale behavior before paid release.
- [ ] Measure useful/false/missed deals, manual-review burden, latency, provider
  usage and actual costs across diverse searches and responsive/accessibility
  scenarios. A negative sample does not prove there are no marketplace deals.
- [ ] Keep tracked notes current and respect requested commit/merge/push scope.
  Preserve the unrelated .env.example deletion. No separate handoff now.

Computer-maintenance follow-up retained from older notes: verify the user's
removal of the Claude browser extension and obsolete Full Disk Access entry.
This is separate from Pokémon Flipper's product milestone.

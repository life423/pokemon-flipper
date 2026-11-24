# Pokémon Flipper — current checklist

Updated November 24, 2026. This is the active work list. Current decisions and
resource locations are in [LOCAL_PLAN.md](LOCAL_PLAN.md); verified audit findings
are in [the maintained audit](docs/deal-search-audit.md). Git retains removed
reports. Provider payloads, paid evidence, credentials and user data stay private.

## Current foundations and decisions

- The shared price-before-photo workflow, raw resale, slab resale and CGC/PSA
  grading routes already exist and deserve equal priority. Clear slab labels
  establish the certified grade;
  do not regrade a slab as raw. Raw condition remains independent of seller claims.
- Discovery can fetch 200 summaries per pass and screen beyond 50 unresolved
  rows. A thin newest-first BIN search can add one lower-price pass. Fifty rows
  are retained for assessment/display; rejected, deferred and not-reached rows
  have distinct saved reasons. Lowest-price discovery and local sort are separate.
- Best current buy, explicit projected losses, compact comparison rows and the
  desktop split inspector are implemented. They do not establish a live profitable
  BIN. Best current buy requires a checked all-in purchase below its exact
  condition or grade market and shows the projected resale outcome separately.
- Use exact English identity, release, collector number, printing, finish, language,
  grader, grade and special tier. First Edition, Shadowless and Unlimited are
  separate markets; holo, reverse holo and non-holo are separate finishes. Keep
  foreign historical data without presenting it as an English opportunity.
- Use recent matched eBay transactions for resale. One eligible sale can support
  sparse pricing with low confidence. Preserve the current recent-BIN cohort and
  four-sales-within-48-hours rules, transaction formats, outlier handling and dates.
  TCGplayer estimates do not price resale. Graded future value is not raw cash value.
- Fees, taxes, shipping, grading, profit, ROI and purchase ceilings stay in code.
  Any profit/ROI targets still require positive after-cost profit for Deals.
  Unknown destination shipping keeps estimates provisional and is different
  from a confirmed free-shipping quote.
- Useful AI and data requests are authorized. Optimize useful decisions and avoid
  duplicate work; zero calls and an arbitrary cheap-search total are not goals.
  OpenAI runs uncapped on this installation with accounting and cancellation intact.
- New searches retain 100 actual eBay Browse requests, 128 uncached screening
  PKMNPrices requests and 256 all-stage PKMNPrices requests. Existing accounts keep
  their recorded limits and spend. These are tunable runaway safeguards, not desired
  consumption. The subscription supplies 20,000 daily credits; preserve rate limits,
  shared cache reuse and rapid-depletion warnings when expanding useful research.
- Reuse accepted photos and sold evidence. Refresh terms/prices independently;
  unchanged images must not incur repeated photo charges. Storage, accounting and
  unresolved-charge failures remain fail-closed; never reset ledgers to continue.
- Best Offer is optional and enabled by default, with openings at most 15% below
  asking. Show a draft and private walk-away limit; an unaccepted offer is not a Deal.
  No automatic purchases, offers, bids or seller messages are authorized.
- Automatic discovery requires strictly less than 10 hours remaining at search start. An auction
  opportunity requires a live auction with strictly less than 10 hours remaining and
  a current auction price below the supported market value of that copy.
  Respect user capital/holding preferences and grading turnaround rather than a
  universal 30–60-day resale cutoff. Support valuable cards across all eras.
- Preserve original images and provenance internally; show actual listing/sold
  dates and auction countdowns. Seller expertise and condition text are clues.
  Disclosed wear hidden by all supplied sleeve photos cannot support a confident buy.
- Keep the confirmed palette: primary #7C3AED, accent #A78BFA, surface #171923,
  profit #22C55E, review #F59E0B. Grading uses neutral labeled styling. Avoid invented
  dashboard metrics and decorative AI branding. Use existing CSS Modules/components.

## 1. Prove the live buying workflow

- [x] Replace the generic “Resale unconfirmed” outcome with a buyer decision and
  its evidence. Replay the two raw Base Set Mewtwo 10/102 holos shown at $106.03
  and $74.91 all-in, both assessed Heavily Played with estimated grade 3. Recover
  exact-printing HP sales first, then check grading economics around grade 3 with
  fees and shipping. If only neighboring evidence exists, show its supported
  bounds, confidence and break-even. The app inspects the evidence and recommends
  buy, pass or wait at the checked price. A lower-condition loss alone cannot prove
  a loss at the assessed condition.
  Verify the recommendation on the search card and disclose remaining uncertainty.
  The saved November 24 browser replay showed **Pass** at both prices on the
  result cards and in their analysis. At those quotes the two copies needed
  raw sale prices of $131.79 and $95.31 to break even after fees and postage. Four
  seller-described HP sales and a cleaner photo-checked sale supported passing.
  The grade estimate and matched slab sales supplied a second check.

- [ ] Test a paid collector buying guide with people already shopping for a specific
  card. Ask each for the printing, acceptable wear and all-in budget. Use the
  existing search or listing-link assessment to show which copy to buy or why to
  wait, the seller photos that support the choice, and recent matching sales.
  Include the price difference for a cleaner copy. Have five collectors try it
  on their own searches and offer a second paid comparison. Record purchases,
  passes, repeat payments and research cost before choosing a price or building billing.
- [x] Replayed the Plasma Blast Palkia-EX lookalikes. Three photographed English 100/101 full arts now resolve to the exact catalog product, including a copy listed under Plasma Storm. The $200 listing whose front shows 66/101 remains excluded. On November 24 the same 39 retained search rows went from zero to 31 with sold references. Those prices establish research priority until a copy's condition supports them.
- [x] Replayed Legendary Collection Charizard 3/110. The photographed plain PSA 9 label identifies the non-holo copy despite the seller’s Holo claim. The buyer sees why the Holo record cannot price it. Two saved replays used zero new paid calls. Tests cover explicit Holo and Reverse Foil labels. [PSA set guide](https://www.psacard.com/priceguide/non-sports-tcg-card-values/2002-poke-mon-legendary-collection/3906)
- [ ] Use the [collector feature roadmap](LOCAL_PLAN.md#collector-features-worth-paying-for) for pilot interviews. Track which paid decisions buyers actually request, then prioritize scanning, collection valuation, language coverage, tools and sharing from that evidence.
- [ ] If collectors pay for that comparison, test a recurring want-list alert on
  the same criteria. Notify when a photo-checked copy meets the collector's
  condition and delivered budget. For occasional buyers, test a one-off listing
  check. For the alert, test a $50 all-in budget against two exact copies at
  $49.34 and $50.01. Require current availability and destination shipping.
  Suppress duplicate alerts and keep collector buys separate from profitable flips.
  For owners deciding whether to grade, test showing net proceeds from
  selling raw versus grading at the estimated grade and one grade lower.
- [x] Add camera capture and photo upload for a whole front, back and optional
  tilted holo view. Show one estimated grade, play condition, confidence and
  visible wear, or ask for a specific retake. A readable slab keeps its label grade.
  On November 24, the saved Mewtwo front and back returned 4/10, Moderately
  Played, medium confidence. The app recorded $0.0018372 for one vision call.
  Replaying those photos after a restart reused the assessment.
- [ ] Test the camera workflow with a physical phone and a card-show buyer or
  owner. Compare the photo estimate to an independent in-hand assessment.
- [ ] Replay the two-photo Neo Destiny Dark Gengar 6/105 listing through the ordinary listing assessment. The saved UI [screenshot](data/acceptance-fixtures/neo-destiny-dark-gengar-6-105/gallery-screenshot.png) shows the sleeved front and the back thumbnail. Use the full listing photos to estimate play condition and a single grade with confidence. Cite visible wear or preservation and name any obscured area. Check that the presence of a sleeve alone cannot suppress the estimate or count as damage. An estimate can accompany a pass if the visible evidence or price warrants it.
- [ ] Add an editable “Ask for photos” draft when another view could change the decision. For Dark Gengar, request only the unsleeved back or tilted holo view still needed after checking the full gallery. Put it on the listing card, leave sending to the buyer, and reuse the existing assessment when new photos arrive. Verify that a complete gallery produces no redundant request.
- [ ] Use the $1,299 all-in raw Dark Gengar on the black stand as a pricing replay. Compare the exact Unlimited holo with raw sales by condition and certified examples around the provisional grade 6. Show the paid prices, dates, uncertainty, grading costs and a buy/pass decision. Free shipping and $99 purchase tax are already in the total. The $1,171.21 raw copy on brown fabric is a separate two-photo test for recognizing Unlimited even when the seller omits the edition.
- [x] Recover an estimate for a scarce half-grade slab. For the $999 CGC 8.5 Unlimited Dark Gengar, PKMNPrices returned zero exact sales. Pokémon Price Tracker’s Unlimited Holofoil CGC 8.5 data supplied a $927.93 90-day estimate and a separate $874.50 historical median. Its last reported sale was October 26. The app compares the estimate with $1,081.42 after tax, including the holder-scratch caveat. The buyer does not need a new photo grade.
- [ ] Recover individual sales whose titles omit the edition. Verify the photographed stamp area or slab label and keep the sale date, grader, half-grade and sale format when known. Deduplicate by listing and distinguish relists. Replay the [October 12 CGC 8.5 completed sale](https://www.ebay.com/itm/327355249346) against the $999 listing. Extend to adjacent-grade references where an exact-printing estimate is still unavailable.
- [ ] Let the buyer enter an asking price and compare net proceeds for selling
  raw, grading at the estimated grade and grading one grade lower using exact
  sold comparisons, fees and grading costs.
- [ ] Find one live, available, correctly identified Buy It Now listing with a
  supported positive after-cost margin and verify it reaches Deals through the
  normal search, assessment and results flow. Record the evidence and limitations.
- [ ] Validate Best current buy in a normal live search. Confirm exact matching,
  destination shipping, current availability, seller concerns, coverage disclosure
  and honest profit/loss. A genuine zero-deal market result is not a pipeline failure.
- [ ] Use fresh discovery and shared exact-market evidence to select the next
  useful candidate. Check search history and rotate Pokémon, sets, price ranges
  and raw or graded copies in live trials. Reuse a previous card when replaying
  a specific defect. Use existing evidence before paying for more photos.
- [ ] For a viable candidate, verify label/printing or raw condition, current terms
  and every modeled cost. Replay accepted inputs without duplicate photo charges;
  changed terms must reprice while unchanged physical findings remain reusable.
- [ ] Measure how often below-market Buy It Now leads survive the photo and
  after-cost checks across different cards. Preserve the original listing IDs,
  asks, comparison sales and observation time in private validation records so
  a later rescan can explain every change in the count.
- [ ] Measure correct, false and missed opportunities, manual holds, latency,
  source coverage and provider spend. Distinguish a real loss, absent evidence,
  missing identity, an admission stop and a provider/accounting failure.

## 2. Finish coverage, reproducible audits and recovery

- [x] Rank the retained batch, review the first 15 eligible picks, then finish the rest automatically. The results show Buy, Wait or Skip with a reason and count decisions separately from actual photo evidence. A 50-listing browser replay with simulated providers verified 50 distinct reviews, the selected order and two concurrent checks. Stop prevented additional dispatches.
- The saved 50-listing Dark Alakazam search also returned 46 Wait and four Skip through the local buyer-review endpoint using only saved evidence. All 50 had photo evidence. The $71.65 copy was seller-listed Unlimited and assessed Lightly Played. The saved comparisons did not establish a profitable exit. The paid call count and recorded spend were unchanged.
- [x] Recover Lightly Played sale comparisons for the 11 physically matched Dark Alakazam listings in that search. Two sold-photo checks provided one comparable per printing. Replaying all 11 through buyer review returns Skip with the sale price and after-cost loss.
- [x] Add a grading watch to eligible named searches. Check fresh raw listings against the buyer’s targets at the likely grade and for positive profit one grade lower. A browser replay with simulated listings verified that an overlapping check alerts once and Stop ends further polling.
- [ ] Measure watch alerts against fresh eBay listings, recording the number screened, the copies that qualify, the evidence behind each alert, and the cost per watch.
- [ ] Measure photo coverage, decision quality, runtime and cost on fresh live 50-listing searches with the new queue. Record provider or evidence gaps separately.

- [ ] Add explicit continuation beyond the retained 50 using saved overflow and
  the original search allowances. Preserve exclusions, deferred reasons, accepted
  findings and spent counts; do not restart the same paid research as a new search.
- [ ] Freeze minimal versioned inputs, clock, settings and outcomes for the
  after-50-unresolved case, Blastoise, a genuine loss and a supported profitable
  case. Compare identical search-to-Deals inputs before/after and verify free replay.
- [ ] Preserve per-listing stages/reasons for pre-display exclusions and overflow
  in those replay baselines. Existing old reports cannot reconstruct evidence they
  never saved; do not infer unseen decisions from aggregate counts.
- [ ] Measure residual exact-market misses when observed set and collector number
  agree but title descriptors obscure the name. Separate parser defects from
  genuine printing/finish ambiguity before changing admission or requesting photos.
- [ ] Replay the remaining raw Blastoise stops. Distinguish real printing conflicts
  from photo interpretation errors and preserve explicit anniversary/reprint marks
  even when the model does not reject the entire listing.
- [ ] Finish narrow audited input cases: malformed collector fractions,
  independently negated condition clauses, and finish-specific changes that must
  invalidate old pricing. Generalize demonstrated cases; avoid item-ID exceptions.
- [ ] Give automatic diagnostic review a bounded retry after a confirmed failure.
  Preserve its original account, accepted response and unresolved-charge holds;
  an uncertain charge must not authorize a second generation.
- [ ] Exercise SQL-backed spending and retry accounting through actual transport
  boundaries. Verify import freshness ordering and reject corrupt image bytes
  before paid dispatch. Add repeatable browser coverage for shortlist edits.
- [ ] Update local reproduction and the environment template for port 3017 and
  current settings. Preserve the loopback API boundary and the unrelated existing
  .env.example deletion until its own change is explicitly handled.

## 3. Improve exact identity and price evidence

- [ ] Validate catalog candidate retrieval for nicknames and descriptions, including
  Bubble Mew, MewTube, Special Illustration and Contender. Preserve typed filters,
  printed forms/owners and broad intent; delivered-price phrases need their own
  explicit constraint instead of being mistaken for an item-price limit.
- [ ] Resolve remaining catalog-anchored title residue, including Secret Shining
  and the observed Pokemon Co. publisher prefix. Check parent-release titles under
  explicit subset queries against native catalog identity before broadening matches.
- [ ] Handle bare OC/MC/Error qualifier wording consistently in screening and final
  pricing while preserving ordinary seller lot suffixes and special slab tiers.
- [ ] Finish bounded sparse-market recovery: exact recent sales, labeled older
  matches, verified active competition, then explicitly estimated alternatives when
  useful. Adjacent-grade, similar-card or grading-company ratios need evidence,
  provenance, uncertainty and validation; estimates are not confirmed transactions.
- [ ] Complete remaining exact-BIN competition work: deduplicate relisted copies
  or slab certificates where supported and measure the cheapest-check coverage.
  Reuse saved labels and current delivered terms; asking prices remain separate
  from completed-sale resale evidence and actual sales activity.
  The saved Darkrai search now returns a photo-matched collector buy with its
  all-in cost and resale loss. The Charmeleon PSA 9 replay verified the wait
  decision against matched sales, delivered terms and the saved slab label.
- [ ] Evaluate raw-comp sampling uncertainty. Seller-clue cohorts and one accepted
  observation do not establish an unbiased condition market. Preserve reviewed
  negatives and original charges; never seek a favorable sale by repeatedly valuing.
- [ ] Recover unknown transaction amounts only when it could change a decision.
  Prefer provider corrections; AI extraction needs a source proving sold state,
  listing ID, currency and actual final amount. Bids, asks and guesses do not qualify.
- [ ] Retire the remaining seller-title-only raw final-price compatibility branch
  after the accepted physical-condition route covers its useful behavior. Preserve
  useful legacy evidence readers; do not erase previously paid assessments.
- [ ] Add buyer-specific shipping destinations with account settings. Invalidate
  affected terms when the destination changes while preserving physical evidence.

## 4. Improve photo decisions and AI efficiency

- [x] Recover missing back overviews from the remaining seller photos and reuse the
  accepted gallery on replay. Show matching raw sales and the cheaper comparable
  copy even when neither clears resale costs.
- [ ] Improve whole-gallery selection: distinguish front/back overviews from
  close-ups; use stamp, artwork shadow, full copyright, number, set symbol and
  reprint evidence together. Reduce false obstruction and language findings.
- [ ] Keep original listing photo numbers in prose and structured observations.
  Correct input-ordinal mistakes without blindly rewriting accepted text or paying
  to assess the same image again. Preserve what was and was not reviewed.
- [ ] Preserve visible scratching, creases, spots and wear despite glare elsewhere.
  White backgrounds can conceal whitening but prove neither damage nor deception.
  Seller Mint/NM/LP wording cannot replace this copy's physical condition.
- [ ] Evaluate negation- and holder-aware condition clues for research priority.
  Do not assign physical grades from keywords or exclude all played cards whose
  actual condition could support a worthwhile route.
- [ ] Calibrate likely raw grades and narrow ranges against real outcomes. Show
  confidence and supported uncertainty; do not invent calibrated grade percentages
  or make a poor image appear precise. Certified slab grades remain final.
- [ ] Compare inexpensive text/OCR/label work and focused stronger-model reviews
  using accuracy, missed deals, latency and total useful-result cost. Avoid retiring
  models and automatic cheap-plus-expensive repetition; preserve accepted findings.
- [ ] Persist typed source-linked observations and crop regions with content hashes,
  original photo numbers, model/schema versions and correction provenance. Give
  stronger review only the unresolved question and necessary original pixels.
- [ ] Evaluate whether richer targeted review should correct grades, prices or
  recommendations with dependent repricing and visible evidence. The existing
  observations-only deeper review does not implement that broader workflow.
- [ ] Test a focused slab-label follow-up only when an unexamined view could settle
  the holder/grade/certificate and the resulting economics could justify buying.
  Preserve negative examples where even the favorable exact grade loses money.
- [ ] Validate the edition-stamp crop on a suitable live listing with current terms
  and exact sold evidence for both printings. The mocked decision change alone
  does not establish successful live recovery.
- [ ] Replay the [$31.92 Dark Alakazam 1/82](https://www.ebay.com/itm/117497492670). The seller titled it Team Rocket 2000 Unlimited, but the saved assessment recorded the printing as unknown after checking 6 of 11 photos. Find the clearest original front and verify the edition-stamp area using the Team Rocket layout. A clear unstamped area should resolve Unlimited and allow comparison with Unlimited sales. Include a stamped copy and an obscured stamp area in the replay. Keep the condition and purchase decision independent of the printing correction.
  Repeat with the [$71.65 copy](https://www.ebay.com/itm/407169197695). All three photos were checked, the front shows the empty stamp area, and the saved result still says unknown. Also replay the [first $93.98 listing](https://www.ebay.com/itm/377624249775) and the [second $93.98 listing](https://www.ebay.com/itm/377572430256) separately. Both seller titles say Unlimited and both saved assessments returned unknown.
- [ ] Reduce routine manual holds through corroborated identity correction and
  targeted evidence. Keep material authenticity/holder/printing conflicts explicit;
  missing prices belong in Sorting rather than a manual card-identification task.

## 5. Build durable reuse and release foundations

- [ ] Store normalized long-term sold observations beyond API response caches:
  IDs, exact market, condition or grader/grade/tier, confirmed amounts/currency,
  sale format and source/sold/ingested/updated times. Support incremental ingest,
  corrections, retractions/deletions, deduplication and coverage tracking.
- [ ] Preserve historical AI price/rate snapshots and define retention by data type,
  protecting accepted paid responses, corrections and unresolved reservations.
- [ ] Use transactional shortlist/history writes and shared provider/spending quota
  authority before independent processes or machines. Preserve original limits,
  spent counts, uncertain holds and account boundaries through migration.
- [ ] Build durable server-owned research jobs with saved progress, subscriptions,
  cancellation and recovery after browser disconnect/restart. SQL caches alone
  do not complete a search or make its current client queue durable.
- [ ] Add authentication and private settings, shortlists and notes. Support actual
  buyer tax/fee/grading services, purchase budgets and capital/holding preferences;
  keep shared public market facts separate from private underwriting.
- [ ] Verify service-specific grading fees/taxes, tiers, turnaround, batch/return
  shipping, no-grade costs, grade weights and downside assumptions. Preserve the
  audited cents-based arithmetic and separate grading lock-up from slab resale.
- [ ] Validate SQL capacity, backup/restore, retention, external photo storage,
  least privilege, observability, operating cost and failure/scale behavior before
  public release. Preserve current production install/build/test checks.
- [ ] Continue caller-traced cleanup at changed boundaries. Remove dead writers,
  duplicate orchestration and implementation-only tests while keeping meaningful
  behavior regressions, tooling, compatible readers and accepted private data.

## 6. Validate later strategies and auctions

- [x] Add collector-number discovery to fixed-price raw-card market hunts.
  After a full-name miss, try the printed fraction and the set plus number at
  the same price ceiling. A catalog with only a numerator uses the set and
  number together. Deduplicate copies, preserve number prefixes and suffixes,
  retain buyer constraints and show the query results in Research steps.
- [x] Verify a number-discovered lead against independent catalog artwork.
  An unchanged earlier assessment cannot bypass this check. The November 24
  Leafeon comparison caught a seller-misnumbered regular full art after the
  original assessment agreed with the incorrect target. Exclude conflicting
  artwork before using the target market's sales.
- [ ] Extend the number-discovery trial to other cards and releases, including
  a real qualifying copy. Record additional photo-confirmed matches found by
  each query, misses, false matches, latency and incremental cost. The first
  same-ceiling Leafeon trial found no verified 167/203 purchase.

- [x] Surface **Auction opportunities** in Results. Require strictly less than 10 hours remaining and a current auction price below supported resale value for the exact copy. Show the next valid bid with shipping and tax, recent matched sales, expected after-cost profit and the maximum item bid.
- [x] Let the AI choose auction markets, listing checks, original photos, sale comparisons and grading math. The prompt `Find vintage holos from 1999–2003 I can flip for at least $25.` carries the requested years, finish and return into the cross-card hunt.
- [x] Replay the strict 10-hour boundary, a bid that reaches market value and rising acquisition costs. Persist the original maximum and subsequent bid checks. In the saved First Edition Dark Machamp PSA 8 auction, the $127.50 bid rose to a confirmed $274 close, above the original $136.90 ceiling. Repeating the closing-price lookup used zero additional credits.
- [ ] Measure how many new auction alerts close within their original ceiling. Report unresolved closing prices separately. Compare the yield and cost of photo checks with and without seller-inventory prioritization and record how often a cleaner raw copy still makes money one grade lower.
  Use the next twenty distinct alerted auctions as the first cohort. Save the
  original alert time, exact identity, next bid, delivered quote, ceiling,
  matched-sale coverage, chosen strategy and research cost in private records.
  Track subsequent bids, a verified final sale or an unresolved result, and
  whether the close fit the original ceiling. Repeated alerts for the same
  copy count once. Keep an auction closing under the limit separate from a
  buyer actually winning, purchasing and reselling it.

- [ ] Trial four buyer strategies against the newly listed raw-card hunt. Record the observable clue, the next tool the AI chose, what it found, research cost and whether that changed the buyer's decision.
  1. Follow a general-merchandise seller's second Pokémon listing after identifying the first. Check whether its own photos, matching sales and delivered price support a flip.
  2. Compare two cards at the same purchase budget. Favor the one that still earns the target if it grades one point lower, and measure how often comparing downside changes the AI's first pick.
  3. Revisit a promising listing when the seller adds a previously missing back or angled holo photo. Reuse the existing sales and check whether the new photo changes the maximum purchase price.
  4. After two misses, compare another printing of the same Pokémon with a different liquid card from that era. Record which route found a qualifying copy within the buyer’s original constraints.
  The [fifteen eBay deal-finding tactics](LOCAL_PLAN.md#fifteen-ebay-tactics-for-the-deal-planner) cover additional discovery, collector and negotiation strategies for the planner.
  Completed the first collector-number comparison on November 24. At the same $33.85 item ceiling, both alternate queries found an older Leafeon V that the full-name search missed. The actual card was Evolving Skies 166/203. No photographed 167/203 qualified. The same fresh-grading hunt found seven eligible Base Set Mewtwo listings. Photos from three showed estimated grades 4, 4 and 3. No qualifying purchase was established.

- [ ] Validate the five November 24 strategy selections against real inventory.
  Preserve the original selection numbers 5, 7, 16, 18 and 20 from
  [the twenty ideas](LOCAL_PLAN.md#twenty-deal-finding-ideas-to-test).
  For competing auctions, record the next bid, delivered cost and bid limit for
  two identical slabs closing within 15 minutes. For cross-market resale, compare
  a Cardmarket ask with an actual seller payout and fulfillment costs. For binder
  copies, record the savings and photo evidence for back-only wear. For the optional
  artwork search, compare two verified releases at the same condition or slab grade.
  For seller-added photos, revisit a saved missing-back verdict and record which
  decision changed and what the additional check cost. Keep these outcomes
  separate from a buyer's completed purchase or resale.
  On November 24 the normal app matched five active Cardmarket offers to a
  saved Base Set Mewtwo PSA 8. The first lookup used one PKMNPrices request
  and five credits. Replaying it reused all five offers with zero additional
  provider requests or credits. The US sold-based path remained a projected
  loss. A completed cross-market resale is still to be validated.

- [ ] Implement the [original AI-directed research plan](https://github.com/life423/pokemon-flipper/blob/ecae9e9c43000ee57304e7d4299e2148696c81f1/LOCAL_PLAN.md#L1805-L1810)
  as an opt-in search mode. Let ChatGPT choose a strategy from recent sales and
  liquidity, then pursue fresh underpriced BINs, overlooked seller mistakes or
  auctions ending in less than 10 hours. Through existing tools it can refine and repeat
  searches, inspect the full listing, choose original photos or crops, check shipping
  and fetch exact sold comparisons. Consider raw resale, slab resale and raw-to-grade.
  The saved exact-slab mode now lets the model choose sales, listing terms
  or label checks, or finish once it has grounds to wait. Reopening a completed
  guide reuses its decisions. In live exact-slab searches the model now picks
  which listings to verify using saved sales and the buyer’s all-in limit.
  Validate live selection on another slab with a plausible under-limit copy.
  Save the day’s plan, decisions, evidence, costs and outcomes for replay. The existing
  automatic review explains decisions after the search. Buyers control purchases,
  bids, offers and seller messages.
- [x] Give the [AI-directed deal hunt](LOCAL_PLAN.md#let-ai-choose-what-the-app-does-next) callable listing, photo, sales and grading checks for three buyer goals. The real planner replayed the saved raw Alakazam and CGC 8.5 Dark Gengar, selected photos and sales respectively, and reused its planning decisions on repeat. Browser checks verified all three evidence destinations. Service tests cover price changes, changed galleries and switching listings.
- [ ] Use the AI to resolve dead ends across the buying workflow. When a market has too few exact sales, try the next relevant price source and label estimates separately from transactions. When photos disagree with seller metadata, check the other originals and the printing rules for that set. When grading costs erase the upside, inspect another copy. Retain evidence across steps and take the buyer directly to the reason to buy or wait. Replay a missing sale, a misleading label and a failed grading opportunity. Record the buyer steps eliminated, incorrect recommendations and incremental research cost.
  The deal hunt now has a price-reference check for identified raw cards and slabs that lack an exact sale price. In a saved CGC 8.5 Dark Gengar replay it recovered the $927.93 provider estimate and explained Wait at $1,081.42 delivered. Both runs used archived provider evidence. The misleading-label and failed-grading replays are still open.
- [x] Let the buyer keep a hunt within their results, try another liquid card in the same set, or start a profit-first hunt across sets without typing a name. Reuse exact completed sales to choose live Buy It Now markets, carry forward the buyer’s limits, and open the checked copy and evidence.
- [x] Continue a resale hunt after two empty markets when the original search allowance leaves room to verify a copy. Prioritize markets with a recently seen affordable listing. The $100 live replay reused its first two decisions, checked raw Base Set Mewtwo and Crown Zenith Pikachu PSA 9, and returned Wait across four markets with zero additional paid AI calls. An offline replay found a qualifying copy in the fourth market and opened its sale comparisons.
- [x] Give the AI the market choice after two misses. On the November 24 vintage holo hunt it chose Base Set Mewtwo PSA 7 for its stronger recent sales activity. It checked the final eligible market, then returned Wait. Repeating the hunt reused all three AI choices with zero additional AI spend. Research steps also identify checks required by the app.
- [x] Let collectors hunt fairly priced slab auctions and flippers hunt liquid resale opportunities. Test different bid limits on the same slab. In an auction with multiple copies, the AI can select independent checks together, revisit printing from original photos, or try selling raw when grading misses the target.
- [ ] After an unsuccessful auction search, start with a bounded page of auctions actually closing inside ten hours. Let the AI pick promising copies within the buyer’s preferences and verify exact sales, the legal next bid and delivered cost. Compare the number of supported recommendations and research cost against starting from previously priced cards.
- [ ] Let a buyer type “vintage 1999 to 2003 holo” into the search bar and see every qualifying flip the hunt checks. Apply the inclusive release years and holo finish to every candidate. After two misses in the same hunt, try another printing of the same Pokémon, another card from around the same release year, or a card matching both. Stay inside the buyer’s explicit years, finish and budget. Replay two misses followed by a qualifying alternative and verify that every displayed flip has matching recent sales and positive profit after costs.
- [ ] Measure how often resale-hunt recommendations actually sell at the projected profit and how long capital stays tied up. Compare the initial three-matched-sales-in-30-days threshold with realized outcomes for raw flips, slab resale and grading. Apply the verified exit-specific liquidity rule throughout Deals as the two workflows converge.
- [ ] Build sourced liquidity scores and resale-time ranges from exact sales,
  active supply and coverage. Include holding preferences, grading/shipping time
  and uncertainty; broad sales counts do not prove a time-to-sale guarantee.
- [ ] Backtest trends, daily research plans and daily movers against exact-market
  history. Run shared daily work once at a random time between 5 and 6 a.m.
  America/Chicago, then compare newer and older BINs with defensible updated
  ceilings. One outlier or changing grade/condition mix is not market appreciation.
- [ ] **On hold at Andrew’s request.** When resumed, claim each PriceCharting product before requesting it so overlapping runs and restarts cannot duplicate a scrape. Keep each batch small and space requests within the randomized morning window. Evaluate the [comic price updater](https://github.com/life423/comic-book-data) as a model for the Pokémon watchlist and Big Movers feed. Pilot a handful of variants against their PriceCharting product IDs. Test duplicate daily imports, missing prices, changed page structure and switching between standard and reverse holo before using a move to trigger eBay research.
  The supplied [Google Cloud project](https://console.cloud.google.com/welcome?project=pokemon-flipper-trends-2026) remains a resource for this deferred work.
- [ ] Resolve documented access/permission for PriceCharting Big Movers before
  customer integration. It can supply ungraded leads; confirm movement with exact
  matched sold evidence rather than treating an asking-price spike as a trend.
- [ ] Test misspellings, generic titles, omitted edition/Shadowless/holo/set and
  seller-understated condition using actual photos and after-cost economics.
- [ ] Test Andrew’s seller-profile lead on a general-merchandise seller, a Pokémon specialist and an account with too few visible items to characterize. Start both runs from the same saved newest-first page and research budget. In the seller-aware run, follow promising sellers into a saved sample of their other items and look for vaguely titled cards the original search missed. Count additional verified profitable buys, missed buys and research cost. Check the pictured printing, condition and margin, and reuse the seller lookup on the second listing. Include a seller who discloses wear that only their sleeved photos obscure.
- [ ] Follow cheap completed sales back to current inventory and test watched Buy It Now listings, listing age and promoted placement. Deduplicate promoted and organic results.
- [ ] Test presentation/relisting upside from good cards with weak photographs,
  descriptions or titles. Separate improved presentation from physical condition
  and grading; source the resale margin rather than assuming a higher price.
- [ ] Forecast auction closing ranges from matched sold auctions and available
  bid/watch evidence, separately from a profitable snipe ceiling. Missing watchers
  remain unknown. Save forecasts and outcomes, including the supplied Mewtwo case.
- [ ] Cap slab snipes against cheaper verified exact BIN alternatives on equivalent
  delivered terms. Preserve printing/finish/company/grade/tier and show item bid,
  shipping/tax/total cost, modeled profit and downside for the same bid scenario.
- [x] Add a built-in 12-hour auction sniper with the next bid, an editable item
  ceiling, an ending reminder and an eBay link. Use the assessed ceiling when
  available. Persist scheduled actions and recheck terms before each action.
- [x] Use eBay's soonest-ending order for auction discovery and enforce the
  window locally. On November 24 the Pikachu PSA 9 search surfaced eight
  listings inside 12 hours on its first page. Newest-first yielded zero on its
  first page. These counts precede card identity and profitability checks.
- [x] Add **Sign in with eBay** to Sniper. Production links read-only identity.
  Sandbox bids bind to the buyer who approved the auction and maximum.
  Cancel pending test bids on disconnect, buyer change or detected revocation.
- [x] Register a dedicated Production OAuth redirect and configure the local
  app. Both the accepted and declined URLs use the [deployed sign-in return
  page](https://drewclark.io/ebay-return.html). The normal Sign in with eBay
  button reaches the real buyer sign-in screen.
- [x] Verify Production buyer sign-in end to end. A buyer completed eBay consent
  in Safari and returned to Sniper. Both the app and its connection endpoint
  confirmed the linked account on November 24, 2026.
- [ ] Test revocation with a designated test buyer or when a connected buyer
  requests disconnect.
- [x] eBay Developer Support reviewed the scheduled-bidding inquiry on November
  24, 2026 and directed the operator to file an Application Growth Check.
  Support closed incident `261124-000014`.
- [x] Filed the Application Growth Check for scheduled, buyer-authorized proxy
  bids on eBay US on November 24, 2026. eBay confirmed reference
  **261124-000020** and estimated a reply within 1–2 business days.
- **On hold at the owner’s request (November 24).** Resume sniper development and Sandbox testing when requested. The filed Growth Check remains with eBay.
- [ ] Record eBay’s decision on Production Offer API access and its answer on
  scheduling bids shortly before close. [My Tickets](https://developer.ebay.com/my/support/tickets)
- [ ] Exercise a timed Sandbox bid and verify its receipt in the connected
  account. Obtain production Offer API approval before enabling real-money
  bidding. Keep ambiguous submissions from sending a second bid.
- [ ] Test the buyer flow from an auction card through eBay consent, a maximum
  bid and explicit scheduling. Before offering background bids to customers,
  run the scheduler on an always-on host and isolate each buyer’s grant and jobs.
  Myibidder provides an auction-page shortcut and runs confirmed snipes on its
  servers after the browser closes. Evaluate an eBay-page shortcut after the
  in-app flow is working. [Chrome extension](https://chromewebstore.google.com/detail/myibidder-auction-bid-sni/fmebanjjkaohcmifehogijfgcoieefnp) · [Myibidder FAQ](https://www.myibidder.com/login/faq/2).
- [ ] Add supported closing ranges when the forecast above has been validated.
- [ ] Replay the buyer’s Shadowless Alakazam purchase through newest-first raw
  discovery. Check if a seller-described Near Mint copy reaches photo assessment
  while fresh. Compare its observed condition with the buyer’s Mint assessment
  and price the pictured printing at the likely grade and one grade lower.

## 7. Finish interface and product polish

- [ ] Replace the advanced drawer with a focused accessible popover after preserving
  focus, dismissal, keyboard/touch use and Settings/fullscreen-photo interactions.
- [ ] Extend device/accessibility validation where actual content breaks: responsive
  type/spacing, overlap/scrollbars, header/drawer motion, reduced motion and clear
  remaining-work states. Reuse the current components; evaluate Radix only if useful.
- [ ] Present future liquidity/outlook/snipe evidence with the same clear cost,
  uncertainty and action hierarchy as the current buying comparison. Preserve
  original images and source/assessment freshness instead of cosmetic timestamps.
- [ ] Keep optional sharpening separately priced and labeled beside originals;
  generated detail cannot establish condition, grade or authenticity.
- [ ] Choose a product name and evaluate Android packaging after the responsive
  web workflow and its real buying usefulness are validated.

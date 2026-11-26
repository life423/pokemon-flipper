# Pokémon Flipper — current checklist

Updated November 25, 2026. This is the active work list. Current decisions and
resource locations are in [LOCAL_PLAN.md](LOCAL_PLAN.md); verified audit findings
are in [the maintained audit](docs/deal-search-audit.md). Git retains removed
reports. Provider payloads, paid evidence, credentials and user data stay private.

## November 25 Find a flip repair

Andrew clarified that a hunt must not stop at a fixed number of cards. Continue
within the buyer's filters until a verified profitable opportunity is found,
the buyer stops, the accessible inventory is exhausted, or a real provider,
quota, storage or accounting stop prevents further work. Page sizes, concurrent
workers and visible-card windows bound resource use; they must not silently
discard the remaining physical copies or become lifetime search limits.

The audit of `9c8b69c` reproduced these issues without paid searches: a blank
hunt could perform zero eBay scans when its small ranked catalog sample was
empty; fifty distinct unpriced candidates became one; the hunt scanner omitted
ordinary search's overflow continuation; ordinary broad phrases were rejected
after a correct interpretation; an expired otherwise-supported quote had no
refresh action; and a grading purchase could miss the likely-grade target.
The original 1,621-test suite passed despite those missing cases.

- [x] Keep every eligible/deferred copy and source cursor in the active hunt's
  backlog. Rank the first fifteen, then continue instead of dropping the rest.
- [x] Apply preliminary after-cost resale evidence across incoming Buy It Now pages.
  Give different printings a turn among comparable leads, keep unidentified copies
  eligible for photos, and recognize extended-art magnetic or acrylic case listings.
- [ ] Improve the share of incoming listings with a usable sold comparison before
  photos. Replay unresolved seller titles against the catalog and measure how many
  additional exact markets are identified without borrowing another printing's sales.
  Verify the improvement and a qualifying flip on live inventory.
- [x] Keep broad inventory discovery available beyond ranked card suggestions,
  including empty samples; preserve explicit set, year and exact-card limits.
- [x] Remove the default total-step ceiling for resale hunts; retain Stop,
  bounded model context, provider pacing, the daily reserve and accounting.
- [x] Show provisional listing cards during research and prevent hidden searches
  from continuing when the buyer switches workspaces. Both formats must not let
  a continuous BIN hunt starve auctions; stop sibling work on a verified flip.
- [x] Preserve natural-language meaning with source-linked subject evidence and
  support explicit Both-format requests without contradictory validation.
- [x] Refresh an otherwise-supported expired BIN quote once without repeating
  accepted photo work, and apply likely-grade profit/ROI targets consistently.
- [x] Complete offline service/browser acceptance, full tests, type checks and
  production build before claiming the repair works. No live Venusaur testing.
  Verification: 1,645 automated tests, both TypeScript checks, production build
  and whitespace checks passed. Nine isolated browser scenarios passed with no
  provider requests or page errors. The build retains its bundle-size advisory.
- [x] Carry both the assessed-condition TCGplayer quote and the photo-matched
  eBay sale estimate into raw valuation. The outlier-filtered average of exact,
  photo-assessed eBay copies leads. The same-condition TCGplayer market and
  shipped asks stay visible. Find a flip requests more evidence when it only has a TCGplayer quote. eBay sold shipping is
  unreported. Do not infer that an exceptional sale included free shipping.
- [ ] Calibrate an inferred CGC price against actual PSA and CGC sales of the
  same printing, label tier and grade over comparable dates. Weight each paired
  card market once, stratify by era and value, and test the inferred range on
  later held-out CGC sales. Show direct CGC sales first and keep observed CGC
  turnover separate from the PSA reference.
- [ ] Validate resale accuracy by printing, grade or raw condition, source and
  sample size. Split past sales from later sales by date and report the typical
  error and how often projected profit survives. Include raw listings where
  the TCGplayer quote conflicts with seller-described sales and no sold-copy
  condition has been verified. Check the source dates and paid-photo reuse.
- [ ] Validate a current live profitable copy through the repaired normal UI.
  The 661-copy service replay and nine browser scenarios use controlled inputs;
  they establish behavior, not a live buying opportunity. Preserve the eBay
  reserve and inspect current usage before another live scan.
- [x] For a general Find a flip request, let the AI choose which card to research
  and when to switch. Honor the buyer's explicit filters. Prioritize copies with
  frequent daily sales, stable resale prices and a profit after all costs.
  Use completed sales of the same printing, language, finish and condition or slab
  grade. Show observed sales per day, how many days had sales, and the typical
  sold-price range. Distinguish steady demand from a one-day spike and account
  for incomplete sales coverage. Use these signals to order research without
  imposing a fixed sales-count cutoff.
- [x] When a buyer names a card in Find a flip, search that card first. If the
  hunt needs alternatives, use the named printing's release era to bound them.
  Favor another liquid card from the same set or the same Pokémon from around
  the same year. Apply the buyer's explicit years, set, finish and budget to
  every suggestion, and honor an exact-copy-only request. Verify that a vintage
  seed cannot lead to a 2025 reprint, even when the reprint sells more often.
  Use the printing's release year, since a Pokémon can appear in many eras.
- [x] Let the hunt planner choose an app function, a lookup through a connected
  API, or a targeted web search according to the question it needs answered.
  For example, use eBay Browse for current listings and terms, PKMNPrices for
  matching sold listings, volume, history or condition-specific TCGplayer asks,
  and Pokémon Price Tracker for set years or supplemental grade data. Reuse
  each integration's cache, quota tracking and original search account. Keep
  the source and evidence type with each result. Extend the existing cited price
  lookup to questions such as which release a printing belongs to or which
  same-era cards to investigate. Return the source and finding to the planner
  so it can choose its next call. Keep the buyer's filters and reuse existing
  evidence. Verify a discovered listing and its comparable sales with the app's
  existing checks before calculating profit or recommending a purchase.

Local acceptance covers a one-day sales spike against steady selling days, a
vintage seed with a modern reprint, a wrong-number web suggestion, the planner's
choice of source on a sparse market, and a general hunt opening an additional
market after its eBay queries run out. A cited suggestion still needs catalog
confirmation before eBay discovery. Only the existing listing and underwriting
checks can issue a buying recommendation. The full suite passed 1,654 tests.
All 81 focused hunt, catalog-web and price-source tests passed on the final
planner change. Nine isolated browser scenarios passed with zero provider
requests. Both TypeScript checks and the production build passed.

- [x] Give the Find a flip planner descriptions of the functions available for
  its current decision. After checking the listing and photos, let it pick a
  supported raw-resale or grading check on a fixed-price copy. Preserve which
  function the model chose in Research steps.
- [x] Replay guided resale with per-copy reasons, a lower-cost equivalent copy, an exact-printing lookalike and a negative result. Check the price ceiling against the delivered budget and require an explicit action for supplemental tile research.
- [x] Persist watched source cursors, accepted copy tasks and interrupted attempts under the original budget. Resume after reload, preserve ZIP+4, keep Stop available and retain the closest fully priced miss.
- [x] On a blank Buy It Now flip, give fresh inventory the first turn and include exact printings with repeated, recent confirmed sales among the next choices. Compare their conservative item limits with the delivered budget. Show queued copies from the last query during research.
- [x] Admit potentially miscategorized copies and run one reserve-protected number-and-set query on a thin guided or price-supported exact search. Require photo confirmation before using that identity.
- [x] Keep isolated TCGplayer asks as references. Compare eligible exact-condition competition with physically matched eBay sales and use the lower supported exit. Check sold-copy evidence if competition is insufficient.
- [x] Read daily AI usage incrementally, combine active flip status polls, move local SQLite market history to a worker, and read candidate snapshots in batches of four.
- [x] Group frequent per-copy diagnostic events in append-only files. Preserve individually replayable pages and older pass recordings, and report gaps when a write is interrupted.
- [ ] Measure missed deals against independently reviewed listings with poor titles, photos, or seller categories. Track calls and time per verified copy and compare with ordinary discovery.
- [ ] Independently verify a purchasable live flip. Measure reviewed-candidate recall across more than one market, the cost to reach a supported decision and whether post-bid seller sampling finds any additional supported bids. Track unreviewed copies separately.
- [ ] Validate deployment-specific recovery and accounting before running workers on multiple machines. The current queue and account authority belong to one installation.

## Guided Find a flip milestone

1. [x] Add independent Find a deal and Find a flip entries. The guided tab keeps its draft and results, accepts optional text and exposes its own buying filters. Named results can show a graded alternative, a raw comparison or an eligible auction when supported.
2. [x] Replay strict and flexible Ampharos scopes. A flexible hunt may widen through a catalog-confirmed Aquapolis connection to eligible vintage releases. A blank hunt ranks recent recorded sales in a catalog sample.
3. [x] Add Buy It Now, auctions under ten hours and Both. Verify the shared hunt account, cancellation before a second format and retention of the first result after a second-format failure.
4. [x] Verify the Windows SQLite market cache and repeat reads without provider traffic. Keep the existing account-wide Browse reserve, pressure checks, counters and spending records. The live receipt is in the private handoff.
5. [x] Check scope, progress, decision tiles, delivered cost, chart/table and keyboard operation at phone, tablet and desktop widths.
6. [x] Run one live hunt for a liquid starting market. Record three markets, the closest miss, time and costs, and replay the false identity rejection discovered in that run.
7. [x] Add on-demand price history for a photo-verified market, a sparse-data state and a seven-day outlook checked against historical flat forecasts.
8. [ ] Find the first live, available copy with photo-confirmed positive profit after costs. Test which original photo views settle near-miss condition gaps, then compare collector-number and seller-inventory discovery against the live baseline. Validate directional accuracy on future observations. Record actual purchase and resale results separately if supplied.

## November 25 local deal-finding repairs

- [x] Keep a running flip hunt through same-ZIP focus refreshes. Show interruption counts and distinguish a confirmed destination change. Let the planner act on earlier misses to select among eligible copies and liquid markets, with its reason visible during the hunt.

- [x] Keep named searches on their matching listings. Typing a new query hides
  the previous hunt. An embedded hunt starts on “Only these results,” including
  after an empty search. Broader markets require an explicit selection. The
  interface reports progress, failures and next actions without cache notices.
- [x] Bind a Buy's displayed strategy, profit and purchase limit to its verified
  exit route. Keep modeled alternatives separate and withdraw approval after
  changed terms, targets, destination or quote expiration.
- [x] Preserve a supported lower-condition sold floor for a cleaner raw copy,
  including activity counted at the modeled exit condition.
- [x] Correct number-anchored catalog suffixes and source-backed title
  descriptors without changing accepted paid evidence keys.
- [x] Retain all continued rows in the root hunt, submit diagnostics per batch,
  recover safely from a quota placeholder and preserve the original allowance.
- [x] Stop new discovery/review on global accounting/storage holds; keep
  per-copy holds local. Restore single-batch searches and pause dispatch away
  from Results. Persist typed Wait blockers.
- [x] Add saved local delivery ZIP input; keep quotes destination-specific and
  clear browser advice on changes without erasing research or rerunning work.
- [x] Give broad discovery distinct markets and both raw/slab review candidates;
  retain cached research and every remaining copy in continuation. The later
  user instruction removes preliminary and whole-search API ceilings while
  preserving history, daily reserve, pacing and cancellation.
- [ ] Measure cold live latency and useful decisions after these changes.
  Offline acceptance does not establish a current qualifying deal or realized resale.
- [x] Measure a real warm-cache Aquapolis search in the normal interface. It
  produced zero verified Buys/Offers; timings and paid evidence stay in the
  Git-excluded local handoff. Cold performance and the deal milestone remain open.
- [x] Propagate shared eBay Browse exhaustion through buyer review and queue
  cancellation; preserve cached-only decisions instead of recording budget
  failures as financial outcomes or continuing paid research after the cap.
- [x] Generalize verified collector-suffix matching beyond the original examples,
  correct corroborated seller-name/set aliases, and keep catalog-backed printed
  card names out of novelty filters. Freeze live counterexamples for offline replay.
- [x] Normalize stream disconnections, retain earlier results and explicitly
  resume the original continuation after a shared hold. Isolated browser tests
  cover quota reset, active-stream cancellation and immediate retry.
- [x] Start standalone fixed-price resale hunts from new listings across cards. Reuse accepted evidence for matching copies. Keep named searches scoped.
- [x] Pace Browse across local searches when consumption accelerates or quota is low, defer extra pages and preserve the 10% daily reserve.
- [x] Restore photo tiles in Results and Find a flip. Check original identity before a fresh resale recommendation and use the full front alongside the stamp detail for eligible Neo Genesis holos.
- [ ] Validate a live liquid-card resale opportunity across sets. Report current
  terms, exact-copy evidence, matched activity and after-cost margin; no forced
  Deal verdict. Follow with budget-led ranked buying guidance, useful alerts and
  purchase-to-realized-resale tracking as separate product work.
- [ ] Reduce time to the first supported buying decision. The latest warm
  Aquapolis rerun took 65.189 seconds before a visible decision and 177.099
  seconds for 100 responses. Compare incremental useful results with waiting
  for a whole screened batch; preserve verification and avoid duplicate work.
- [x] Accept the user's exact conversational search for a liquid holographic
  resale card from the years 1999–2003. Preserve release/finish constraints,
  expose the interpreted criteria, and distinguish unverified liquidity from
  observed activity without a universal three-sale rule.
- [x] Support one-sided natural year bounds such as "holo card no newer than
  2020" through interpretation, canonical query, discovery and displayed criteria.
- [x] Keep broad set inventory in the correct card game before paid photos;
  the first live broad test admitted sports cards through a generic set query.
- [x] Replace the restored Charizard search's obsolete Windows accounting
  failure with a fresh authority check under the same account. Preserve genuine
  caps and unresolved charges; show the original cause once with a useful retry.
- [x] Recover an output-truncated research-planning choice with the existing
  host-selected safe action, record the paid negative outcome and reuse it.
  Do not increase output caps or buy a replacement response automatically.
- [x] Show actual ongoing hunt activity through the existing usage poll:
  current market/check, listing/pricing/review/photo counts, elapsed time,
  last activity and visible Stop. Verify normal/child account scope, stale
  attempts, cancellation, keyboard/touch and real client hot updates.
- [x] Trace and remove confirmed unused assessment helper, ranking argument,
  language wrapper, trend icon and CSS rule; keep paid cache readers and
  live retry/manual compatibility. All client modules still have entry paths.
- [ ] Improve exact slab finish/price-gap resolution and initial review ordering
  from live useful-decision evidence. Reconcile completed-response AI holds
  without resetting accounting or repurchasing accepted work.
- [ ] Extend the release-mark replay sample beyond the confirmed Base Set
  lookalike and its unstamped control. Include obscured fronts and other sets
  with same-art reprints before widening automatic focused checks.

This work is local and uncommitted. Full validation details and private observed
search evidence remain in the Git-excluded local handoff.

## November 24 stopping checkpoint

Checkpoint verification: all 1,540 automated tests passed, both TypeScript
checks passed, the production build passed, and staged whitespace checks passed.
The build retains Vite's bundle-size advisory. These checks do not replace the
pending browser/live acceptance below. This checkpoint is committed locally;
no push was requested for the break.

- [x] Interpret submitted search text with OpenAI before discovery; preserve
  catalog identity, release years and the buyer's explicit constraints.
- [x] Add condition-specific TCGplayer asking-price valuation after the AI
  assesses the raw copy. Keep active offers distinct from completed sales.
- [x] Replace the hard three-sale purchase veto with observed rolling 60-day
  activity. Use robust sale summaries so an isolated high sale cannot set value.
- [x] Align unpriced hunt eligibility with buyer review and recover eligible
  temporary review failures with bounded retries under the original account.
- [x] Add retained discovery continuation in batches of 50, with deduplication,
  original constraints, persistent ownership and visible coverage status.
- [x] Independently accept the automatic 51st-listing continuation through the
  browser, including cancellation, refresh, replay and quota exhaustion.
- [ ] Expand broad hunts beyond markets seeded by saved accepted evaluations.
  Continuation and larger menus do not establish coverage of unresearched cards
  or all eBay inventory.
- [ ] Finish live acceptance of condition quotes, activity captions and cold
  search latency using another card. Do not run live Venusaur tests.
- [ ] Demonstrate one available, correctly identified profitable deal after
  costs; no new live deal or realized resale was established in this checkpoint.

## Current foundations and decisions

- The shared price-before-photo workflow, raw resale, slab resale and CGC/PSA
  grading routes already exist and deserve equal priority. Clear slab labels
  establish the certified grade;
  do not regrade a slab as raw. Raw condition remains independent of seller claims.
- Discovery can fetch 200 summaries per pass and retain 50 rows per review
  batch. Continuation preserves overflow, source offsets, constraints and the
  original account; rejected, deferred and not-reached rows have distinct saved
  reasons. Lowest-price discovery and local sort are separate.
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
  Exact condition/printing TCGplayer offers can also price raw resale: use the
  lowest valid delivered competition, capped by condition market value when
  available, or the exact condition market value when offers are unavailable.
  These estimates never count as completed sales. Graded future value is not raw cash value.
- Fees, taxes, shipping, grading, profit, ROI and purchase ceilings stay in code.
  Any profit/ROI targets still require positive after-cost profit for Deals.
  Unknown destination shipping keeps estimates provisional and is different
  from a confirmed free-shipping quote.
- Useful AI and data requests are authorized. Optimize useful decisions and avoid
  duplicate work; zero calls and an arbitrary cheap-search total are not goals.
  OpenAI runs uncapped on this installation with accounting and cancellation intact.
- November 25: per-search eBay Browse and PKMNPrices ceilings are removed,
  including exhausted older accounts. Preserve historical limits, attempts and
  spending; all production Browse calls retain the 10% daily reserve. The
  subscription supplies 20,000 daily PKMNPrices credits; preserve rate limits,
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

- [x] Audit every explicit gate from eBay discovery to the Deal label. The
  [complete blocker audit](docs/deal-blockers-audit.md) covers source admission,
  matching, prices, photos, money, liquidity, auctions, budgets, recovery and UI.
- [x] Remove the reproduced one-versus-three raw-sale dead-end. Supported
  condition-specific TCGplayer quotes can value raw resale; observed 60-day
  transactions remain distinct and no hard three-sale veto applies. One accepted
  condition-matched sale can support sparse pricing.
- [x] Unify hunt and ordinary-review eligibility for repairable missing-price
  rows, and requeue typed temporary failures after finite cooldowns under the
  original account. These are confirmed integration gaps, not wrong API dollars.
- [x] Expand the AI's offered markets beyond saved accepted research and expose
  continuation beyond eight grouped markets/six copies and after number-alias
  verification misses. Record each gate and recovery action in diagnostics.

- [ ] Demonstrate the app's primary outcome after fixing the reported searches.
  Find a real deal the user can act on, with a specific available listing or
  eligible auction, matching price evidence, recent relevant sales activity and
  a supported after-cost purchase limit. Andrew reaffirmed that comparisons,
  completed research and engineering progress alone have not delivered this.
  For the next live validation use Find a flip across Buy It Now and auctions
  under ten hours, with the saved destination and a stated profit target. Record
  time to the first assessed copy, the price source used for each promising exit,
  recent matched sales, and the delivered cost and net profit. If the hunt ends
  without a qualifying copy, keep the closest priced miss and its gap to target,
  and record the reason the hunt stopped.

- [x] Show dated, labeled provider prices together on assessed listing cards, flip
  results and in the listing analysis. Compare the eBay sold sample, exact
  TCGplayer condition market and delivered asks, Pokémon Price Tracker, cited web
  observations, and applicable Cardmarket asks in EUR. Load additional providers
  when the buyer sees the card and reuse the original research account. A slab
  with no eBay sample can still show exact-grade estimates.
- [x] Import the exact PriceCharting product on demand, reuse the daily guide and store the published sale rows for Ungraded and grades 7, 8 and 9. Retain transaction IDs, source buckets, accepted prices and grade conflicts.
- [ ] Obtain express written permission for buyer-facing PriceCharting data and validate additional product mappings. Establish the available licensed historical coverage beyond the product page.
- [x] Give the Find a flip reviewer its pricing tools on an eligible TCGplayer-only copy even when the buyer omitted a liquidity preference.
- [x] Check a standalone resale recommendation against recent comparable eBay transactions and show how competing Buy It Now listings affect the turnover assessment. Reuse the inventory query and count distinct, verified competing copies separately.
- [ ] Extend the later-sale validation beyond graded Charizard markets. Pair raw forecasts with sales that have independently verified condition and measure fixed-price and accepted-offer errors separately from auctions.
- [x] Report the published 60-day PriceCharting sample by grade bucket, with distinct sales, selling days, observed daily pace and median USD. These buckets cover mixed conditions or graders.
- [x] Withhold the auction bid ceiling on a TCGplayer-only resale estimate. Show a supported maximum snipe with the estimated delivered cost and net profit if won at that maximum.
- [ ] Apply the final photographed identity and recent exit-sale check to newly discovered Bid recommendations wherever the finder currently applies it to Buy. Replay a wrong printing and an older sale.
- [ ] Replay a TCGplayer-only auction that later acquires verified sales, a duplicate eBay sale syndicated on PriceCharting, and a re-quote over the cap. Compare the displayed ceiling with the sniper draft under the same buyer budget.
- [ ] Let a reviewer turn a cited sale into a verified resale comparison. Retrieve the individual completed transaction, deduplicate by marketplace ID, match the printing and AI-assessed condition or slab grade, then recompute net profit and recent sales activity. Replay before validating a live opportunity.

- [x] Complete OpenAI interpretation before discovery for every newly submitted
  search. Send the original wording, resolve its meaning into a typed search
  plan, show the interpretation, then route the refined criteria into the app.
  Reuse the plan for Find new listings and watches under the same research
  account. Preserve explicit card, set, number, years, finish, grade, format,
  budget and profit constraints. Keep the buyer's original wording editable.
- [ ] Verify all reported natural searches in the normal interface, including
  `1999-2003 pokemon card holo`, `1999 venusaur`, the liquid vintage holo request
  and `find a deal on a holo card form neo revolution`. The last request should
  visibly resolve to Neo Revelation. A named card stays a named search, and a
  broad deal goal can choose liquid markets within its release constraints.
- [ ] Finish live latency acceptance using Neo Revelation or a broad vintage
  holo request. Andrew asked to stop testing Venusaur. Queued versus active
  work, six concurrent reviews, completed-result ordering and Stop have passed
  offline browser checks. Same saved Neo screening fell from 107.25 to 20.98
  seconds with zero providers, but a separate cold live metadata-only run still
  took 145.8 seconds. Measure first useful decision and completion separately;
  faster replay does not finish the live-speed requirement.

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

- [x] Add explicit continuation beyond the retained 50 using saved overflow and
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
- [ ] Measure how often resale-hunt recommendations actually sell at the projected profit and how long capital stays tied up. Compare observed rolling 60-day activity with realized outcomes for raw flips, slab resale and grading, without reinstating a hard transaction-count purchase veto.
- [ ] Build sourced liquidity scores and resale-time ranges from exact sales,
  active supply and coverage. Include holding preferences, grading/shipping time
  and uncertainty; broad sales counts do not prove a time-to-sale guarantee.
- [ ] Backtest trends, daily research plans and daily movers against exact-market
  history. Run shared daily work once at a random time between 5 and 6 a.m.
  America/Chicago, then compare newer and older BINs with defensible updated
  ceilings. One outlier or changing grade/condition mix is not market appreciation.
- [x] The personal product importer is available via `npm run pricecharting:guide -- PRODUCT_ID PRODUCT_URL`. It verifies the product ID, canonical URL, USD currency and column labels and reuses a successful observation for the day.
- [ ] Build the scheduled watchlist and Big Movers feed. Keep each batch small and space requests within the randomized morning window. Evaluate the [comic price updater](https://github.com/life423/comic-book-data) as a model for the Pokémon watchlist and Big Movers feed. Pilot a handful of variants against their PriceCharting product IDs. Test duplicate daily imports, missing prices, changed page structure and switching between standard and reverse holo before using a move to trigger eBay research.
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
- [ ] Respond to eBay Developer Support's November 25 follow-up. Review is
  awaiting an end-to-end API flow (authentication, call sequence, inputs,
  outputs and errors), a diagram or screenshots, and the eBay account used
  for bidding. Production access and permission for scheduled bids remain pending.
- **On hold at the owner’s request (November 24).** Resume sniper development and Sandbox testing when requested. The filed Growth Check remains with eBay.
- [ ] Record eBay’s decision on Production Offer API access and its answer on
  scheduling bids shortly before close. [My Tickets](https://developer.ebay.com/my/support/tickets)
- [x] Verify real Sandbox buyer OAuth on Windows. The local connection API and
  scheduler both confirmed the linked Sandbox buyer on November 25.
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

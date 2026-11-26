# Pokémon Flipper — current plan and resources

Updated November 25, 2026. This file records current decisions and locates the
resources behind them. [LOCAL_TODO.md](LOCAL_TODO.md) is the single active
checklist. [AGENTS.md](AGENTS.md) contains the working agreement. Git retains
earlier versions; obsolete planning reports are deleted rather than archived.

## Find a flip discovery and purchase evidence

### Proposed rollout for raw Buy It Now copies

1. **Shop the active market for one printing.** Start with the buyer's named card or choose a printing with repeated recent completed sales for a blank search. Group fresh and older active copies from the fetched eBay pages by printing, language, finish and seller-claimed condition. Track distinct listings, coverage, the lowest comparable delivered asks and missing shipping. Preserve an unknown group and a bounded collector-number or set search for thin inventory. Extend the existing Buy It Now comparison so this provisional inventory summary is available even before a matching sold price exists. Keep the source listing IDs, observation time and shipping destination.
2. **Select the copies an experienced buyer would open.** Compare a simple cheapest-comparable-copy baseline with AI-assisted ordering of the same inventory. Supply grouped asks, seller claims, existing photo observations and a small selection of original previews when the visual comparison could change the order. Ask for listing IDs, the observation that makes each interesting, and the specific question a closer look could settle. Look for clean copies priced among ordinary Near Mint listings and plausible, poorly described bargains. Record whether the model saw a photo. A promising preview authorizes research only.
3. **Verify the finalist with its original gallery.** Reuse the existing assessment to identify the actual card, edition, finish and physical condition. Link material findings to individual views. A seller's Mint claim, glare or a missing back leaves a question to resolve. Reuse compatible accepted observations when moving from selection to verification. A focused additional check should have a specific observation that could change the decision. Keep supported slab and grading routes in their existing evaluators.
4. **Price a competitive resale.** Compare the photographed copy with recent confirmed eBay sales of the same printing, finish and comparable physical condition. Use AI to resolve ambiguous titles or compare visible wear on sold copies. Code checks scope, deduplicates transactions, handles outliers and calculates the estimate. Compare that sold estimate to credible active competition and show the case for a competitive relist price. Keep PriceCharting, TCGplayer and Cardmarket labeled by market and evidence type. Recheck destination shipping and availability and use existing tax, fee, postage and profit calculations for the final Buy.
5. **Explain when the buyer could exit.** Reuse the existing history and liquidity code. Separate recent price direction from sales frequency and competing supply. Prefer a condition-matched eBay series for the resale outlook when sufficient. Label guide histories by source. Test directional predictions on later observations against a flat forecast. Give a holding-time range only when comparable listings have credible start and sold dates and the estimate works on held-out data. Otherwise show observed sales and competition. A buyer can be ready to list on receipt even when time to sale is unknown. A projection that needs future appreciation belongs in a separate hold scenario.
6. **Move to the next worthwhile copy or market.** Let the planner choose among eligible actions using what just failed. If the cheapest comparable copies already miss the target, look for a concrete variant or condition advantage or change markets. Preserve the buyer's scope, unchecked candidates, saved evidence, progress and original spending account across pages, Stop and Resume. Keep model choices within existing provider guards.
7. **Roll out only measured improvements.** Replay saved searches before paid work, comparing the current ordering, cheapest comparable first and AI-assisted selection on the same listings. Independently review a sample of selections and skips, including ambiguous titles and poor photography. Measure promising copies found early, missed opportunities, wrong products, duplicate paid calls, time to a decision and cost. Replay interruptions, quota pauses, changed galleries and stale terms, and test the decision tiles on phone, tablet and desktop. Then run one metered live Buy It Now search and report exact listing evidence, current terms, comparison sales, net margin, duration, charges and provider usage. A real qualifying copy is the acceptance milestone.

## Buyer decisions and saved strategies

- The first milestone is one available eBay copy a buyer can acquire and resell profitably after costs. A collector can instead ask for a specific copy at a good delivered price. Pilot results should distinguish an alert, a purchase and money received on resale.
- The search box takes the buyer's own words. OpenAI interprets the card or broad goal, set, release years, finish, format, budget, grade and profit target. “Liquid” means repeated comparable transactions. The original wording stays editable. Resolve a catalog-backed typo such as “neo revolution” and show the interpreted release.
- A blank flip hunt can pick any eligible Pokémon. A named hunt starts with that card. After misses allow a related printing of the same character or another liquid card from the same set or release era. Honor exact-only requests and explicit filters on every pivot. The current nearby-year default is two years on either side of a confirmed release.
- Search Buy It Now and auctions. An actionable auction has strictly under ten hours left, a current price below supported market value and a next valid bid inside the after-cost ceiling. Run both formats together when requested. Track the next twenty distinct alerts against the original ceiling and verified closing result.
- Retain distinct copies and page positions beyond the initial card markets and fifty-row review batch. Prioritize the fifteen selected for review, continue the rest, retry eligible transient failures and explain quota stops. Surface real listing cards and completed decisions while other work continues. Use another card for live latency checks.
- The AI can pick the market, the copy, the next function, a pricing source, a cited web lookup and the evidence panel. Independent checks can run together. Reuse paid work. Validate the listing and calculate the money in code. The buyer controls bids, purchases and seller contact.
- Estimate raw condition from the pictured copy, recognize an unstamped Unlimited printing when the correct area is visible, and read the grader and grade from a slab. Use set-specific evidence and resolve missing details where possible. Dark Gengar and Team Rocket Dark Alakazam are reported edition-warning regressions.
- Evaluate selling raw, selling an existing slab and grading raw. Show comparable prices for the exact printing, finish, language and condition or certified grade. Compare the likely grade and one lower. Include shipping, taxes, selling fees and applicable grading and fulfillment expenses in profit, return and purchase ceilings.
- Find a flip shows the lowest delivered TCGplayer ask for the assessed raw condition. A quote alone opens more research. A resale Buy or Bid needs a supported exit and observed sales activity. Label asks, completed sales and provider estimates. Compare observed sales per day, distinct selling days and the typical price range over two months. A single exceptional sale should not set value. Assessed listing cards show dated eBay, TCGplayer and Pokémon Price Tracker prices, plus matched Cardmarket asks in EUR and individual cited web prices when available. Visible cards request extra sources under their original research account. The on-demand PriceCharting importer saves published Ungraded and grade 7, 8 and 9 histories by exact product. Buyer-facing use requires written permission from PriceCharting and verified product mappings.
- Look for advantages in seller presentation, under-described condition, vague listing titles and number-only searches. For Leafeon compare full name, `167/203` and `Evolving Skies 167` at the same ceiling, then verify the original artwork. A shelf of unrelated items at a seller with a few Pokémon cards can justify inspecting their other listings.
- Keep the [seller and offer ideas](#andrews-seller-research-and-offer-ideas), [twenty product strategies](#twenty-deal-finding-ideas-to-test) and [fifteen supplied eBay tactics](#fifteen-ebay-tactics-for-the-deal-planner) as distinct lists. The selected product strategies are competing auctions, cross-market resale, clean-front binder copies, same-art alternatives and revisiting changed evidence.
- Longer-term collector ideas include scanning and centering, binders and want lists, price history, sealed products and additional languages, portfolio tracking, sharing and trade matching. Pilot the buying guide first and measure whether buyers act, pay and return.

## November 25 continuous Find a flip

The buyer’s goal is to keep Find a flip searching until a verified flip is found
or the buyer presses Stop. While open, it waits between inventory passes and through
recoverable quota resets. A server-owned local queue restores accepted work, source
cursors, pending copies and the original account after a reload or process restart.
The buyer can resume a disconnected session. A spending or storage hold needs attention.
Use “Find a flip” and “search” in the buyer interface. A fixed card, market or total
resale-step count cannot end a pass. Catalog suggestions rank the first queries;
they are followed by independent inventory discovery. Keep unreviewed physical
copies and source cursors under the original account, including later copies
of the same provisional market. Rotate continued query backlogs so one popular
card cannot monopolize the hunt. Batch/model/display windows bound work without
discarding the remaining inventory. The provider's retrieval ceiling still
requires honest partial-coverage reporting.

The local repair also adds provisional cards, simultaneous Both-format checks,
workspace cancellation, semantic subject evidence for ordinary-language goals,
an otherwise-supported final BIN terms refresh and likely-grade target
consistency. The current checklist and maintained audit record offline
acceptance; a new live profitable deal remains unproved.

## First verified guided flip

The first milestone is an available eBay copy that a buyer can acquire within a defensible ceiling and resell on eBay for a projected profit after costs. Record a subsequent actual purchase and resale separately if the buyer chooses to share them. The live broad hunt, costs and provider balances are recorded privately in LOCAL_HANDOFF.md.

1. **Separate the two buyer questions.** Give Find a deal a named-card comparison. Use a printing with observed recent eBay sales for the online acceptance run. For the requested English printing it may surface the best supported graded copy, a cheaper raw copy and an eligible auction. Each needs its own terms, comparable market and purchase ceiling. Display the strongest choice and explain when the cheaper copy is worse value. Find a flip starts with a resale goal and may explore related cards. Both use the existing photo, pricing and cost calculations.
2. **Start from a reproducible baseline.** Review the latest completed search diagnostic, replay its cited evidence and reconcile the in-progress liquidity and guided-routing changes with the local checkout. Verify the current Windows storage backend, saved assessments and spending accounts before paid work. Use the last measured broad hunt as the baseline for time, provider use and verified opportunities. Develop away from the server watching the buyer's active search.
3. **Build the entry points first.** Keep Find a deal, Find a flip and Evaluate eBay link accessible above the results. Give Find a flip an optional textbox and Buy It Now, Auctions under ten hours and Both. Switching tabs preserves each draft, running search, results and stop action. Typing or opening a tab makes zero paid requests. Both uses the original hunt account and cancellation signal across the two formats.
4. **Translate the submitted guidance into a route the buyer can see.** Interpret the text once on submission. Separate the starting card from hard constraints such as budget, set, date, finish, grade and exclusivity. For flexible Ampharos guidance, start with Ampharos, verify an Aquapolis printing in the catalog, then try other Aquapolis cards if the first stage produces no qualifying copy. Next try eligible vintage markets with measured sales. Show the active scope and why it changed. An exclusive Ampharos request stays there. Blank guidance starts directly with liquid markets from a diverse catalog sample.
5. **Price the targets before calling eBay.** Use dated sale counts and recency to rank the sample. Record the source, currency, period, coverage and whether volume includes multiple grades or finishes. Use exact transactions or explicitly labeled pricing evidence to estimate a resale range and provisional ceiling. Store scoped observations and timestamps in SQL, verify that identical lookups reuse them, and refresh listing terms separately. The ranking answers where to search. The pictured copy still needs its own price.
6. **Choose the next eBay request deliberately.** Start with one summary page for the strongest eligible query. Screen and deduplicate its copies locally. Favor plausible margin and a clue that a photo could resolve, such as a collector number in a vague title. The AI can choose among supported queries or close candidates. Spend a detail call when its answer could change the decision. Preserve the shared daily reserve, pacing and original request ledger through retries, both formats and other open tabs. Under quota pressure, finish the strongest affordable candidate before looking for more inventory.
7. **Prove the copy and its economics.** Use the seller's originals to identify the card, release marks, collector number, finish, language, condition and actual slab grade where relevant. Verify sales for that market, compute acquisition and exit costs and show the maximum item price, net dollars and ROI. Keep raw resale, slab resale and viable grading scenarios distinct. A weak listing can conceal upside when its pictured copy matches a stronger market. A seller's claim or an assumed premium for better photography cannot establish it. For auctions show the next legal bid and private ceiling. An unaccepted offer remains conditional.
8. **Run one online acceptance hunt starting in a liquid market.** Use blank guidance in the normal Find a flip tab so the highest observed seven-day sales count in the sampled catalog selects the first market. Use a separate session, fresh Buy It Now listings, the saved delivery destination and positive after-cost profit. Both receives offline coverage first. Record time to first useful result, total time, markets searched, distinct listings, copies checked, Browse calls, pricing credits and AI spend. Verify current terms for a qualifying Buy. If none qualifies, explain the closest copy's all-in cost, maximum payable price, shortfall or unresolved evidence. Diagnose whether discovery, identification, valuation or available inventory limited the result before spending on another hunt.
9. **Verify the buyer experience and replay the live findings.** Use photo tiles with green for supported profit, purple for active evaluation, lavender for selection and amber for missing evidence. Show the active card or market, completed checks, elapsed time and Stop. Replay an exact named-card comparison, anniversary Charizard, strict and flexible Ampharos, a blank hunt, changed shipping, cancellation, restart and a partial network failure. Check Both, keyboard operation and phone, tablet and desktop layouts. Run the isolated suite, type checks and build.
10. **Add history and test the next strategy against that baseline.** Chart USD TCGplayer history for the matching raw variant and condition, or dated eBay sales for the same slab grade. Label the period, source and sample. Test a short-term directional estimate on held-out dates against a flat baseline and suppress it with sparse or stale coverage. Next test collector-number queries and one seller-inventory follow-up against the baseline. Lots, bundles, auction clusters, alerts and tracking actual resale proceeds follow as evidence warrants. A daily best-buy view would rank still-available copies among the listings checked that day. [PKMNPrices history and sales volume](https://www.pkmnprices.com/docs/price-history)

The full [twenty deal-finding ideas](#twenty-deal-finding-ideas-to-test), [fifteen eBay tactics](#fifteen-ebay-tactics-for-the-deal-planner) and [collector experiments](#collector-features-worth-paying-for) remain below. Experiment with seller inventory, small lots, bundles, competing auctions and alerts after establishing the single-copy baseline.

## November 25 local reliability pass

The current local changes bind purchase advice to the buyer review's verified
resale route and preserve conservative lower-condition sold floors. Catalog
matching, continuation membership, quota recovery and global holds have focused
regressions. At the user's later request, per-search Browse and PKMNPrices
ceilings and preliminary pricing sublimits are removed. Historical limits and
attempts remain recorded; current requests preserve the eBay daily reserve,
provider pacing, cancellation and accepted evidence reuse. Broad automatic
searches diversify provisional markets before researching repeated copies.
Submitted natural language is validated against literal constraints, including
one-sided release years ("no newer than 2020" means through 2020). Explicit
liquidity requests prioritize recent matched sales and cannot produce a liquid
Buy/Bid from zero observed selected-route activity. Broad inventory uses a
Pokémon-anchored collectible-card query; exact-card alias recovery retains its
existing coverage. Typed accounting and input-verification failures preserve
their original reason and permit safe explicit recovery under the same account.
Buyers can save a US delivery ZIP in the app. Destination changes invalidate
browser quote advice while retaining accepted photos and prices. These fixes
are not committed or pushed. Cold live search quality and a qualifying deal
remain acceptance work, as recorded in the checklist.

The reseller's primary workflow should find a specific liquid copy within their
budget, regardless of card or set. Favor a short ranked buying list showing the
exact copy, delivered cost, supported resale value, all costs, net profit,
private purchase limit and observed recent matched activity. Keep verified
purchase opportunities, conditional offers and watches distinct. A sale count
is evidence of activity, not a promised resale date. Saved evaluations now seed
broad hunts on file storage as well as SQL; expansion beyond saved markets
remains necessary. Fresh-listing alerts and purchase-to-realized-resale feedback
are proposed next steps after the live deal milestone, not implemented promises.
Evaluate usefulness with actual buying decisions and a five-buyer pilot before
expanding features or redesigning the whole interface.

## November 24 pricing and recovery checkpoint

The current implementation adds raw resale estimates from exact TCGplayer
condition/printing offers after the AI assesses the live copy. Lowest delivered
competition sets the offer estimate, capped by the exact condition market value
when available. A condition market value can also supply a labeled fallback.
Neither source invents sold transactions. The latest user decision removes the
hard three-sale veto and shows actual rolling 60-day matched sales separately.
Sale summaries reject isolated high values rather than using an outlier as the
ordinary copy's resale value.

Unpriced hunt candidates can request the same repair as normal buyer review.
Eligible temporary browser failures retry up to three attempts, honor cooldowns,
and retain the original account; accounting/storage/configuration holds do not
trigger automatic spending retries. Discovery now retains overflow and source
continuation in batches of 50. Broad hunts still seed their markets from saved
accepted evaluations. Expanding beyond those seeds, browser acceptance of the
51st listing, cold latency and a verified live profitable deal remain next work.
See the stopping checkpoint in [LOCAL_TODO.md](LOCAL_TODO.md).

## November 24 progress and saved priorities

The [README](README.md) describes the usable app and setup. This plan keeps the
product ideas, and [LOCAL_TODO.md](LOCAL_TODO.md) keeps the remaining work.

Today's work expanded the AI's role from explaining a result to choosing which
research function to call and which evidence panel should open. The available
tools cover listing terms, original photos, matching sales, price references,
raw resale and grading economics. Independent checks can run together when they
concern different copies. The app retains the buyer's preferences, computes
money in code and reuses accepted evidence.

The current foundations also include cross-card hunts for collectors and
flippers, auction opportunities under ten hours, original bid-limit tracking,
fresh raw-card grading checks and collector-number discovery. These are working
research tools. Buyer purchases, successful resales and repeat paid use remain
outcomes to measure.

The collector-number comparison used the same $33.85 item-price ceiling for
the full-name search, `167/203` and `Evolving Skies 167`. Both alternate
queries found the same older Leafeon V missed by the name query. Its original
front showed 166/203. The first assessment had repeated the seller's incorrect
167/203 identification, so the new path compares the original illustration
against independently resolved catalog artwork before using the searched
market's sales. No verified alternate-art 167/203 qualified in this trial.
The older listing also fell outside the fresh-grading watch's 24-hour window.

Andrew selected ideas **5, 7, 16, 18 and 20** from the twenty-item list below.
Keep their original numbering. They mean competing auctions, cross-market
resale, clean-front binder copies, same-art alternatives and new evidence on a
saved listing. Initial app features exist for these directions. The next step is
measuring their usefulness on real inventory, with same-art alternatives a
lower priority than the four stronger selections.

The AI should handle every retained card in Sorting and Wait or skip, perform
the necessary investigation and give a useful buying decision. For a retained
batch of fifty, first review at least the fifteen eligible candidates selected
for inspection, then continue the remaining eligible work. A clear Buy, Pass or
Wait and its concrete reason should replace a generic request for the shopper's
review. Preserve the facts about missing evidence so the AI can try another
view, price source, copy or market.

Andrew authorized a substantial increase in API spending to make the workflow
work, including an earlier request for 20 times the budget. The later current
decision is uncapped OpenAI on this installation with recorded usage and
cancellation. Provider daily quotas and per-search accounting remain separate.
Measure useful decisions and errors alongside cost.

## Product goal and next milestone

Andrew reaffirmed the primary goal after the November 24 search failures. Help
the user find an actual deal. Working research tools, price comparisons and
avoiding overpayment do not complete that goal. The immediate priority is to
repair ordinary-language discovery and latency, then demonstrate a specific
available copy or eligible auction with matched value, sufficient resale activity
and a supported purchase ceiling. Consistent discovery is still unproven.

### OpenAI interpretation and search speed

The baseline [complete Deal blocker audit](docs/deal-blockers-audit.md) found a
reproduced integration defect: raw pricing gathers one accepted sold-condition
comparison, final resale requires three within thirty days, and the reviewer
never gathers the missing two. It also found inconsistent hunt eligibility and
permanent browser Waits after temporary failures. Incoming saved price samples
did not show a general cents/currency/date error. Repair the evidence and
recovery contracts before claiming the app cannot find deals because inventory
is fairly priced. The pricing and recovery checkpoint above repairs these
specific contracts; broad hunts currently use saved markets and do not search
every Pokémon card. Andrew asked to stop live Venusaur testing.

Andrew also requested a later price comparison that fetches and displays the
available values from every connected pricing API, including PKMNPrices,
Pokémon Price Tracker, OpenAI price research and applicable Cardmarket offers.
Include PriceCharting after obtaining buyer-facing data permission. Show source, date,
currency, card identity and condition or certified grade beside each price.
Finish the active search interpretation and speed fixes before this work.

Andrew's latest direction is to send the search-box text directly to OpenAI to
interpret its meaning, then pass the refined request into the app. A shopper
can describe a goal in ordinary language. Required trigger words or a growing
list of browser phrase patterns cannot define the search interface.

Save and test these reported failures together.

| Buyer request or observation | Required behavior |
| --- | --- |
| `1999-2003 pokemon card holo` returned one source row and no visible matches. | Interpret 1999–2003 as a release-year range. Search appropriate cards and filter releases by year. Keep the range out of literal marketplace keywords. |
| `1999 venusaur` returned 50 candidates and took minutes to finish a small fraction. | Preserve the named card and 1999 release constraint. Exclude known later reprints before photo research. Measure time to listings, first completed decision and first fifteen reviews. |
| `find me a deal on a pokemon card holo that is liquid from 1999-2003` treated “that is liquid” as the card name. | Return a resale goal, holo finish, year range and recent matched-sales activity requirement. Let the AI choose eligible card markets and research functions. |
| `find a deal on a holo card form neo revolution` treated the whole clause as a name. | Resolve the intended catalog set, show the interpreted Neo Revelation search, and restrict the hunt to that set. Obvious wording errors must not become required seller-title words. Preserve ambiguity when a correction cannot be established. |
| Every queued card appeared to be actively checked. | Show queued and active work accurately. Surface completed buyer decisions while the remaining cards continue. |
| Many serial photo, price and grading checks held only two listing slots. | Increase bounded useful concurrency and overlap independent grading lookups. Preserve exact identity, after-cost calculations, paid-answer reuse, provider limits and cancellation. |

The search interpreter returns one structured plan with the workflow, refined
query, card or set, collector number, years, finish, raw/graded choice, listing
format, buying goal and any explicit budget or profit target. The browser shows
the interpretation, then calls ordinary listing discovery or the market hunt.
Code validates catalog names and explicit constraints before marketplace work.
The AI chooses from existing research functions. Financial calculations and
evidence requirements remain in code.

Keep the original text and the accepted interpretation associated with one
search account. Find new listings and the active watch reuse that interpretation.
An interpretation failure must be visible before downstream searching. A
completed empty search must identify what was actually searched and checked.
Validate the original examples through the search box as well as offline tests.
Do not label an inventory miss as a profitable opportunity to make the test pass.

Build a buying guide that Pokémon collectors and resellers find useful enough to
pay for. The first offer answers a buyer's own question about a specific card:
which available copy fits their condition preference and budget after shipping
and tax, or what price or condition would make it worth waiting for?

Test the guide with five people already shopping for cards. Record what they
did with the answer, whether they paid for another comparison and what each
guide cost to produce. The [active checklist](LOCAL_TODO.md) tracks the pilot.
For resellers, the open milestone is still one available Buy It Now listing
reaching Deals with supported positive profit after costs.

Best current buy ranks checked listings by percentage savings against recent sales
of the same printing and assessed condition or slab grade. The purchase cost
includes destination shipping and estimated tax. Show the seller risks, comparison
coverage and resale economics when a copy qualifies below market.
It must never label a loss, an unaccepted offer or unresolved evidence as a Deal.
A buyer should be able to act on the first line. The app reads the photos,
checks matching completed sales and compares raw resale with grading after
costs. It gives a buy, pass or wait recommendation at the quoted price.
When further research cannot settle the value, explain what the app checked
and what would change the decision. The shopper should not have to find the
comparisons or do the grading math.
A separate raw-copy comparison shows the lowest checked purchase total and the
next-lowest for the same card, printing, finish, language and assessed condition.
It requires front and back coverage and can use clearly labeled, seller-described
matched sales as a collector reference. A certified PSA sale is displayed separately.
Only the resale calculation can put the listing in Deals.

From a saved exact-slab guide, the buyer can check live Buy It Now listings
against an all-in limit. The model chooses which listings need verification.
The app rechecks the slab identity, availability and destination shipping and
calculates tax before recommending a purchase.

## Collector features worth paying for

The November 24 comparison screenshot groups its offer into scanning and collecting, tracking value, tools, and community. It advertises Pro analytics, widgets, centering and binder scanning. Those labels tell us what another app offers. Willingness to pay for our version still needs a buyer test.

| Feature to test | What a collector should get from Pokémon Flipper |
| --- | --- |
| AI card scanner and condition | From a phone photo, identify the exact release, number, printing and finish. For a raw card, give one estimated grade, its confidence and the visible wear. For a slab, read its certified grade. Let the owner save that exact copy with its photos. The existing camera grader is a starting point. |
| Collections and watchlists | Support multiple named binders, sets and want lists. Keep duplicates as individual owned copies with purchase cost and condition. Watch a wanted card across new listings, with a delivered budget and acceptable wear. Test demand for unlimited lists before promising unlimited usage. |
| English, Japanese and Chinese cards | Add one language at a time with its own catalog, set numbering and matching sales. Test cards that share artwork across languages. Show when the exact language has too little evidence. Current supported searches are English. |
| Sealed products | Match the exact product, language, release and configuration. Show box versus case quantity and whether the wrap or seal is visibly damaged. Price it from matched sealed sales. |
| Current prices, price history and portfolio history | Show recent completed sales, their dates and condition next to the estimate. Save dated valuations for owned copies. Track acquisition cost, fees, realized proceeds and estimated net sale value. Show how much of a portfolio change came from prices versus adding or selling cards. |
| Market trends and Pro analytics for portfolios, sets and watchlists | Show which prints drove a change, how many comparable copies actually sold and which owned or wanted cards were affected. Highlight a newly affordable missing card, a lower-cost upgrade or a verified resale opportunity. Thin samples get a visible confidence note. |
| Home-screen widgets | Surface a short, actionable update such as “A wanted copy is within budget.” Include the last check time and open the exact listing and evidence. Test the alert in the app first. |
| AI centering tool | Mark the border measurements on the original image, report front/back ratios separately and request a straighter retake when perspective makes them unreliable. Test estimates against straight-on scans with manually measured borders. |
| Binder page scanning | Detect cards by pocket, preserve order, flag duplicates and ask for a close-up of an ambiguous slot. Let the buyer correct one pocket without rescanning the page. Test a nine-pocket binder against its owner's inventory. |
| Shareable profiles and lists | Share a chosen want list or binder with a revocable link. Keep private costs, notes and storage locations private by default. A recipient should be able to see exactly which printing the collector wants. |
| Follow collectors, activity feed, friend trade matches and leaderboards | Start with a two-way trade match using each friend's duplicates and wants. Show condition-adjusted values and the difference both ways. Test opt-in follows and a feed for wanted-card availability. Consider optional set-completion leaderboards only after people return to share or trade. |

**First paid experiment**

Ask a collector for one exact card, condition and all-in budget. Deliver a verified listing or a specific reason to wait, then offer to watch for the next matching copy. Measure whether they act on the recommendation, pay for the next one and return for the alert. Next test scanning a card they own and comparing selling raw with grading at the estimated grade and one grade lower. The [active checklist](LOCAL_TODO.md) tracks these tests.

## Current implementation

- Search intent, catalog lookup, listing discovery, exact sold screening,
  prioritization, photos, deterministic valuation and saved results share one
  workflow. Preserve raw resale, existing slab resale and raw-to-CGC/PSA grading.
  For raw cards, check whether the likely grade covers purchase, grading and
  resale costs. Also compare the live card's condition with photos of completed
  sales for the same printing. A worse-condition sale can support a conservative
  resale price when there is no verified same-condition price. Show the conditions
  and the sold price used, without adding an assumed premium for the cleaner copy.
- A pass can fetch 200 eBay summaries. Discovery screens beyond 50 unresolved rows
  before deciding which 50 to retain for assessment/display. A thin newest-first
  BIN pass can add one lower-price pass under the original research account.
  Saved overflow and source cursors continue under the original account.
  Durable whole-hunt restart recovery remains on the checklist.
- A fixed-price listing can be worth researching when its delivered ask is
  below both the other matching asks and recent sold prices. Use the smaller
  discount and show both sample sizes. Keep seller-described condition and
  photo-assessed condition distinct. Verify the actual item, buyer's shipping,
  tax, selling costs and, for a grading strategy, the downside grade before
  making a resale recommendation.
- The November 24 trace reproduced 19 below-market listings from a 25-listing
  snapshot. Three available listings had a positive spread after estimated costs
  at the original median. Photo and condition checks found one wrong card, one
  projected loss and one unresolved resale value. A fresh search also surfaced
  two grading candidates. Neither had sufficient evidence to recommend buying.
  Keep the listing-level receipts in private validation storage.
- Metadata establishes preliminary research scopes. Corroborated photographs or
  slab labels establish physical identity. First Edition, Shadowless, Unlimited,
  releases, finishes, languages, graders, grades and special tiers stay separate.
- Current pricing uses eligible exact eBay transactions, supplied through
  PKMNPrices. One valid sale can support sparse pricing with low confidence.
  Recent sales and known BIN cohorts matter more than a stale aggregate;
  the recent four-sale/48-hour rule and format-aware outlier handling exist.
  Exact condition/printing TCGplayer offers or condition market values can now
  set labeled raw resale estimates. They do not supply completed-sales activity.
- Clear slab labels establish the certified grade. Check identity, holder
  condition and authenticity concerns without grading the enclosed card again.
  Raw grades are photo estimates with honest confidence, independent of seller text.
  Keep eBay’s category examples separate from actual seller disclosures about that
  card. Verify fixed-price terms on the item before spending on Buy It Now photos.
- Fees, purchase tax, resale tax fee bases, inbound/outbound shipping, supplies,
  grading, profit, ROI and purchase ceilings stay in code. Any targets remove
  the minimum targets, not costs or the positive-profit requirement for Deals.
- Unknown destination shipping is provisional and differs from confirmed free
  shipping. Terms and market prices refresh separately from unchanged photo facts.
- Best Offer is enabled by default, with optional openings up to 15% below asking.
  Drafts and private walk-away limits do not submit offers. Automatic auction
  candidates must have strictly less than 10 hours remaining at the fixed search-start time.
- The built-in sniper rechecks auction terms and alerts the buyer before close.
  Scheduled automatic proxy bids target eBay Sandbox. Production bidding
  depends on eBay approval, buyer authorization and a successful Sandbox trial.
- Best current buy, projected losses, compact results and the desktop split
  inspector are implemented. At wide desktop sizes, analysis stays beside the
  results; smaller screens use an accessible modal. Opening, switching or resizing
  the inspector reuses accepted assessments.
- Shared SQL response and assessment storage exists. Shared transactional usage
  authority, normalized market history and durable server-owned research remain
  unfinished. Do not run independent replicas with independent local allowances.

Implementation details and invariants:
[architecture](docs/architecture.md), [money calculations](docs/money-calculations.md),
[financial sources](docs/financial-sources.md), [audit](docs/deal-search-audit.md)
and [validation](docs/validation.md).

## Work order

1. Run the collector pilot on buyers' chosen cards. Use saved evidence and
   automatic review to identify what prevented a useful buying decision.
2. Freeze and replay identical search inputs for unresolved rows beyond 50,
   Blastoise release ambiguity, a genuine loss and a supported profitable case.
   Exercise search → assessment → classification, not just an isolated calculator.
3. Fix the demonstrated blocker in the existing path, remove the retired code
   it replaces and preserve counterexamples, accepted evidence and accounting.
4. Validate Best current buy and the next plausible profitable BIN through the
   normal app with destination shipping. Report actual coverage, exclusions,
   unresolved reasons, final outcomes and spend. Zero live Deals can be a valid
   inventory result; it is not evidence that the entire market was searched.
5. Continue the prioritized checklist. Broader strategies, production bidding, forecasting
   and public deployment follow a trustworthy buying workflow.

No routine pause for a commit or preference question is needed. Commit, merge and
push when requested; preserve unrelated changes. Do not automatically purchase,
bid, submit offers or message sellers.

## API and evidence policy

Useful provider calls are authorized. eBay and PKMNPrices have daily quotas under
flat subscriptions; their requests and credits are separate from OpenAI dollars.
The user specifically wants more useful data coverage and AI at the right stage.
Zero calls or an arbitrarily cheap search is not the goal.

Per-search Browse and PKMNPrices ceilings are removed by the November 25 user
instruction, including old exhausted accounts. Existing ledgers retain their
historical ceilings, counters and unresolved attempts; compatible migration
never clears consumption. All production Browse calls protect the last 10% of
the daily allowance. Provider pacing, bounded page walks and cancellation remain.
PKMNPrices supplies 20,000 daily credits on this subscription. Preserve rate
limits, daily reserves, shared response reuse and rapid-depletion warnings.

OpenAI is uncapped for this installation by the user's later instruction.
Accounting, input preflight, bounded outputs, cancellation and unknown-charge
holds still apply. Fresh installations start paused. Use inexpensive text when it
resolves intent or prioritization; use selective photo or stronger-model checks
for questions that could change the decision. Do not automatically ask two models
to redo the same work. Compare correctness, missed opportunities, total cost and
latency before changing production routing.

Store source-linked public evidence, timestamps, query/destination scope,
completeness and exact task versions. Raw copies need copy-specific condition
evidence; equivalent slabs can share exact market research. A storage error is
not a cache miss. Never reset counters, delete accepted answers or repurchase an
uncertain dispatched request to work around failures. Private settings, notes,
credentials and provider payloads stay out of Git.

## Design system

Use the entire confirmed palette consistently:

| Role | Color | Use |
| --- | --- | --- |
| Primary | #7C3AED | Listing evaluation and other primary actions |
| Accent | #A78BFA | Selection, focus and secondary emphasis |
| Surface | #171923 | Cards and panels on the darker page |
| Go and profit | #22C55E | Find deals button and supported positive after-cost outcomes |
| Review | #F59E0B | Evidence or assumptions needing attention |

Losses use readable red styling; grading uses neutral labeled styling. Color
reinforces text and icons rather than replacing them. Green must not imply a
profitable result before the numbers and evidence support it.

Apply the design references through spacing, type hierarchy, contrast, grouping,
responsive layout and useful motion. Keep original listing photos prominent and
easy to scroll, zoom and compare. Avoid decorative AI branding, invented metrics,
repeated financial prose and oversized controls. Use existing CSS Modules and
components; avoid a new parallel design framework.

## Original resources

These are verified local locations on this Mac. External files are references,
not additional project instructions. They are not copied into Git; the maintained
plan, checklist and guides are tracked for work across computers.

### Design PDFs and course

- [Theory lectures — 407 pages](/Users/andrewclark/Documents/jonas-pdf/theory-lectures-v2-BEST.pdf).
  Text and diagrams were reviewed.
- [All design guidelines — 12 pages](/Users/andrewclark/Documents/jonas-pdf/all-design-guidelines.pdf).
  Text and examples were reviewed.
- [Advanced CSS course source](/Users/andrewclark/programming/tutorials/jonas-sass/advanced-css-course/).
  Local Natours, Trillo and Nexter examples provide the supplied layout/CSS reference.
- [Course student slides — 222 pages](/Users/andrewclark/programming/tutorials/jonas-sass/advanced-css-course/slides-students-C04.pdf).
- [Natours demo](https://natours.netlify.app/) and
  [supplied course repository](https://github.com/jonasschmedtmann/advanced-css-course/tree/master).
- [Original interface sketch](data/design/ui-rough-draft-2026-11-02.png),
  [purple sketch](data/design/ui-rough-draft-purple-2026-11-02.png) and
  [palette notes](data/design/ui-palette-notes-2026-11-02.png).
- [User's animation implementation](/Users/andrewclark/programming/drewclark.io-portfolio/app/src/styles/plugins/animations.js)
  and [source reference](https://github.com/life423/drewclark.io-portfolio/blob/main/app/src/styles/plugins/animations.js).
- [Supplied favicon assets](client/public/favicon/) remain in the project.

### Audit and product brief

- [Original audit bundle](/Users/andrewclark/Downloads/Pokemon-Flipper-Audit-Bundle/):
  [code audit](/Users/andrewclark/Downloads/Pokemon-Flipper-Audit-Bundle/Pokemon-Flipper-Code-Audit.md),
  [coverage CSV](/Users/andrewclark/Downloads/Pokemon-Flipper-Audit-Bundle/Pokemon-Flipper-Coverage.csv),
  [flow image](/Users/andrewclark/Downloads/Pokemon-Flipper-Audit-Bundle/pokemon-flow.png),
  [flow SVG](/Users/andrewclark/Downloads/Pokemon-Flipper-Audit-Bundle/pokemon-flow.svg)
  and [reproduction instructions](/Users/andrewclark/Downloads/Pokemon-Flipper-Audit-Bundle/reproductions/README.txt).
  The reproduction folder contains discovery, client, shared, AI-guard and
  analysis cases plus its Python runner.
- [Original audit ZIP](/Users/andrewclark/Downloads/Pokemon-Flipper-Audit-Bundle.zip).
- [Pasted app brief](/Users/andrewclark/.codex/attachments/5bfc761f-925c-4308-b6b8-e0c28ef57b8a/Pasted%20text.txt).
  Its earlier budgets and behavior descriptions do not override current decisions.
- The original `pokemon-flipper-deal-fixes.patch`, debugging PDF titled
  “Debugging Why Pokémon Flipper ‘Can't Find a Deal’” and PKMNPrices `ppp.pdf`
  were not found at their former locations. Recovered actionable findings live
  in the maintained audit, provider notes below and active checklist. Their
  originals have not been deleted by this cleanup.
- Saved listing photos, responses, ledgers and automatic diagnostic reviews
  remain under ignored `data/`. They are evidence for replay, not public reports.

### Strategy references

- Andrew’s [comic-book-data project](https://github.com/life423/comic-book-data) is the reference for a possible Pokémon PriceCharting importer. Its [scraper](https://github.com/life423/comic-book-data/blob/main/scraper/price_scraper.py) reads prices for owned Amazing Spider-Man issues, and its [scheduled workflow](https://github.com/life423/comic-book-data/blob/main/.github/workflows/daily-price-update.yml) updates collection data daily. Andrew reports it operated for over two years without a ban. For Pokémon, prototype a small watchlist keyed by exact release, number, language, finish and grade. Save dated source values, keep the prior observation on failure and check a price move against matched sales and live delivered prices.
- The supplied [Pokémon Flipper Trends Google Cloud project](https://console.cloud.google.com/welcome?project=pokemon-flipper-trends-2026) is available to evaluate when the PriceCharting importer resumes. Save credentials outside Git. The manual importer now saves one observation per product per UTC day. The scheduled job is pending. Its eventual scheduler should use small batches, randomized request timing and one durable claim per product and observation window so overlapping jobs and restarts cannot duplicate a scrape.
- [PriceCharting Pokémon big movers](https://www.pricecharting.com/big-movers?category=pokemon-cards):
  future daily lead research at a random time between 5 and 6 a.m. Central.
  A mover is a hypothesis to verify against exact sold evidence and current BIN
  inventory; an aggregate raw increase does not establish a graded-market gain.
- The buyer spotted a newly listed raw Shadowless Alakazam and judged it Mint
  from the photos. The seller listed it as Near Mint. The incorrect First
  Edition item detail played no part in the purchase. Replay the purchase as an
  example of finding a clean copy early. Use the pictured printing for comps
  and treat the buyer’s condition assessment separately from a certified grade.
  [Purchased Alakazam listing](https://www.ebay.com/itm/227548256279).
- [Shadowless Mewtwo PSA 7 auction example](https://www.ebay.com/itm/366764764463):
  November 3 worked example for code-calculated ceilings, separate lower resale
  scenarios and exact market matching. Its prices are not current recommendations.

### Pricing a slab with few exact sales

Read the grade from the holder. Use PKMNPrices for individual sold transactions. When those are sparse, look up the exact printing and grading company on Pokémon Price Tracker, including half grades. Show the estimate in dollars, its date, the number of reported sales and the total purchase cost. A buyer should be able to tell whether a figure represents a completed sale, a provider estimate or an active asking price. AI can search for missing completed transactions within the original search budget. Reuse the lookup across listings and replays. The PriceCharting importer supplies personal guide observations. Publishing these values in the buyer app requires express written permission.

The $999 CGC 8.5 Dark Gengar has a separate exact comparison. The sold copy has certificate 6222960110 and sold for $999 on October 12. The listed slab has certificate 6216397042 and costs $1,081.42 with estimated tax. The app’s November 24 check found a $927.93 90-day estimate at medium confidence for this printing and grade. The eight-sale count covers the provider’s entire history. The buyer sees the age of the evidence and the scratch on the holder. [Completed eBay listing](https://www.ebay.com/itm/327355249346)

### Let AI choose what the app does next

In an opt-in deal hunt, the buyer gives a goal such as “find me a raw card worth grading.” The AI chooses a strategy from the available ideas and calls the relevant app functions. After each result, it can choose another function, switch strategies or finish. The three checks in the saved slab guide are one early example. Give the planner access to more of the app as its research tools become available.

For someone flipping cards, the Pokémon and set are optional. The question is whether a specific available copy can be bought, graded if appropriate and resold at a profit, and whether enough comparable copies actually sell. **Find a flip** starts from the search screen with the buyer’s price, profit and ROI settings. The planner uses saved sales to select markets, checks live listings in the requested format and opens the evidence behind its decision. After a named search, buyers can keep the hunt on their results or allow another card from the same set. Resellers can also allow any set.

For an auction hunt, try `Find vintage holos from 1999–2003 I can flip for at least $25.` The planner carries the release years, finish and profit target across candidate markets. It can move to another liquid card after misses, sample a promising seller’s other listings, or inspect a raw copy for grading upside. The app verifies the current bid, destination shipping and recent sales before calculating the next-bid profit and maximum item bid.

Collectors can try `Find graded holo auctions from 2021 to 2024 for my collection under $300 delivered`. Matching sold copies and the buyer’s delivered budget determine the ceiling for keeping the slab. A flipper looking at that same auction gets a separate ceiling based on selling costs, profit target and recent sales activity. Keep both audiences in the pilot and rotate the cards used for testing.

On an auction the planner can select independent checks on two different listings in one turn. On a raw copy it can ask for an original photo detail that resolves the edition, compare selling at the assessed condition, evaluate grading, or move to another liquid copy. Evidence from a check can change which calls are worth making next.

In the November 24 live collector trial, a seller titled a [2023 Mew PSA 9](https://www.ebay.com/itm/307286129400) “Crown Zenith #GG10.” The gallery number identified the subset and the slab photos confirmed the copy. At 10:43 a.m. Central, the next bid was $37, or $46.54 delivered. Nineteen matching sales supported $107.50. The collector item-bid limit was $93.32. A separate live flipper search from the browser independently picked the same Mew at 10:45 a.m. With a $25 profit target, it recommended bidding up to $47.88 and projected $36.77 profit at the next bid. The auction tracker recorded the $47.88 original ceiling for comparison with the eventual sale.

An opportunity must still be open with strictly less than 10 hours left and a current auction price below its supported market value. Results retain the original ceiling for each actionable alert. Closing checks match the eBay item to a completed USD auction sale. In a retrospective check, a 2000 First Edition Dark Machamp PSA 8 was at $127.50 against a $136.90 ceiling and closed at $274. The next live trial should measure how often alerted auctions close within their original limit and whether prioritizing general-merchandise sellers improves the results.

A resale hunt shows distinct matching completed sales in the previous 60 days for its proposed exit, without a hard minimum-count purchase veto. Match the printing and finish, then the assessed raw condition or the actual resale grader and grade. Show the count, scope and window separately from a TCGplayer asking-price estimate and projected profit after costs. Evaluate the observed activity against actual sales and time to sell during the buyer pilot.

Let the AI also choose the existing page or panel that best explains its finding. For a newly listed raw Alakazam, it could use the original photos, look up sales at the likely grade and one grade lower, then show the grading costs and profit scenarios beside the search results. For a CGC 8.5 Dark Gengar, it could read the holder, reuse exact-grade sales and open the price comparison for that copy. Neither path requires the buyer to navigate through the intermediate checks.

Expose each supported function and view by name, with the inputs it accepts. The app executes the selected function, supplies the result and opens the selected view for the same listing. Reuse paid evidence, enforce the search budget and calculate money in code. Record the steps and why the AI chose them so the buyer can see what led to the decision. Purchases, bids and seller contact remain buyer actions.

### Andrew’s seller research and offer ideas

November 25 clarification: the fifteen supplied eBay tactics are options to
consider, not approval to implement every one. For the reseller pilot, the
current proposed first group is collector-number discovery, photo-confirmed
variant corrections, prepared ceilings for fresh listings, and same-seller
inventory research after a real pricing opportunity. The user's strongest
combination is number search → exact photographed variant → seller inventory →
one conservatively priced bundle. Bundle/lot advice needs independently
identified cards, verified combined delivery, selling costs and zero value for
unidentified extras. Photograph requests, offers, bids and seller messages still
require their existing explicit authorization; saving tactics does not send them.
Keep same-art and multilingual alternatives as distinct collector markets;
the current English-only scope is unchanged.

- **Find mispriced cards from sellers who rarely list Pokémon.** Open the seller’s other items. A store full of tools or clothes with a few vaguely titled Pokémon singles is a reason to look more closely. Sample across categories, save how many items were checked and reuse that sample across the seller’s listings. Inspect plausible cards for overlooked printings or unusually good condition, check exact completed sales, then calculate what the buyer could make after costs. The inventory mix sets research priority. Feedback measures a different kind of risk.
- **Compare how the seller photographs condition.** If the seller discloses edge or corner wear and the sleeve hides the affected area in every photo, pass. If their other cards have unsleeved closeups, report that observable difference without speculating about motive.
- **Assess what is visible through a sleeve and draft a request for the missing view.** On the Neo Destiny Dark Gengar 6/105 example, the front is visible and the gallery includes a back. Read both originals, give a best estimate of the play condition and one numeric grade with confidence, and identify the visible feature behind it. Reflections can limit confidence about holo scratches. Keep the general photo-grading disclaimer in the footer. If an extra photo could change the buying decision, offer a copyable, editable message specific to that card and angle. Example for this listing: “Hi! Could you take a straight-on photo of the back of Dark Gengar out of the sleeve and a slightly tilted shot of the holo so I can see the surface? Thanks!”
- **Send a buyer-authorized Best Offer with an optional witty note.** On an eligible listing, use the existing opening offer and private walk-away limit. Draft one short, editable line specific to the card, with plain and playful options. Let the buyer approve an individual offer or opt into sending within an explicit total budget that covers all outstanding offers. Check the shipped and taxed total, record the sent offer, and reconcile its status before any retry. Confirm the application’s production access and buyer authorization before enabling delivery. eBay documents an optional message on its buyer-side `makeOffer` operation. [eBay buying API migration guide](https://developer.ebay.com/develop/guides/sell/modern-apis-migration-guide)

### Twenty deal-finding ideas to test

These are product hypotheses. Start with small lots for flippers and clean-front
copies for binder collectors. Reuse the existing exact-sales lookup, photo
observations and cost calculations. Measure which buys survive verification and
which recommendations shoppers act on before expanding the feature set.
The [fifteen eBay tactics](#fifteen-ebay-tactics-for-the-deal-planner) turn several of these ideas into concrete research choices for the buyer's goal.

The earlier seller and market hypotheses remain in scope too. Independently
inspect a seller-described LP copy that may be Near Mint, or a Near Mint copy
that may be Mint. Follow an unusually cheap completed sale into that seller's
current inventory. Test whether watched BINs, listing age, price changes,
promoted placement or weak presentation reveal an opportunity. For relisting
upside, source the resale margin for the pictured condition and distinguish
clearer photography or a better description from physical improvement.
Deduplicate promoted and organic appearances. Use repeated exact-market sales
to test daily movers and stale prices, and save one reusable daily research plan.

1. Small lots. Price the two or three easiest cards to sell against the entire purchase. Count unidentified extras at zero and include fulfillment for each sale.
2. Choose-your-card listings. Read the exact in-stock variation, its price and the photos that apply to that individual copy.
3. Same-slab sale history. Match a readable certification number to a documented previous transaction. Check for relists and corroborate with recent sales of other copies.
4. Documented print errors. Recognize a specific, collectible error with a published example and exact sold evidence. A stain or camera artifact cannot establish it.
5. Competing auctions. Spot clusters of identical slabs ending minutes apart inside the 10-hour window. Show each buyer which single auction fits their delivered ceiling.
6. Dealer cash offers. Compare a listing with an accessible, current cash buylist that accepts its printing, condition and quantity. Include shipping and a downgrade scenario.
7. Cross-market resale. Compare a purchase with completed sales at a venue the buyer can sell on. Use that venue's fees, fulfillment and exact matching rules.
8. Complete a sellable set. Identify the missing piece of a trio or promo set. Compare proven set proceeds with the existing pieces' net resale value and the missing piece's cost.
9. Damaged holders. For an intact certified slab with cosmetic holder wear, compare selling as-is with an eligible paid reholder and two-way shipping.
10. Buy a lot and keep one. Price the collector's target after conservative net proceeds from the other identifiable cards. Show the upfront cost and the cost if nothing resells.
11. Combined shipping. Find pairs of wanted cards from one seller where a verified basket quote beats the cheapest split orders.
12. Quantity discounts. Use actual volume pricing and available quantities. For a reseller, show proceeds on the first copy and recent demand for the rest.
13. Private seller offers. Evaluate a real offer supplied by the buyer against exact sales and the cheapest public alternative. Check the offer terms and expiration.
14. Overseas inventory. Verify the same English release and compare foreign and domestic copies after conversion, shipping and applicable import costs.
15. Pickup opportunities. Find listings with usable local pickup and compare the checkout total plus the buyer's travel cost with delivered alternatives.
16. Clean-front binder copies. Compare visibly clean fronts with documented back-only wear. Show the affected areas and the dollar saving against a cleaner copy.
17. Grade-price inversions. Find a higher grade offered below a lower grade the collector is considering. Verify the same printing and grader and price each grade on its own evidence.
18. Same-art alternatives. When the buyer wants the illustration, identify cheaper verified releases with the same artwork and name the actual printing.
19. Collection upgrades. Price the all-in difference between buying the desired copy and the net proceeds of selling the buyer's current copy.
20. New evidence on a saved listing. On a changed gallery, inspect the new photo that could resolve a prior stop, then explain whether the verdict changed. Reuse accepted evidence.

### Fifteen eBay tactics for the deal planner

For a flipper, test whether the specific copy can sell often enough at a profit after costs. For a collector, start with the printing, artwork, condition and delivered budget they actually want. Match completed sales by card number, set, printing, language, finish and raw condition or slab grader and grade. For an accepted Best Offer, use the actual accepted price when documented and exclude a crossed-out asking price from the sale calculation. [eBay Product Research](https://www.ebay.com/help/selling/selling-tools/terapeak-research-and-SEO?id=4853)

The planner can already choose among offered markets, inspect a listing and its photos, resolve printing, read sales and price references, and calculate raw resale or grading economics. It can propose its own explanation for a mispricing and revise it after a check. [Deal hunt planner](server/analysis/deal-hunt.ts)

1. **Find the card by number.** When a fixed-price raw-card market search finds no eligible new copy, the hunt tries the printed fraction and the set plus its collector number at the same item ceiling. It counts each eBay listing once. For a number-discovered lead, the app checks the original front against independent catalog artwork before using that market’s sales. A future trial can compare common misspellings.
2. **Search the words a casual seller uses.** Try “old shiny Pokémon cards,” “childhood card binder” or “Pokémon dragon card” across broader categories. Existing photo inspection can identify an eligible single. Add broad-category discovery and lot handling before recommending a binder.
3. **Learn one commonly confused variant.** A vague holo description can hide a valuable stamp, edition or finish. Inspect the relevant part of the original photo, confirm that the variant exists in this release, then fetch sales for the pictured printing. Use the set-specific printing check already available.
4. **Find the overlooked card in a lot.** A supporting card in the last photo may cover much of the purchase. Add a lot reader that checks every photo, deduplicates repeated views, prices identified cards at their visible condition and assigns obscured or unidentified cards $0.
5. **Calculate what the keeper costs.** Extend the lot calculation to deduct realizable net proceeds on the unwanted cards. For example, $90 delivered minus $50 after selling fees, postage and packaging gives a $40 effective cost. Count unsold cards at $0. The buyer pays $90 up front, and the keeper costs the full $90 if nothing else sells.
6. **Follow a seller's pricing pattern.** A seller asking the same amount for every holo may have overlooked one card. The existing category sample can justify another photo check. Add a sibling-listings lookup, compare actual asking prices and verify each sibling's exact identity, condition and sales independently.
7. **Set the ceiling before the listing appears.** Use exact recent sales, liquidity and all costs to calculate the maximum item price. A newly listed Buy It Now copy can trigger a terms and photo check against that ceiling. Extend the bounded fresh-listing check to persistent buyer targets and refresh stale sales before alerting. [eBay saved searches](https://www.ebay.com/help/buying/search-tips/saved-searches?id=4051)
8. **Ask for the one photo that could change the decision.** Use the photo review to identify the missing evidence. Draft a specific request for an unsleeved back or a tilted holo surface. Add a seller-message draft and a changed-gallery check that reuses the other photos. The buyer chooses whether to send the request.
9. **Propose a specific on-eBay bundle.** Combine the target with slower-moving cards the buyer genuinely wants. Add a bundle calculator and editable draft naming each card, the proposed total and delivery terms. Compare the seller-agreed combined delivery charge with separate purchases before assigning any savings. [eBay combined shipping](https://www.ebay.com/help/ship-track/ship-track-buying/combined-postage?id=4063)
10. **Evaluate the first actual seller discount.** Watch a promising copy whose public price exceeds the ceiling. Add an input for a private seller offer and its expiration, then recalculate the delivered cost against exact sales and other available copies. A discount enters the math only once the buyer receives an offer. [eBay Best Offer](https://www.ebay.com/help/buying/buy-now/making-best-offer?id=4019)
11. **Follow up after a verified unsold auction.** An expired listing alone leaves the result unknown. Add an explicit unsold outcome and a draft asking whether the seller would relist at a specific fixed price on eBay. Recheck the live relist's identity, availability and delivered price before recommending it.
12. **Watch later copies from the same seller.** A seller running several similar auctions may attract fewer bids on a later one. Add same-seller grouping, independent ceilings for each copy and a remaining-quantity counter. Recheck the next legal bid within the ten-hour window and stop once the buyer has filled their quantity.
13. **Plan a late bid at a fixed ceiling.** Use the current auction checks for a live copy with strictly less than ten hours left, a below-market price and a next bid within the buyer's after-cost ceiling. Skip the auction once the next legal bid exceeds the ceiling. Scheduled bidding stays on hold. [eBay bid sniping](https://www.ebay.com/help/buying/bidding/bid-sniping?id=4224)
14. **Find eye appeal a collector values.** Inspect front and back separately. A clean-front binder copy with back whitening, or a lower-grade slab with attractive artwork, may satisfy the buyer for less. Price it at its actual raw condition or certified grade. Add an explicit front-appearance preference to compare suitable copies.
15. **Follow the artwork across releases.** For an artwork-first collector, compare English promos, reprints and finishes that actually share the illustration. Add artwork matching and price each release independently. Extend discovery to other languages only after language-specific identification, numbering and matched sale coverage are supported. Current searches and pricing cover English cards.

**Example chain, 1 → 3 → 6 → 9.** A number-only query finds a vaguely titled holo. The AI checks its pictured edition against matched sales. If the seller appears to price several holos identically, it can investigate a second card the buyer wants. Once both copies are verified, it can draft a two-card offer within the buyer's combined ceiling. This chain needs the alternate-query, sibling-listing and bundle tools above. At each step, save the clue, the tool chosen, the observed result and whether it changed the buyer's decision.

## Retained provider and storage lessons

PKMNPrices catalog records provide canonical names, set/number/language context,
images and useful metadata; card details supply prices. A catalog candidate is
not proof of the photographed copy. Preserve aliases and exact printed forms.

Daily price history is TCGplayer/Cardmarket aggregate context, not exact graded
eBay transactions or liquidity. Individual eBay observations require currency,
printing, grader/grade, qualifiers, sale type and actual final-amount provenance.
Provider volume is coverage, not total market demand or measured time to sell.

Use ingestion cursors for arrivals and update cursors/source IDs for corrections.
Late ingestion may describe an old sale. Deleted observations need bounded
reconciliation. Daily market refreshes and listing/photo freshness have different
clocks. Bulk exports have plan/access and download limits; do not assume unlimited
access or download the whole catalog without a useful reason. Verify changing
provider details before implementation.

Azure SQL Basic is the selected shared database foundation. Keep large image bytes
outside SQL, with fingerprints/references inside it. Use focused evidence/cache/job/
usage/user repositories beneath one backend before adding services. Finish shared
task claims and atomic spending/quota authority before independent replicas.
Never hold a SQL transaction open through a provider request. Preserve dispatched
unknown outcomes and save accepted answers through recovery rather than calling
again. Measure capacity, retention and backups before wider release; verify
current service terms and prices before changing infrastructure.

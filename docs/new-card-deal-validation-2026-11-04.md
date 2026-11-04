# Ten new card targets: outcome and bottlenecks

## Measured result

Ten new English Buy It Now card targets returned 151 distinct listing
candidates and **zero verified Deals**. Eight searches specified a slab
grader/grade; two included raw and graded inventory. These were bounded source
windows, not exhaustive searches of all inventory or all grades. Candidates
were preliminary metadata, not 151 confirmed photo identities.

| Target | Returned candidates | New generations | Generation cost, cents |
| --- | ---: | ---: | ---: |
| Rayquaza V | 18 | 9 | 1.52008 |
| Giratina V | 16 | 6 | 0.94850 |
| Jolteon | 4 | 2 | 0.31408 |
| Vaporeon | 1 | 0 | 0 |
| Celebi | 2 | 0 | 0 |
| Raikou | 2 | 0 | 0 |
| Scizor | 2 | 0 | 0 |
| Flareon | 6 | 0 | 0 |
| Tyranitar | 50 | 4 | 1.44516 |
| Zapdos | 50 | 0 | 0 |

Total: **$0.0422782**, 21 generation requests, zero unresolved spending holds.
Every original search stayed below $0.02; neither the cap nor production model
defaults changed. Six searches purchased no photo analysis. An extra Gengar
control, discovered to be a previously searched card, is excluded from the ten
new targets: it added $0.003062. All generation work therefore cost $0.0453402.

The ten targets used 34 actual eBay Browse requests and 75 PKMNPrices requests,
with 372 header-reported credits. Diagnostic setup also made 22 Analytics and
11 OAuth requests; those are separate from Browse usage. The extra control
added three Browse requests and 35 price credits. Provider requests/credits are
not generation dollars. Reusable responses and readings use existing SQL
storage; owner spending and valuations retain their existing separate storage.

## Concrete corrections

- Exact art descriptors and context-matched SWSH publisher wording no longer
  prevent conservative literal name extraction. Original titles still control
  form, printing, finish, grade and special-label checks. This lets existing
  sold-price screening reject confidently overpriced modern slabs before photos.
- Miscut inventory cannot borrow an ordinary slab market. Jungle No Symbol
  claims and accepted observations likewise retain a distinct unsupported
  market scope. Fresh and saved financial views cannot price them as ordinary
  Jungle, and premium sold rows cannot inflate ordinary Jungle prices.
  Missing market data stays Sorting rather than becoming a manual photo task.
- Diagnostic Stop now waits for underlying accepted-response saves before its
  final usage snapshot and SQL shutdown. A bounded timeout marks the report
  incomplete and preserves claims and holds. Giratina resumed its original
  search ID and reused accepted work; no spending reset was used.

## Why more photo budget is not the next fix

Several exact slab scopes exhausted their available cached sold pages with
only zero, one or two eligible transactions. Many historical rows have a price
but null sale type and no alternate final-amount field; they cannot safely be
promoted to confirmed transaction amounts. Two narrow title-matching losses
were identified, but recovering them would not change a blocked market's
outcome in this sample.

At the time of this batch, automatic photo admission required three applicable
sales, while final slab valuation could use one or two at LOW confidence. The
subsequent one-sale change below resolves that admission mismatch. Current
competition may constrain a sparse estimate, but asking prices must remain
separate from achieved sales.

Fresh raw resale has a separate architectural gap: the bounded evaluator
reuses historical sold-copy photo-condition readings but does not create them.
The newly tested raw targets had no reusable condition-matched evidence.
Raw-to-grade remains possible when photos support a numeric range; the new raw
answers abstained. Deriving numerical grades from seller condition or inventing
sold-condition evidence would hide this gap rather than repair it.

The next useful milestone is one supported profitable listing through the
ordinary queue and Deals selectors. Prioritize usable exact-market evidence,
confidence-aware sparse admission and selective inexpensive ambiguity resolution.
Preserve accepted photos and measure total cost and missed candidates. Raising
the cap alone does not supply missing market evidence.

At the ten-search checkpoint, 944 offline tests, server/client typechecks,
production build and whitespace checks passed. Raw provider payloads, listing details, original IDs and
reproducible diagnostic reports remain in ignored local evidence storage.

A strict saved-only Jolteon replay reused both accepted readings, removed their
ordinary-market pricing and placed the two No Symbol listings in Sorting. It
made zero generation, preflight, image, Browse, Analytics, OAuth or PKMNPrices
requests and added no cost. This validates the saved-evidence correction; it is
not another live availability check or a new profitable opportunity.

## Subsequent one-sale policy and cleanup

The user requested a minimum of one matched sale. Screening now admits one
eligible match and stops unnecessary cursor research; exact scope, transaction,
currency, printing, finish, grader and grade checks remain. One or two sales
retain LOW confidence. Graded pricing prefers the 90-day market as soon as one
valid current sale exists, so older sales cannot displace it through a blended
median or outlier rule. The labeled 180-day fallback applies only when there
are no eligible current sales. The separate final raw condition-evidence
requirement is unchanged.

Pricing revision 11 refreshes old financial snapshots while reusing accepted
photo/condition evidence. Removed the unused title-filling function and its
three orphaned tests, preserving active title readers and saved-answer reuse.
Final checks: 942 offline tests, both typechecks, production build and whitespace
checks pass. These changes required no paid/provider calls; they have not yet
been validated by another live deal search.

## Later targeted validation

The subsequent saved-only recheck covered 24 prior searches and 213 slab rows
without provider calls. No explicitly matched saved market had positive net
profit at its saved asking terms. Apparent premium upside in unresolved
printings was retained as research uncertainty, not counted as a Deal.

Two targeted modern Buy It Now searches still found no profitable purchase.
Magikarp exposed a real local-reader gap: the unpaid parser did not recognize
Paldea Evolved, preventing all 24 rows from reaching sold-price research.
Local readers now reuse the cached English set catalog, match the longest set
phrase, and preserve that context when screening listings and sold titles.
This also prevents EX Team Rocket Returns from being read as original Team
Rocket. Explicit Illustration Rare wording, standalone separators and dashed
grader/grade wording no longer obstruct the corresponding literal metadata.
Accepted paid records, model defaults and spending keys remain unchanged.

After repair, Magikarp price screening excluded 14 of 24 candidates before
photos. The original search account was resumed; five label assessments cost
0.8468 cents, and it still produced no Deal. The Mewtwo VSTAR BIN search added
0.29578 cents. These markets' asking prices did not support profitable resale.

A normal HTTP auction search for `Team Rocket holo PSA`, restricted to graded
cards ending within 12 hours, produced one supported `BUY_GRADED` result at the
existing $50 minimum profit and 25% ROI targets. Its photographed First Edition
PSA 8 identity and three matched transactions supported a maximum item bid.
This is a conditional auction opportunity, not a winning bid, realized profit
or evidence that it will close under the limit. No profitable Buy It Now was
established in this follow-up.

The auction account used seven new label assessments for $0.0105118. An isolated
Chrome check repeated the search with the same account, exercised the ordinary
automatic queue and selected Deals: one listing appeared, with all seven readings
reused and no additional generation spending. No result or verdict was injected.
The check exposed and fixed asynchronous dropdown handlers that could restore
the prior format/type before their animated update read the new value.

When Deals is empty, a small local projection now shows up to three useful
alternatives. Positive results below the selected targets and unfinished priced
leads are labeled separately; unverified options show no profit or ROI. Known
losses, mismatches, expired listings, material photo concerns and missing-quote
rows are excluded. Opening their saved details does not start assessment.
Targets and existing Deals qualification remain unchanged.

Final verification: 951 offline tests, both TypeScript checks, production build
and whitespace checks pass. The hard AI ceiling stayed at two cents per search;
the user's conditional ten-cent fallback was not needed. Private reports retain
the original accounts, UI evidence, source observations and quota accounting.

## Catalog resolution before listing assessment

The conversational query “find me a good deal on a holographic dark blastoise
team rocket” now resolves through the English catalog to holo 3/82. Complete
catalog coverage must establish a unique number; incomplete or ambiguous data
preserves the original query. Explicit numbers, edition and holder constraints
remain intact. Derived numbers filter locally, keeping numberless eBay titles
eligible, and query and listing research share the existing source allowance.
Cached model interpretations cannot introduce an untyped collector number.

Live catalog validation used three PKMNPrices requests and four reported
credits, with no AI or Browse calls. Repeating it reused the database without
transport. A normal HTTP search also exposed an overly literal eBay keyword:
“holographic” returned eight results, while the normalized “holo” query returned
762. The first source page retained 196 listings; screening loaded 50 preliminary
matches and excluded two overpriced candidates. Retained explicit numbers were
3/82 or its padded/partial equivalents. This search made zero AI generation
requests; listing photographs still require their own assessment.

Other corrections remove catalog artwork suffix mismatches, contextual GEM MINT
name residue, corroborated date-formatted seller numbers and neutral Unicode
grade descriptions. Saved photo evidence remains reusable. Two previous false
number holds cleared with zero transports; absent exact sales still prevented
invented valuations.

Five fresh graded BIN markets produced no supported profitable purchase in the
tested inventory. One apparent bargain was photographed as a different collector
number and correctly blocked. It was the only new photo assessment, costing
$0.0019812. A provider outage interrupted the first vintage pass; one bounded
retry recovered useful comparisons without photo spending. Missing references
and unexamined inventory prevent a broader claim that those markets lack deals.

Final verification: 965 offline tests, both TypeScript checks, production build
and whitespace checks pass. The two-cent default stayed unchanged; the user's
conditional ten-cent fallback was not used.

## Bounded raw sold-condition acquisition

The raw-pricing gap described above now has a bounded acquisition path. The
evaluator reads accepted historical observations first, then may review one
decision-relevant confirmed sale with up to six original photos and a
1,100-token output limit. It shares the original search allowance and does not
retry, buy a second opinion or walk through further comparisons. One physically
accepted condition match can price a raw route at LOW confidence. Seller labels
remain clues; reference-only TCGplayer quotes cannot establish a Deal.

Cold acquisition now shares the existing sold-title identity checks with
screening. Explicit wrong names, numbers and sets cannot buy detail or photo
work, while previously accepted physical findings retain their precedence over
mistaken seller titles. This consolidates an existing predicate rather than
adding a paid text stage.

Accepted negative readings are saved. Definitive historical 404/410 responses
are briefly cached, whereas temporary errors, cancellation and invalid storage
or accounting do not authorize replacement work. Pricing revision 12 preserves
existing paid live-photo answers and legacy historical readers.

A real $75 Dark Blastoise had clear holo 3/82 photos and an agreeing title, but
seller fields said 20/82 and Regular. Catalog-backed reconciliation now corrects
these fields locally, retaining the original data and observations. Unresolved
printing/holder/authenticity and genuine title/card conflicts still hold. The
same case exposed suspected creasing: that now blocks otherwise actionable
purchase advice through local retargeting, without inventing a Damaged category
or reopening an already priced rejection. It also prevents a new historical
review that cannot resolve uncertainty in the live copy.

Normal HTTP validation on the original account used three live readings and
one historical reading for **$0.0154424 (1.54424 cents)**, four settled
generations and no unknown-charge holds. A $100 live copy was assessed LP. The
selected $162.54 historical copy advertised as LP was assessed MP/MEDIUM, so it
did not become a confirmed LP sale. No profitable BIN was established. Saved
HTTP replay returned the stored evaluation with no new generation or
PKMNPrices request, and unchanged spending. The default two-cent ceiling and
model selection were unchanged.

All 999 offline tests, both TypeScript checks, the production build and
whitespace checks passed. Useful positive BIN validation and verified current
competition remain next; this result does not establish profitable inventory
or broad raw-condition accuracy.

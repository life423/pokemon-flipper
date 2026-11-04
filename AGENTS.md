# Project memory and working agreement

Updated November 4, 2026. These are current requirements. Older dated reports
describe their own checkpoints; consult Git for branch and delivery state.

## Workspace and delivery

- Use /Users/andrewclark/programming/pokemon-flipper on this Mac. The older
  Documents/ChatGPT path is not the checkout.
- Normal app port is 3017; port 3000 belongs to another app. Do not kill other
  instances or overwrite their data. Source changes restart tsx watch and may
  interrupt live searches.
- Commit, merge and push only when requested. Preserve unrelated changes,
  including the existing unstaged .env.example deletion.
- Read ignored LOCAL_PLAN.md and LOCAL_TODO.md before product/strategy work.
  They hold the complete private roadmap. Keep them, credentials, .env, API
  responses, paid evidence and data/ contents out of commits and public reports.

## Product outcome

Success means real, evidence-supported profitable cards reaching Deals.
Loaded rows, completed checks or lower spending alone do not establish success.
Never manufacture Deals or inflate prices to satisfy a count.

Prioritize raw resale, existing slab resale and raw-to-grade equally. Fresh
underpriced Buy It Now listings and supported auction snipe limits are key.
Grading may tie capital up for 90 days or more; preserve useful CGC and PSA plays
and distinguish costs and holding periods. Do not reject unassessed grading
upside solely against an unspecified raw-sale median. Liquidity describes
relevant sales activity, not a guaranteed date this copy will sell.

Keep the interface decision-focused. Avoid decorative "AI" branding; prefer
plain deal, photo-review, pricing and progress labels. Keep provider/cost and
evidence details when they help an informed choice.

## Current flow

Read docs/architecture.md for the source map and reading order.

- Search and Find new listings share one bounded pipeline: one page of up to
  200 eBay summaries, saved/local metadata screening, at most 50 matching rows,
  then shared sold-price research before automatic photo work. Do not revive
  retired broad discovery or a second evaluator through a diagnostic CLI.
  Confident price exclusions free slots for later summaries in that same window;
  refills share one screening session and its allowance. Excluded rows require
  a new search after relaxing targets; local retargeting covers retained rows.
- English-only current scope: exclude known foreign evidence, but unknown
  language is preliminary. Holo, reverse holo and non-holo are distinct.
  Normalize aliases/descriptors without losing printed forms, owners or numbers.
- Honor listing format, raw/graded, prices and grade/finish constraints throughout.
  After assessment, corroborated holder evidence takes precedence over eBay's
  raw/graded category. Keep query and control constraints consistent in results,
  counts and queued work; unknown holders stay unresolved. Direct links remain
  independent of search filters, including queued explicit link work.
  Automatic auctions must end within the search window's next 12 hours.
  Minimum Buy It Now price does not exclude low auction starts. Widening a
  server-side filter requires an explicit rerun, never paid work while typing.
- Sold screening shares catalog/market work across rows: four workers, 64
  uncached PKMNPrices requests including catalog work. Sparse markets may follow
  up to four 20-sale pages, stopping once three eligible matched sales support a
  scope; cached final-valuation pages are reused.
  It makes no AI or eBay-detail requests. Missing/deferred data stays Sorting.
  Three applicable sales authorize automatic photos, retaining the focused
  <=$10 raw First Edition Base Set research exception.
- Exact slab grader/grade/printing/finish scopes stay separate. Only one explicit
  scope with >=3 eligible sales within 90 days can exclude obvious overpricing
  using the upper observed resale value after costs. Raw condition buckets and
  unspecified medians order research; they do not assign this copy a condition,
  create a Deal or exclude unassessed grading/premium-printing upside.
- The browser queues eligible assessments, at most two in flight. Fifty metadata
  rows do not promise fifty paid assessments. Reuse saved evidence first.
- Raw requests combine identity/condition across at most six selected photos.
  Compact slab-label requests use the first two unique photos and null condition.
  Slab model selection has a separate optional override; defaults are unchanged.
  Compatible readers retain older compact models across selection and rollback.
  Actual photographed holder/grader/grade determines resale, not seller category.
  A compact request finding raw does not buy another raw assessment automatically.
  BGS/TAG resale is separate from configured PSA/CGC submission services.
- Direct links require validated eBay IDs and explicit submission, never arbitrary
  submitted URL fetches or silent broad searches. Shortlist saves/notes/load
  require no provider work; targeted refresh never purchases photo analysis.
- Preserve pricing-retry ticket compatibility, explicit deeper photo review,
  cancellation and saved evidence. Current bounded admission does not create new
  retry tickets; reconnecting that feature is pending, not automatic recovery.
  Deeper review is not retired broad-discovery "dig" work.

## Spending, storage and reuse

- Preserve the persistent **$0.02 OpenAI generation cap per search ID**.
  Automatic/explicit follow-ups and nested stages share the ID and guard.
  Exact final-input preflight, maximum input/output reservation and unknown-charge
  holds are required. Invalid state/config fails closed. Cache hits do not reset
  the allowance; brainstorming is not authorization to raise it.
- New searches allow **50 actual eBay Browse requests per search**, separate from daily
  account quota/reserve. Retries, nested calls and restarts retain spent counts.
  Cache hits, OAuth and Analytics are separate. The old expiring development
  ledger is historical, not a daily app limit. Existing 25-request ledgers retain
  their stored limits and counts; opening an old search never resets it.
- The two-cent cap does not cover PKMNPrices credits or eBay quota. Screening
  permits 64 uncached requests; final valuation and retries share one persistent
  **128-request PKMNPrices allowance per new search UUID**. Existing 64-request
  ledgers remain usable with their original limits and counts. Cache hits cost no new
  request; failed/unknown attempts remain counted across restarts/days. Actual
  credits are read from provider headers separately from returned rows and USD.
  The user's subscription supplies 20,000 daily credits. Local request accounting
  is keyed to the configured API key, not an actual provider-account identity;
  rotation/independent replicas require shared authority. Do not reset ledgers.
  Price-only deferral stays Sorting while accepted photos and completed prices
  remain reusable; a supported profitable route can still reach Deals.
  The user authorizes broader PKMNPrices research as needed within reason.
  Treat 64/128 as tunable runaway safeguards, not desired consumption or a reason
  to starve useful comparisons. Raise them when measured useful work is deferred
  and provider capacity supports it; preserve rate limits and shared cache reuse.
- Daily usage warnings appear outside the drawer at <=20% remaining or >=5% of
  an allowance observed consumed within 15 minutes. Account-keyed local samples
  persist across searches/restarts, expire when stale or reset, and do not
  authorize requests. Existing Analytics/Browse observations and completed price
  response headers supply them; warning polling never calls providers. A failed
  telemetry write must not invalidate or repurchase accepted evidence.
- Optimize AI cost per correctly identified deal. Two cents is a ceiling, not
  desired spending. Evaluate cheap first checks and selective stronger reviews
  without automatically running both models or discarding accepted work.
  Reuse source-linked observations and relevant original photos for one specific
  unresolved question; prior model guesses are context, not physical proof.
  Measure accuracy, missed deals, corrections, latency and total cost before a
  production model/prompt change. Preserve existing accepted keys and records.
- Exclude deprecated or retiring models. Bounded requests already use reasoning
  effort none. A separate saved-BIN text-priority diagnostic can test one compact
  GPT-6 Luna request against free ordering under the original search allowance;
  it is not a production paid stage. Flex/Batch need tier-aware spending and
  cancellation support before use, and their latency can miss fresh listings.
- Cancellation prevents subsequent paid dispatch; accepted responses may finish
  saving. No automatic bounded assessment retries/fallback opinions. Never clear
  quota ledgers or paid caches to work around failures.
- Shared SQL Basic response/assessment storage works. Owner valuations, shortlist,
  spending and quota authorities retain local state. Public accounts, shared
  transactional allowances, durable whole-search workers and normalized long-term
  market history remain unfinished. Do not deploy independent replicas with
  independent local allowances.
- Preserve accepted-answer keys, versions, source photo indices and legacy
  paid-record readers. Compatible corrections can supersede older bounded
  answers; stronger full legacy evidence retains priority. Corrupt evidence fails
  closed. Reprice changed terms, but do not retain stale advice for changed photos.
- Useful live diagnostics are authorized within limits. Prefer offline/cache
  checks for mechanical cleanup. Report calls and sample limitations honestly;
  do not spend merely to exhaust an allowance.

## Evidence and financial rules

- Explicit TCGplayer raw quotes and asking-only slab references retain labeled
  scenario math but cannot establish a Deal or a completed rejection. Price-only
  gaps stay Sorting; material photo risks still need attention. A separately
  supported profitable route remains usable. Unknown downside is null, not a
  repeated point estimate. Older absent-basis price records remain readable.
- Recent matched eBay transactions supplied by PKMNPrices are primary truth.
  Reject unconfirmed historical amounts. Distinguish asking references, TCGplayer
  fallback, unspecified raw sales and condition-matched sold prices. Do not merge
  printings, finishes, currencies, grades or raw conditions.
- Corroborated physical identity can correct seller metadata. Readable slab-cert
  typos are informational; actual holder/identity/authenticity conflicts matter.
  Anniversary Pikachu marks, Base Set 2 symbols and copyright clues distinguish
  releases. Premium upgrades require corroboration, not one missing shadow.
  Ordinary complete PSA Base Set labels must not become Shadowless on a guess.
- Seller condition is a clue, not assessed condition. Keep Mint, Near Mint, LP,
  MP, HP and Damaged distinct. Numeric ranges span at most three adjacent grades;
  likely may be unknown. Supported raw condition may have no numeric range.
  Never invent calibrated odds; scenario weights remain assumptions.
  Preserve structured seller conditions when title claims differ. Explicit heavy
  play/damage or conflicting seller claims can reduce unpriced research priority,
  never assign a grade/price or by themselves reject the listing. Holder damage
  and hit-point statistics are not card-condition findings.
- Explain confidence from supplied photos; distinguish damage from obstruction.
  Sampling cannot prove a view is missing from the entire listing. White
  backgrounds may hide wear but do not prove damage or seller deception.
  Generalize user examples into fixes and counterexample regressions, not item-ID
  exceptions or blanket paid reanalysis.
- Keep deterministic money math: Any profit/ROI removes targets, not costs or the
  need for profitable buying. Preserve cents rounding, tax-inclusive fee bases,
  max-scenario grading tiers, minimum modeled net downside and exact slab grades.
- Potential-grade filters use the upper bound, explicitly not a likely/certified
  outcome. Existing slabs use their actual label grade.
- Best Offers are opt-in, conditional and at most **10% below asking**; show the
  amount. Unaccepted offers are not Deals. No automatic buys, bids, offers or
  seller messages are authorized.
- Show price, costs, profit/loss, ROI and safe limit for the same purchase/winning
  price. Avoid mental subtraction or treating graded resale as a raw-auction
  closing forecast. Missing evidence stays unknown, not a fabricated estimate.

## Cleanup and verification

- Trace callers before deleting code. Remove retired writers/orchestration while
  retaining reusable schemas/readers and live manual features. Mechanical cleanup
  preserves prompts, models, hashes, versions and financial assumptions.
  Retire implementation-only tests with their code; move useful behavior
  regressions to the active path.
- App.tsx coordinates network/queue/cancellation. Shared client state belongs in
  client/src/analysis-state.ts; selectors/settings in client/src/search/; detail
  sections under client/src/components/analysis/.
- Run npm test, npm run typecheck, npm run build and git diff --check.
  npm test uses temporary POKEMON_FLIPPER_DATA_DIR/file storage. Direct test
  invocations need equivalent isolation; mocks must never touch real ledgers.
- Keep explicitly deferred early-completion and false front/language reports,
  large UI redesign, model changes and positive-deal validation in the private
  backlog unless newly requested. The roadmap is broader than immediate steps.

## Reference checkpoints

- docs/financial-calculation-audit-2026-11-03.md and its fee-source companion:
  cents-correct math and remaining fee/holding assumptions.
- docs/price-first-screening-2026-11-03.md and
  docs/graded-raw-assessment-paths-2026-11-03.md: sold-first/task split.
- docs/search-cost-benchmark-2026-11-03.md: one search cost 1.40084 cents,
  three new assessments, zero Deals; replay added no provider calls.
- docs/candidate-selection-2026-11-03.md: saved-only 50-row replay recovered
  42 sold contexts versus 35, improving research priority, not verified Deals.
- docs/price-research-accounting-2026-11-03.md: shared 32/64 PKMN request
  safeguards, 830 offline tests, live 65-credit / 0.3991-cent slab sample,
  zero additional provider work on replay; this sample found no Deal.
- docs/selective-model-comparison-2026-11-03.md: five isolated saved-example
  checks cost 0.42322 cents; three cheaper slab checks and two focused stamp
  reviews. Replay made no provider calls; production defaults/answers unchanged.
  Stopping checkpoint: 858 tests pass under default and explicit cheaper slab
  configuration; current CGC search cost 0.44524 cents and found no Deal.
  Broader validation and automatic stronger follow-ups remain unfinished.
- docs/candidate-admission-2026-11-04.md: bounded source-page refill, literal
  publisher/holder name cleanup and source-order ties; six more saved PSA5/CGC9
  checks cost 0.47467 cents, with original evidence preserved and free replay.
  Production model defaults remain unchanged; no current Deal established.
- docs/catalog-and-evidence-validation-2026-11-04.md: catalog/sold-title fixes,
  adaptive sparse sold pages, reference-only price safeguards, nineteen new
  assessments and six cheaper slab comparisons. Saved text ranking of thirty
  candidates cost 0.08581 cents; net savings and positive Deals remain unproven.
- Dated reports retain measured scope. Git records delivery history; private
  notes retain the full strategy and implementation backlog.

# Listing filtering corrections — November 3, 2026

Three focused changes improve which listings survive cheap screening and how
saved photo findings affect the search. They retain the current models, paid
assessment keys, money calculations and provider limits.

## Contextual title exclusions

`server/ebay/filters.ts` remains the shared exclusion predicate for eBay search,
direct links and local title interpretation. Authenticity-assurance wording no
longer implies a mystery purchase. An explicitly accompanying custom case,
holder, sleeve or top loader no longer implies that the card itself is custom.

Only the ambiguous trigger within those phrases is removed before the normal
junk rules run. Genuine proxies, custom cards, mystery/random products, lots,
variation offers, empty cases and merchandise remain excluded even when their
titles also contain an authenticity assurance or accompanying holder. Ambiguous
standalone custom products remain excluded; this is not a general title allowlist
or evidence of authenticity.

## Observed raw versus graded cards

`observedCardKind` in `shared/photo-evidence.ts` reads already-assessed holder
evidence: a single card, a usable non-stock front view and an explicit consistent
holder. A slab remains graded when its numeric grade is unreadable or its
certificate needs attention. None/sleeve/toploader can establish raw; unknown,
other, conflicting, multiple-card and stock-only evidence establish neither.

`matchesListingFilters` keeps the original metadata-only admission behavior.
Downstream callers may pass a saved evaluation to correct the eBay category,
only when listing ID, title and source photos still match. Thumbnail resolutions
and search subsets use the existing photo-equivalence helper. Expired valuation,
different bids or a changed price do not erase unchanged holder evidence.
Changed title/photos or another listing cannot borrow it.

Results, outcome groups, counts and the automatic/pending analysis filters use
this same rule. Raw/graded query words and the explicit control are separate
constraints; neither silently replaces the other. Final search-criteria checks
also enforce the observed kind. Direct-link submissions explicitly retain their
independent scope, even if a previous search has contrary filters or the link
request is queued before React changes pages. Shortlist browsing does not inherit
a keyword search's constraints.

This reuses current paid findings and prevents known mismatches being queued
again. It does not change the initial photo model's accuracy, broaden eBay's
source query, or interrupt a server valuation that first discovers the mismatch.

## Seller condition clues

`sellerConditionClues` in `shared/raw-condition-claim.ts` reads the title, saved
seller condition and card-condition notes. Local metadata screening now uses a
title-derived condition only as a fallback when the structured field is empty;
it no longer replaces a conflicting saved condition with “Mint” from the title.

An agreeing category is still a seller claim. Conflicts remain unknown and
explanatory; explicit heavy play/damage suppresses only the extra unpriced raw
market-context boost. The listing remains inspectable and otherwise eligible.
LP/NM/Mint and unknown-condition prospects retain their research path. Condition
negations, holder-only damage and HP statistics are distinguished from explicit
card-condition claims. Sold-copy classification and final photo-based condition,
grades, prices and purchase advice remain separate.

## Verification and limits

- 787 offline tests pass, including current search/direct-link exclusions,
  holder overrides and counts, unchanged-photo reuse, seller-condition conflict
  retention through the price-first pipeline, and LP-to-cleaner upside.
- Server/shared/scripts and client typechecks, production build and whitespace
  checks pass. Local page returns HTTP 200; Azure SQL reports ready.
- No new eBay, PKMNPrices or OpenAI generation/preflight calls were used for this
  work. SQL readiness was read-only. The 2-cent generation cap, 25 Browse calls
  per search and separate daily quota protection remain unchanged.
- No new profitable listing, improved live-search precision or universal photo
  correctness is claimed from these offline regressions. Unified all-stage
  price-data accounting and useful-deal validation remain later work.

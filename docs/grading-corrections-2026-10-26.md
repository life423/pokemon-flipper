# Grading calculation and CGC label corrections — October 26, 2026

The user authorized fixing the three priority findings from the ten-search
review on `search-workflow-review`, then authorized committing the review and
corrections, merging into `main` and pushing to GitHub after validation. Consult
Git for the delivered revision and remote synchronization status.

## Behavior changed

- Grading service selection now covers the maximum modeled resale value across
  the grade range. A lower numerical grade can have the highest observed price.
  The existing fee amounts and tier-selection rules remain in place.
- Grading downside now uses the minimum modeled net proceeds. It no longer
  assumes the lowest numerical grade is the lowest financial outcome. Ratings
  refer to the lowest modeled resale scenario; the panel labels the figure
  “Modeled downside” rather than implying a guaranteed worst-case loss bound.
- Slab checks and comp filtering share a strict CGC description normalizer.
  Ordinary descriptors are ignored as qualifiers only when they match the
  numeric grade, following the [CGC standard grading scale](https://www.cgccards.uk/card-grading/grading-scale/).
  This includes `NM/MINT+` at 8.5. Real qualifiers, combined designations, unknown
  labels and special tiers still require review or exclusion. Legacy Gem Mint
  9.5 is not silently pooled with current Mint+ 9.5. Photo, grader/grade/cert,
  case-condition and authenticity safeguards are preserved.

Saved AI outputs are interpreted by the updated rules; no model or prompt
version changed and no cache invalidation is necessary. Normal future use may
still need missing verified prices; accepting a label does not fabricate them.
The existing missing-grade price fallback and scenario weights are unchanged
assumptions, not verified sale floors or calibrated grading probabilities.

## Replayed actual samples, without network access

| Sample | Previous result | Corrected result |
| --- | --- | --- |
| $999 damaged Umbreon, PSA grading | +$45.64 profit; +$291.70 downside; BUY_AND_GRADE | −$49.37 profit; −$337.82 modeled downside; PASS |
| $9.99 damaged Raichu, raw resale | +$3.87; BUY_RAW | Unchanged |
| $29.99 Charizard ex, raw resale | +$19.89; BUY_RAW | Unchanged |
| CGC 8.5 Lugia | NEEDS_REVIEW due to ordinary `NM/MINT+` description | Slab check OK; CANT_PRICE because cached verified price evidence is unavailable |

The Umbreon grading fee changes from the configured Regular $79.99 to Express
$175; grading plus shipping is $190. Its Any/Any maximum item price falls to
$953. Fee amounts themselves have not been independently verified by this
change. An acceptable Best Offer remains conditional and separate from Deals.

## Validation

- Regression tests first reproduced the tier, downside and CGC-description
  failures against the old implementation.
- All 259 tests, both TypeScript projects, the production build and diff checks
  pass. The new grading-risk test and typed fixture were also checked directly.
- Coverage includes PSA/CGC price inversions, unsupported service caps,
  percentage-based fees, downside at asking/max bid, target repricing, real vs
  ordinary qualifiers, and preservation of stock/fake/cracked/mismatched slabs.
- Actual recorded results were replayed through the built UI with provider
  access disabled. The Umbreon disappeared from Deals and showed a loss at
  asking. Its analysis showed Express service and −$337.82 modeled downside.
- Phone checks at 375px found no page/panel horizontal overflow or horizontal
  scrolling areas around the changed labels and scenario table.
- Verification used **zero AI, eBay API or price-provider requests**. Cached
  comp/price reads and saved photo assessments were reused. The CGC recheck
  kept missing prices unavailable.

The original [search review](search-review-2026-10-26.md) remains a record of
pre-fix observations. Exact search constraints, confidence/quality presentation
and conservative missing-grade fallback remain separate follow-up work.

# Search and photo workflow follow-up — November 3, 2026

This follows the financial audit on `audit/financial-calculations` and the
user's live testing. It does not replace the financial fee/source report.

## Limits and result admission

- Admit up to 50 matching metadata rows from a single newest 200-row page.
  Known wrong cards, sets, numbers, finishes and other exclusions do not fill
  matching slots. A narrow market may have fewer than 50 suitable rows.
- Keep the 25 actual Browse transport requests per search and provider daily
  quota independent of result count. All paid AI stages share the unchanged
  $0.02 per-search cap. Two automatic assessments may be in flight.
- Metadata loading and its Stop action continue when paid AI is budget-blocked.
  Pending work is labeled awaiting analysis, rather than failed verification.
- Completed priced rejections leave Sorting and Needs attention; All matching
  retains them. Genuine identity/authenticity/label conflicts remain distinct.

## Photo and condition corrections

Raw resale condition is independent of a numeric grading estimate. An explicit
null grade range can retain visible damage or supported raw condition without
inventing PSA/CGC grades. Missing-front, multiple-card, slab and unresolved-card
checks remain in force. Coverage limitations remain visible but do not create
grading holds for a supported as-is raw resale or completed priced rejection.
If neither raw condition nor a numeric range is usable, no price-provider work
starts. A supported grading-only route skips unnecessary raw sold-price work.

A newer validated shared bounded reading supersedes an older private valuation
without purchasing another assessment. The accepted reading is pinned during
that evaluation so a second cache read cannot turn reuse into replacement AI.
Older/equal readings preserve private reuse; stronger legacy full assessments
retain priority. Corrupt or undated shared evidence cannot authorize new work.

Readable physical damage and photographic obstruction are separate concepts.
Reader instructions now distinguish ink/marker, stains and other material
damage from reflections, normal printed artwork, scratches and hidden detail.
These prompt changes apply to new assessments, not magically to saved answers.

For larger galleries, the six-photo sample retains the first two views and
covers the remaining gallery in four equal intervals. This reduces the largest
gap and avoids over-selecting consecutive final close-ups. It is still a sample:
missing/obscured-side messages state reviewed versus unreviewed counts. It
cannot guarantee that an omitted photo contains no relevant evidence.

The edition reader now locates the stamp below the left artwork edge, recognizes
the EDITION/circled-1 form, and distinguishes that mark from the set symbol.
Copyright dates alone do not establish absence; Shadowless conventions must not
be applied indiscriminately to other sets.

The photo gallery shows navigation/thumbnails before the main image, keeps its
original aspect ratio and zoom controls, and gives load/change feedback with a
short opacity transition. Reduced-motion preferences disable that animation.

## Evidence from the reported examples

Saved search history contains `dark blastoise team rocket` without a finish
constraint. Explicit holo-only and collector-number searches have separate
regressions; visible criteria now say Holo only, Reverse holo only, Non-holo only
or Any finish. A request without a finish constraint must not silently acquire
one. Saved catalog data distinguishes holo 03/82 from non-holo 20/82.

For the $900 First Edition Dark Blastoise listing, original photo 1 visibly
contains the stamp and photo 7 shows the whole back. The previous sample
included photo 1 but omitted photo 7; its saved model answer misread the stamp.
The revised sample selects 1, 2, 4, 7, 9 and 11.

One controlled verification used the same GPT-5.6 Luna model, without a Browse
request or new PKMNPrices request. It recognized the stamp and whole back:
15,924 input tokens, 1,070 output tokens, no reported cache charges, $0.0044688
at the verified configured rates (0.44688 cents). The actual accepted response
was retained locally and in the normal shared assessment cache. The original
private snapshot was retained in the ignored audit files, and the original paid
reading remains preserved. A replay with the accepted correction and the saved
catalog updated the current private evaluation to First Edition and back-photo
coverage, with zero further assessment or price-provider requests. Original
listing terms were retained; that replay did not claim a live availability check.

That response still classified raw condition as UNKNOWN. This single case is
not proof of reliable grading/condition quality, a complete useful-search cost
benchmark, or evidence that every saved misreading has been corrected. No model
was changed. No blanket paid-evidence cache revision or deletion was performed.

## Remaining work

- Use shared matched sold evidence for stronger inexpensive admission before
  expensive photo/condition work. Keep graded label work separate from raw
  condition and grading decisions.
- Evaluate wider low-detail photo coverage plus selected high-detail views
  against cost and accuracy; do not add an unbounded second paid stage.
- Measure decision quality and full-search cost on varied saved cases before
  choosing a different model or expanding paid throughput.
- Version or explicitly correct previously misread evidence with provenance;
  prompt edits alone do not update an unchanged cached answer.

## Validation

736 offline tests pass, both TypeScript projects pass, and the production build
and whitespace checks pass. Gallery checks covered 1440/768/375/320px with local
fixtures, no image distortion/panel overflow, load failures, zoom and reduced
motion. Progress checks at 1440/375/320px confirmed awaiting versus failed counts
and budget pauses. No broad live search was run for this validation.

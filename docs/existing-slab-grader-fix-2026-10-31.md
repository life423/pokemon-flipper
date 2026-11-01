# Existing slab graders and Review counts — October 31, 2026

The user's 13 Review cards were 12 BGS and one TAG. Screening applied the raw-card
submission-service list (PSA/CGC) to already-certified slabs, rejecting them before
sold-comp lookup and without an automatic-analysis marker.

## Changed behavior

- Recognized slab graders go to their own exact grader/grade sold lookup. Missing
  sold evidence, including a coverage error, can reach AI label verification and
  the existing photo-checked current-listing fallback. Account/configuration and
  unavailable-photo safeguards remain. Successful preliminary pricing is not a
  final Deal; photographed identity, printing and label checks still run.
- Raw submission services and their fee configuration remain PSA/CGC. BGS/TAG
  resale does not acquire a fictitious raw grading fee or use PSA prices instead.
- Normalize ordinary BGS/TAG descriptions at their corresponding numeric grades.
  Actual mixed qualifiers, Black Label/Pristine and mismatched descriptions are
  still distinct and require review under the existing special-tier policy.
  Sources: [Beckett scale](https://www.beckett.com/grading/scale) (search index and
  its published grading criteria; direct page returned 404 during this check),
  [TAG scale](https://taggrading.com/pages/scale).
- Preserve TAG certificate letters in comparisons and active-reference duplicate
  exclusion. TAG documents its alphanumeric format in its
  [certificate guide](https://taggrading.com/pages/tagd).
- Title reader explicitly includes TAG and distinguishes its numeric grade from
  its separate three-digit score. Title-cache revision 6 refreshes prior readings.
- Pricing revision `ebay-resale-8` refreshes saved monetary results while allowing
  unchanged paid photo assessments to be reused. Active references use cache v5.
- The incomplete-screening message now receives the actual Review group count,
  including completed unpriceable assessments/errors, and uses the same filtered
  inventory for retry eligibility. Pending AI work, expired listings and explicit
  search exclusions no longer become a misleading manual-review count.

## Verification

446 tests pass, including real `evaluateListing` and OpenAI SDK/provider adapters
with deterministic mocked transports. Each of BGS and TAG is screened, queued,
photo-checked, matched to three exact half-grade sold fixtures and underwritten as
an existing slab. Unexpected provider requests fail the test. Test data is isolated
under a system temporary directory; synthetic prices are not market valuations.
Missing sales and provider coverage errors remain eligible for analysis. Raw
submission services, fees, PSA/CGC behavior, printing checks and identity safeguards
retain their regression coverage. Current-comparison tests exercise BGS/TAG exact
grades, wrong graders/grades, full TAG cert letters, self and duplicate exclusion.
Both TypeScript projects, production build and `git diff --check` pass.

An isolated browser fixture on temporary port 3025 served the production client.
It included successful BGS/TAG assessments, one credit-paused AI candidate, one
unresolvable no-photo listing, one expired listing and one wrong-set exclusion.
Visible state: Deals 1, Long shots 1, Waiting 1, Review 1, All 4; message exactly
`1 listing in Review.` Review displayed one card. Auction-only filtering changed
Review to 0 and removed the message. All counts are synthetic UI verification,
not a measured market search. No paid APIs were called for this follow-up.

Rendered counts/overflow checked at 320×740, 390×844, 768×1024 and 1440×1000:
no horizontal overflow. Phone screenshot and desktop count/label screenshot are
under `data/reviews/grader-followup-2026-10-31/`, with fixture inputs, request log,
responsive results and final unit log. The test fixture was stopped afterward.
Two malformed initial fixture responses caused startup errors; correcting the
fixture restored rendering. They were test harness errors, not production fixes.

Internal UI review: usability 9, consistency 9, responsiveness 9, hierarchy 8.5,
accessibility 8.5, feedback 8.5. Next improvements are clearer grouping of long
analysis reports, full keyboard/zoom coverage and distinct live-versus-historical
work progress. These are review heuristics, not measured scores or AA certification.

Normal port 3017 and the user's 3018 preview were restarted with the correction;
3000 remains Ascend Avoid. Refresh the browser and rerun a search to replace old
in-memory screening results. The normal shortlist hash remains
`A10AC88C9F78630EBC7F569F289BB6823ACECC6D8E99F32A758303DF07A734B5`.
No new paid-provider run was attempted after the previously observed OpenAI
credit exhaustion, so funded live completion and a new market Deals count remain
unverified. On November 1 the user authorized committing these fixes with the
throughput follow-up, merging into main and pushing to GitHub; consult Git for
delivery status. Final combined verification again passed all 446 tests, both
typechecks and the production build. The unrelated `.env.example` deletion stays
excluded.

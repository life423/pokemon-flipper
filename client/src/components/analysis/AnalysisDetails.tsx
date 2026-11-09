import type { Evaluation, ListingSummary } from "../../types";
import { name } from "../../format";
import { photoEvidence } from "../../../../shared/photo-evidence.ts";
import { resaleActivity, matchedSoldActivity } from "../../../../shared/liquidity.ts";
import { GradingComparison } from "../GradingComparison";
import { PathCard } from "./FinancialDecision";
import { OfferSection } from "./OfferSection";
import { ListingEvidenceSection, ListingSection, IdentitySection, SlabSection, ConditionSection, PhotosSection } from "./EvidenceSections";
import { PricesSection } from "./PricingSections";
import { Notes, Pairs, Section } from "./primitives";
import styles from "../DetailPanel.module.css";
import { priceEvidenceGap, referencePriceReason } from "../../../../shared/money/price-evidence.ts";

export function AnalysisDetails({
    listing,
    evaluation,
    now,
    onReanalyze,
    minGrade,
    reviewing,
}: {
    listing: ListingSummary;
    evaluation: Evaluation;
    now: number;
    onReanalyze: () => void;
    minGrade: number;
    reviewing: boolean;
}) {
    const tokens = evaluation.usage.reduce(
        (total, step) => total + (step.inputTokens ?? 0) + (step.outputTokens ?? 0),
        0
    );
    const evidence = photoEvidence(evaluation, minGrade);
    const activity = resaleActivity(evaluation, now);
    const matched = matchedSoldActivity(evaluation, now);

    return (
        <>
            {evaluation.condition && <Section title="PSA and CGC comparison"><GradingComparison evaluation={evaluation} expanded /></Section>}
            <Section title="Photo evidence and grading confidence">
                <p>Assessment confidence: {name(evidence.confidence)}. {evidence.coverage}.</p>
                {!evaluation.slab && minGrade > 0 && <p>{evidence.target}</p>}
                <Notes items={evidence.issues} tone="muted" />
            </Section>

            {evaluation.underwriting && evaluation.underwriting.paths.length > 0 && (
                <Section title="Every path">
                    <div className={styles.paths}>
                        {evaluation.underwriting.paths.filter(path => path.path !== "RAW" || path.status !== "PRICED" || !referencePriceReason(evaluation, path)).map((path) => (
                            <PathCard key={path.label} path={path} auction={evaluation.listing.buyingOption === "AUCTION"} referenceReason={path.status === "PRICED" ? referencePriceReason(evaluation, path) : null} />
                        ))}
                    </div>
                </Section>
            )}

            <ListingEvidenceSection listing={listing} evaluation={evaluation} />
            <OfferSection listing={listing} evaluation={evaluation} />
            <Section title="Resale activity">
                <p>{activity.label}</p>
                <p className={styles.small}>{activity.detail}</p>
                {matched && <><h4 className={styles.subTitle}>Matched sold listings · {matched.scope}</h4><Pairs rows={[
                    ["Observed / 7 days", String(matched.last7)], ["Observed / 30 days", String(matched.last30)], ["Observed / 90 days", String(matched.last90)],
                    ["Matching sample", `${matched.returned} sales / ${matched.windowDays}-day lookup`], ["Latest matching sale", matched.newest ?? "None in returned sample"],
                ]} /></>}
                {evaluation.marketActivity?.status === "AVAILABLE" && <h4 className={styles.subTitle}>Broader activity · {evaluation.marketActivity.scope === "RAW" ? "all raw conditions" : "all graders and grades"}</h4>}
                {evaluation.marketActivity?.status === "AVAILABLE" && <Pairs rows={[
                    ["Recorded eBay sales / 30 days", `${evaluation.marketActivity.complete ? "" : "At least "}${evaluation.marketActivity.observedSales}`],
                    ["Average recorded sales / day", evaluation.marketActivity.dailyAverage.toFixed(evaluation.marketActivity.dailyAverage < 1 ? 2 : 1)],
                    ["Days with recorded sales", `${evaluation.marketActivity.activeDays} / 30`],
                    ["Latest recorded sale", evaluation.marketActivity.newestSale ?? "None recorded"],
                ]} />}
                {evaluation.marketActivity?.status === "UNAVAILABLE" && <p className={styles.small}>{evaluation.marketActivity.reason}</p>}
            </Section>
            <ListingSection listing={listing} evaluation={evaluation} />
            {evaluation.identity && <IdentitySection identity={evaluation.identity} isSlab={Boolean(evaluation.slab)} />}
            {evaluation.slab && <SlabSection slab={evaluation.slab} pricing={evaluation.slabPricing} />}
            {evaluation.condition && <ConditionSection evaluation={evaluation} condition={evaluation.condition} />}

            {(evaluation.rawPricing || evaluation.gradedPricing) && (
                <PricesSection raw={evaluation.rawPricing} graded={evaluation.gradedPricing} />
            )}

            {evaluation.photoCheck && <PhotosSection evaluation={evaluation} photoCheck={evaluation.photoCheck} />}

            <footer className={styles.footer}>
                <p className={styles.small}>
                    {evaluation.usage.length > 0
                        ? `The initial analysis used ${tokens.toLocaleString()} tokens.`
                        : "The initial analysis reused saved AI assessments."}
                </p>
                {priceEvidenceGap(evaluation) ? <p className={styles.small}>Price evidence is incomplete. Saved photo findings can be reused when matched sales become available.</p> : <button type="button" className={styles.secondary} onClick={onReanalyze} disabled={reviewing}>
                    {evaluation.researchMode && evaluation.researchMode !== "FULL" ? "Run full research (paid; reuse photos)" : "Reanalyze full listing (paid)"}
                </button>}
            </footer>
        </>
    );
}

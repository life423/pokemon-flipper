import type { Evaluation } from "../types";
import { dollars, name } from "../format";
import { gradingRoutes } from "../../../shared/card-presentation.ts";
import { displayedRawGrade } from "../../../shared/photo-evidence.ts";
import styles from "./DecisionSummary.module.css";
import { priceEvidenceGap } from "../../../shared/money/price-evidence.ts";
import { gradeProbabilities } from "../../../shared/money/underwriting.ts";

export function GradingComparison({ evaluation, expanded = false }: { evaluation: Evaluation; expanded?: boolean }) {
    const routes = gradingRoutes(evaluation);
    if (!routes.length) return null;
    const estimate = displayedRawGrade(evaluation);
    const range = estimate?.range;
    const referenceOnly = estimate && estimate.source !== "PHOTO";
    const weights = estimate?.source === "PHOTO" && range?.likely != null && range.high > range.low
        ? gradeProbabilities(range) : [];
    return <section className={styles.grading} aria-label="PSA and CGC comparison">
        {estimate?.source === "UNRESOLVED" ? <p className={styles.note}>The photos are too limited to narrow the 1–10 grading scale.</p> : estimate && <p className={styles.note}>
            {estimate.source === "PHOTO" ? "Photo grade estimate" : estimate.source === "WEAR" ? "Rough estimate from assessed condition" : "Provisional photo grade"}
            {" · "}<strong className={estimate.confidence === "LOW" ? styles.caution : undefined}>{name(estimate.confidence)} confidence</strong>
            {referenceOnly && " · For reference only"}
        </p>}
        {weights.length > 0 && <p className={styles.note}>
            Grading scenario weights · {weights.map(({ grade, probability }) => `${grade}: ${Math.round(probability * 100)}%`).join(" · ")}
            {" · "}Pricing assumptions
        </p>}
        <div className={styles.gradeRows}>{routes.map(({ grader, priced, reason }) => <div className={styles.gradeRoute} key={grader}>
            <div className={styles.gradeHead}><strong>{grader}{evaluation.underwriting?.best?.grader === grader ? " · selected" : ""}</strong><span>{range ? range.low === range.high ? range.low : `${range.low}–${range.high}` : "Not assessed"}</span></div>
            <p className={styles.note}>{range?.likely != null ? `Estimated grade ${range.likely}` : range ? "Likely grade unknown" : "Awaiting usable photo evidence"}</p>
            <p className={styles.routeValue}>{priced ? `Graded sale estimate ${dollars(priced.expectedSale)}` : "Price unavailable"}</p>
            {priced && <p className={`${styles.note} ${priced.profit < 0 ? styles.loss : styles.gain}`}>{priced.profit < 0 ? "Estimated loss" : "Estimated net profit"} {dollars(Math.abs(priced.profit))} {evaluation.listing.buyingOption === "AUCTION" ? "at current bid" : "at asking price"}</p>}
            {expanded && <><p className={styles.note}>{priced ? `Grading + shipping ${dollars(priced.fixedCosts)} · item limit ${dollars(priced.maxBid)}` : referenceOnly ? "The photos need to support a grade before it can be used for pricing." : reason}</p></>}
        </div>)}</div>
        {evaluation.underwriting?.best?.path === "RAW" && <p className={styles.note}>Separate grading scenarios. {priceEvidenceGap(evaluation) ? "Raw resale reference shown; a purchase strategy is not confirmed." : "Selected strategy: sell raw."}</p>}
    </section>;
}

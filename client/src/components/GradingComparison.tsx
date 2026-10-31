import type { Evaluation } from "../types";
import { dollars } from "../format";
import { gradingRoutes } from "../../../shared/card-presentation.ts";
import styles from "./DecisionSummary.module.css";

export function GradingComparison({ evaluation, expanded = false }: { evaluation: Evaluation; expanded?: boolean }) {
    const routes = gradingRoutes(evaluation);
    if (!routes.length) return null;
    return <section className={styles.grading} aria-label="PSA and CGC comparison">
        <div className={styles.gradeRows}>{routes.map(({ grader, range, priced, reason }) => <div className={styles.gradeRoute} key={grader}>
            <div className={styles.gradeHead}><strong>{grader}{evaluation.underwriting?.best?.grader === grader ? " · selected" : ""}</strong><span>{range ? `${range.low}–${range.high}` : "Not assessed"}</span></div>
            <p className={styles.note}>{range ? range.likely !== null ? `Likely estimate ${range.likely}` : "Likely grade unknown" : "Awaiting photo analysis"}</p>
            <p className={styles.routeValue}>{priced ? `Graded sale estimate ${dollars(priced.expectedSale)}` : "Price unavailable"}</p>
            {priced && <p className={`${styles.note} ${priced.profit < 0 ? styles.loss : styles.gain}`}>{priced.profit < 0 ? "Estimated loss" : "Estimated net profit"} {dollars(Math.abs(priced.profit))} {evaluation.listing.buyingOption === "AUCTION" ? "at current bid" : "at asking price"}</p>}
            {expanded && <><p className={styles.note}>{priced ? `Grading + shipping ${dollars(priced.fixedCosts)} · item limit ${dollars(priced.maxBid)}` : reason}</p></>}
        </div>)}</div>
        {evaluation.underwriting?.best?.path === "RAW" && <p className={styles.note}>Separate grading scenarios. Selected strategy: sell raw.</p>}
    </section>;
}

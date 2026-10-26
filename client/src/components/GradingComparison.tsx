import { MONEY_CONFIG } from "../../../shared/money/config.ts";
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
            <p className={styles.routeValue}>{priced ? `Est. resale ${dollars(priced.expectedSale)}` : "Price unavailable"}</p>
            {expanded && <><p className={styles.note}>{priced ? `Grading + shipping ${dollars(priced.fixedCosts)} · item limit ${dollars(priced.maxBid)}` : reason}</p></>}
        </div>)}</div>
        <p className={styles.note}>Shared photo estimate; each grader uses separate fees and sale evidence.{!MONEY_CONFIG.verified.grading.PSA && " PSA fees are not yet verified against your account."}</p>
    </section>;
}

import { MONEY_CONFIG } from "../../../shared/money/config.ts";
import type { Evaluation, Targets } from "../types";
import { dollars, timeLeft } from "../format";
import { auctionDecision, returnText } from "../../../shared/card-presentation.ts";
import styles from "./DecisionSummary.module.css";

export function AuctionSummary({ evaluation, targets, now }: { evaluation: Evaluation; targets: Targets; now: number }) {
    const decision = auctionDecision(evaluation, targets, now);
    const result = decision.overLimit ? decision.atCurrent : decision.atCeiling;
    const cautious = decision.provisional || decision.breakEven || decision.ended || decision.overLimit;
    return <div className={styles.auction}>
        <div className={styles.amounts}>
            <div><span className={styles.label}>Current bid</span><strong>{dollars(evaluation.listing.price)}</strong></div>
            <div><span className={styles.label}>{decision.label}</span><strong className={styles.limit}>{dollars(decision.ceiling)}</strong></div>
        </div>
        <p className={styles.status}>
            {decision.status === "ENDED" ? "Auction ended" : decision.status === "OVER_LIMIT" ? "Already above your limit — pass at this price." : decision.status === "UNPRICED" ? "No reliable bid limit yet. Finish the photo and pricing checks." : decision.provisional ? "Provisional limit — your review is needed because photo or grading uncertainty remains." : decision.breakEven ? "Set a profit or ROI target to leave a margin." : "Use the bid limit as your maximum snipe for the selected resale route."}
        </p>
        {result && <div className={styles.scenario}>
            <p className={styles.label}>{decision.overLimit ? "At current bid" : "If won for"} {dollars(result.price)} · {evaluation.underwriting?.best?.label}</p>
            <dl className={styles.facts}>
                <div><dt>Est. net {result.profit < 0 ? "loss" : "profit"}</dt><dd className={result.profit < 0 ? styles.loss : cautious ? styles.caution : styles.gain}>{dollars(Math.abs(result.profit))}</dd></div>
                <div><dt>Total invested</dt><dd>{dollars(result.cost)}</dd></div>
                <div><dt>Return on total cost</dt><dd>{returnText(result.roi)}</dd></div>
            </dl>
        </div>}
        <div className={styles.market}>
            <span className={styles.label}>Closing price guide</span>
            <strong>{decision.benchmark ? dollars(decision.benchmark.price) : "Unavailable"}</strong>
            <p>{decision.benchmark ? `${decision.benchmark.source}${decision.benchmark.count !== null ? ` · ${decision.benchmark.count} sales` : ""}. Actual bidding may finish above or below this reference.` : "No reliable condition-matched reference. A graded resale value is not the raw auction price."}</p>
            {decision.benchmark?.low !== null && decision.benchmark?.low !== undefined && <p>Observed sales: {dollars(decision.benchmark.low)}–{dollars(decision.benchmark.high)}</p>}
        </div>
        <p className={styles.terms}>{timeLeft(evaluation.listing.endTime, now) ?? "End time not available"} · {evaluation.listing.bids} {evaluation.listing.bids === 1 ? "bid" : "bids"} · {evaluation.listing.shipping === null ? `${dollars(evaluation.underwriting?.best?.shipping ?? MONEY_CONFIG.buying.assumedShippingWhenUnknown)} shipping assumed` : `${dollars(evaluation.listing.shipping)} shipping`}</p>
        <p className={styles.note}>The limit is the item bid. Total invested includes tax, shipping and any grading costs. No bid is submitted by this app.</p>
    </div>;
}

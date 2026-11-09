import type { CompSummary, GradedPricing, RawPricing } from "../../types";
import { dollars, name } from "../../format";
import { RAW_CONDITIONS, CONDITION_NAMES } from "../../../../shared/conditions.ts";
import { isRawSoldPrice } from "../../../../shared/money/price-evidence.ts";
import { Pairs, Section } from "./primitives";
import styles from "../DetailPanel.module.css";

export function soldEstimateBasis(summary?: CompSummary): string {
    switch (summary?.marketEstimate?.method) {
        case "RECENT_FOUR": return "average of the four latest matched eBay sales within 48 hours";
        case "RECENCY_WEIGHTED_MEDIAN": return "eBay sold median weighted toward newer sales";
        default: return "eBay sold median";
    }
}

export function CompsRow({ summary, sampleLimit = 40, screening = false }: { summary: CompSummary; sampleLimit?: number; screening?: boolean }) {
    const dropped = Object.entries(summary.dropped);
    const estimate = summary.marketEstimate;
    const priceLabel = estimate ? `estimate ${dollars(estimate.price)}` : `median ${dollars(summary.median)}`;
    const change = estimate?.recentTrendPercent;
    const trend = change == null ? null : change === 0
        ? "The two pairs of sales averaged about the same price."
        : `The newest two sales averaged ${Math.abs(change)}% ${change > 0 ? "above" : "below"} the prior two.`;

    return (
        <details className={styles.details}>
            <summary>
                <span>
                    {summary.grader === "RAW" ? `Raw · ${name(String(summary.grade))}` : `${summary.grader} ${summary.grade}`}
                </span>
                <span className={styles.compStats}>
                    {summary.count > 0
                        ? `${summary.count} ${summary.count === 1 ? "sale" : "sales"}, ${priceLabel}, ${name(summary.confidence)}${summary.checkedByAI ? ", checked by AI" : ""}`
                        : "No verified sales"}
                </span>
            </summary>

            {summary.count > 0 && (
                <>
                    <p className={styles.small}>
                        Based on the {soldEstimateBasis(summary)}. Observed sale range {dollars(summary.low)} to {dollars(summary.high)}.
                        {summary.mean != null && ` Full-sample average ${dollars(summary.mean)}.`}
                        {summary.newestSale && ` Latest sale ${summary.newestSale}.`}
                        {summary.windowDays ? ` Up to ${summary.windowDays} days of sales, with at most ${sampleLimit} results sampled per lookup.` : ""}
                        {screening && " This evidence is used for preliminary screening."}
                    </p>
                    {trend && <p className={styles.small}>{trend}</p>}
                </>
            )}

            {dropped.length > 0 && (
                <p className={styles.small}>
                    Dropped: {dropped.map(([reason, count]) => `${count} ${reason}`).join(", ")}.
                </p>
            )}

            <ul className={styles.sales}>
                {summary.sales.map((sale, index) => (
                    <li key={`${sale.soldAt}-${index}`}>
                        <span className={styles.salePrice}>{dollars(sale.price)}</span>
                        <span className={styles.muted}>{sale.soldAt}</span>
                        {sale.photoCondition && <span className={styles.muted}>Seller says: {sale.sellerCondition ? CONDITION_NAMES[sale.sellerCondition] : "Not stated"} · AI assesses: {CONDITION_NAMES[sale.photoCondition]}</span>}
                        {sale.url ? (
                            <a href={sale.url} target="_blank" rel="noopener noreferrer">
                                {sale.title}
                            </a>
                        ) : (
                            <span>{sale.title}</span>
                        )}
                    </li>
                ))}
            </ul>
        </details>
    );
}

export function PricesSection({
    raw,
    graded,
}: {
    raw: RawPricing | null;
    graded: Record<string, GradedPricing> | null;
}) {
    return (
        <Section title="Prices">
            {raw && (
                <>
                    <h4 className={styles.subTitle}>Raw{raw.printingLabel ? `, ${raw.printingLabel}` : ""}</h4>
                    {raw.status === "PRICED" ? (
                        <Pairs rows={RAW_CONDITIONS.map(condition => {
                            const price = raw.prices?.find(entry => entry.condition === condition && isRawSoldPrice(entry));
                            return [CONDITION_NAMES[condition], !price ? "No supported price"
                                : `${dollars(price.price)} · ${soldEstimateBasis(price.comps)}${price.comps ? ` (${price.comps.count} ${raw.conditionEvidence === "AI_PHOTOS" ? "photo-assessed " : ""}${price.comps.count === 1 ? "sale" : "sales"} in sample)` : ""}`];
                        })} />
                    ) : (
                        <p className={styles.muted}>{raw.reason}</p>
                    )}
                    {raw.evidenceNote && <p className={styles.small}>{raw.evidenceNote}</p>}
                    {raw.ebayComps?.filter(summary => summary.count > 0).map(summary => <CompsRow key={String(summary.grade)} summary={summary} />)}
                </>
            )}

            {Object.entries(graded ?? {}).map(([grader, pricing]) => (
                <div key={grader}>
                    <h4 className={styles.subTitle}>
                        {grader} sold comps{pricing.printingLabel ? `, ${pricing.printingLabel}` : ""}
                    </h4>
                    {pricing.byGrade?.map((summary) => (
                        <CompsRow key={String(summary.grade)} summary={summary} />
                    ))}
                    {pricing.status !== "PRICED" && <p className={styles.muted}>{pricing.reason}</p>}
                </div>
            ))}
        </Section>
    );
}

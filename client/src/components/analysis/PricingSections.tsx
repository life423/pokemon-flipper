import type { CompSale, CompSummary, GradedPricing, RawPricing } from "../../types";
import { dollars, name } from "../../format";
import { RAW_CONDITIONS, CONDITION_NAMES } from "../../../../shared/conditions.ts";
import { isRawSoldPrice } from "../../../../shared/money/price-evidence.ts";
import { Pairs, Section } from "./primitives";
import styles from "../DetailPanel.module.css";

export function soldEstimateBasis(summary?: CompSummary): string {
    const estimate = summary?.marketEstimate;
    switch (estimate?.method) {
        case "RECENT_FIXED_PRICE_MEDIAN": return `median of the ${estimate.sampleSize ?? 5} latest matched Buy It Now sales within 30 days`;
        case "RECENT_FOUR": return "average of the four latest matched eBay sales across available formats within 48 hours";
        case "RECENCY_WEIGHTED_MEDIAN": return "eBay sold median across available formats, weighted toward newer sales";
        default: return "eBay sold median";
    }
}

const SALE_TYPES: Record<NonNullable<CompSale["saleType"]>, string> = {
    auction: "Auction",
    fixed_price: "Buy It Now",
    best_offer_accepted: "Best Offer accepted",
};

export function saleFormatBreakdown(summary: CompSummary): string | null {
    if (!summary.count || summary.sales.length !== summary.count || summary.sales.some(sale => !sale.saleType)) return null;
    return Object.entries(SALE_TYPES).flatMap(([type, label]) => {
        const count = summary.sales.filter(sale => sale.saleType === type).length;
        if (!count) return [];
        const format = type === "auction" ? (count === 1 ? "auction" : "auctions")
            : type === "best_offer_accepted" ? (count === 1 ? "accepted offer" : "accepted offers") : label;
        return [`${count} ${format}`];
    }).join(" · ");
}

export function CompsRow({ summary, screening = false, expanded = false }: { summary: CompSummary; screening?: boolean; expanded?: boolean }) {
    const dropped = Object.entries(summary.dropped);
    const estimate = summary.marketEstimate;
    const priceLabel = estimate ? `estimate ${dollars(estimate.price)}` : `median ${dollars(summary.median)}`;
    const change = estimate?.recentTrendPercent;
    const trend = change == null ? null : change === 0
        ? "The two pairs of sales averaged about the same price."
        : `The newest two sales averaged ${Math.abs(change)}% ${change > 0 ? "above" : "below"} the prior two.`;

    return (
        <details className={styles.details} open={expanded || undefined}>
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
                        {summary.windowDays ? ` Sampled sales from up to the last ${summary.windowDays} days.` : ""}
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
                        <span className={styles.muted}>{sale.soldAt}{sale.saleType && ` · ${SALE_TYPES[sale.saleType]}`}</span>
                        {sale.photoCondition && <span className={styles.muted}>Seller says: {sale.sellerCondition ? CONDITION_NAMES[sale.sellerCondition] : "Not stated"} · AI assesses: {CONDITION_NAMES[sale.photoCondition]}</span>}
                        {sale.photoCondition && sale.conditionEvidence?.map((note, i) => <span key={i} className={styles.muted}>{note}</span>)}
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
                    {raw.sellerConditionComps && <>
                        <h4 className={styles.subTitle}>Raw collector comparison</h4>
                        <p className={styles.small}>These sellers described the sold copies in the same condition the photos suggest for this card.</p>
                        <CompsRow summary={raw.sellerConditionComps} />
                    </>}
                    {raw.evidenceNote && <p className={styles.small}>{raw.evidenceNote}</p>}
                    {raw.ebayComps?.filter(summary => summary.count > 0).map(summary => <CompsRow key={String(summary.grade)} summary={summary} />)}
                </>
            )}

            {Object.entries(graded ?? {}).map(([grader, pricing]) => (
                <div key={grader}>
                    <h4 className={styles.subTitle}>
                        {grader} sold comps{pricing.printingLabel ? `, ${pricing.printingLabel}` : ""}
                    </h4>
                    {pricing.referenceGradeComps && <>
                        <p className={styles.small}>Certified sales at the raw card’s estimated grade. Its grade and grading proceeds are uncertain.</p>
                        <CompsRow summary={pricing.referenceGradeComps} />
                    </>}
                    {pricing.byGrade?.map((summary) => (
                        <CompsRow key={String(summary.grade)} summary={summary} />
                    ))}
                    {pricing.status !== "PRICED" && <p className={styles.muted}>{pricing.reason}</p>}
                </div>
            ))}
        </Section>
    );
}

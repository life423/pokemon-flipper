import type { CompSummary, GradedPricing, RawPricing } from "../../types";
import { dollars, name } from "../../format";
import { RAW_CONDITIONS, CONDITION_NAMES } from "../../../../shared/conditions.ts";
import { Pairs, Section } from "./primitives";
import styles from "../DetailPanel.module.css";

export function CompsRow({ summary, sampleLimit = 40, screening = false }: { summary: CompSummary; sampleLimit?: number; screening?: boolean }) {
    const dropped = Object.entries(summary.dropped);

    return (
        <details className={styles.details}>
            <summary>
                <span>
                    {summary.grader === "RAW" ? `Raw · ${name(String(summary.grade))}` : `${summary.grader} ${summary.grade}`}
                </span>
                <span className={styles.compStats}>
                    {summary.count > 0
                        ? `${summary.count} sales, median ${dollars(summary.median)}, ${name(summary.confidence)}${summary.checkedByAI ? ", checked by AI" : ""}`
                        : "No verified sales"}
                </span>
            </summary>

            {summary.count > 0 && (
                <p className={styles.small}>
                    {summary.mean != null ? `Average ${dollars(summary.mean)}. ` : ""}Range {dollars(summary.low)} to {dollars(summary.high)}. Newest sale {summary.newestSale}.{summary.windowDays ? ` Up to ${summary.windowDays} days of recent sales; at most ${sampleLimit} returned rows per lookup are sampled. ${screening ? "This is preliminary market evidence, not a verified valuation." : "The median drives the estimate."}` : ""}
                </p>
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
                            const price = raw.prices?.find(entry => entry.condition === condition);
                            return [CONDITION_NAMES[condition], !price ? "No supported price" : `${dollars(price.price)} · ${price.basis === "EBAY_SOLD" ? `eBay sold median (${price.comps?.count} ${raw.conditionEvidence === "AI_PHOTOS" ? "photo-assessed " : ""}sales)` : price.basis === "TCGPLAYER" || raw.source === "pkmnprices" ? "TCGplayer market fallback" : "Market feed"}`];
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

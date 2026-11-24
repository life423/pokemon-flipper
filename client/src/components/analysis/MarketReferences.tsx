import type { Evaluation } from "../../types";
import { CONDITION_NAMES } from "../../../../shared/conditions.ts";
import { dollars } from "../../format";
import { Section } from "./primitives";
import styles from "../DetailPanel.module.css";

export function MarketReferences({ evaluation }: { evaluation: Evaluation }) {
    const tracker = evaluation.trackerPriceReference, web = evaluation.webPriceResearch;
    const raw = evaluation.trackerRawReference;
    if (!tracker && !raw && !web && !evaluation.supplementalPriceNote) return null;
    const grade = tracker?.gradedMarket;
    return <Section title="Additional price evidence">
        {raw && <div>
            <h4 className={styles.subTitle}>Pokémon Price Tracker · TCGplayer market</h4>
            <p>{CONDITION_NAMES[raw.condition]} · {dollars(raw.priceUsd)} · updated {raw.updatedAt.slice(0, 10)}.</p>
        </div>}
        {grade && <div>
            <h4 className={styles.subTitle}>Pokémon Price Tracker · {grade.grader} {grade.grade}</h4>
            <p>{dollars(grade.priceUsd)} {grade.statistic === "7_DAY_MEDIAN" ? "7-day median" : "historical median"}.
                {" "}Tracker reports {grade.reportedSales} total sales for {tracker.printingLabel ? `${tracker.printingLabel} in this grade` : "this product and grade"}. Latest sale {grade.lastSaleAt.slice(0, 10)}.</p>
            {grade.filteredEstimate && <p>{grade.filteredEstimate.days}-day provider estimate {dollars(grade.filteredEstimate.priceUsd)} · {grade.filteredEstimate.confidence.toLowerCase()} confidence.</p>}
            {grade.marketplaces.length > 0 && <p className={styles.small}>Marketplaces · {grade.marketplaces.join(", ")}</p>}
            <p className={styles.small}>{tracker.caveat}</p>
        </div>}
        {web && <div>
            <h4 className={styles.subTitle}>Web price check · {web.checkedAt.slice(0, 10)}</h4>
            {web.observations.length ? <>
                <ul>{web.observations.map(row => <li key={row.url}>
                    {row.kind === "SOLD" ? "Reported sale" : "Asking price"} · {dollars(row.priceUsd)}
                    {row.date && ` · ${row.date}`}. <a href={row.url} target="_blank" rel="noopener noreferrer">{row.title}</a>
                </li>)}</ul>
                <p className={styles.small}>These public sources give buying context. The resale calculation uses matched transactions from the pricing analysis.</p>
            </> : <p>The search found no citable price for this exact copy type.</p>}
        </div>}
        {evaluation.supplementalPriceNote && <p>{evaluation.supplementalPriceNote}</p>}
    </Section>;
}

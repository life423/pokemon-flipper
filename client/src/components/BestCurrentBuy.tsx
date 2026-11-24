import type { Evaluation } from "../types.ts";
import type { BestCurrentBuy as BuyingComparison, RawBuyingComparison } from "../search/results.ts";
import { parseListingLink } from "../../../shared/listing-link.ts";
import { CONDITION_NAMES } from "../../../shared/conditions.ts";
import { dollars, percent } from "../format";
import { displayedRawGrade } from "../../../shared/photo-evidence.ts";
import { soldMarketPrice } from "../../../shared/sold-evidence.ts";
import { saleFormatBreakdown } from "./analysis/PricingSections";
import { RawCardGrade } from "./RawCardGrade";
import styles from "./BestCurrentBuy.module.css";

export function BestCurrentBuy({ reference, evaluation, onOpen }: {
    reference: BuyingComparison;
    evaluation?: Evaluation | null;
    onOpen?: () => void;
}) {
    const link = parseListingLink(reference.url);
    if (!link) return null;
    const { price, shipping, pricing, seller, coverage, basis } = reference;
    const loss = pricing.profit < 0;
    const outcome = loss ? "loss" : pricing.profit > 0 ? "profit" : "even";
    const sellerRisk = seller && (seller.feedbackScore !== null && seller.feedbackScore < 10 ||
        seller.feedbackPercentage !== null && seller.feedbackPercentage < 98);
    const fairCollectorBuy = loss && reference.identity !== "LISTING" && !sellerRisk && !reference.concerns?.length;

    return <section className={styles.card} aria-label="Buying comparison"
        data-outcome={fairCollectorBuy ? "collector" : outcome}>
        <div className={styles.heading}>
            <h2>{fairCollectorBuy ? "Fair buy for a collector" : (coverage?.checked ?? 1) === 1 ? "Below recent sales" : "Best value among checked listings"}</h2>
            <span className={styles.badge}>{dollars(pricing.resale - pricing.totalCost)} below sold estimate</span>
        </div>
        <div className={styles.body}>
            {reference.image && <img className={styles.image} src={reference.image} alt="" loading="lazy" />}
            <div className={styles.details}>
                <div className={styles.identity}>
                    <h3>{reference.title}</h3>
                    {evaluation && <RawCardGrade evaluation={evaluation} />}
                    <p className={styles.basis}>{basis}</p>
                    <p className={reference.identity === "LISTING" ? styles.caution : styles.source}>{reference.identity === "LABEL"
                        ? "Matched the card and PSA label in the seller’s photo"
                        : reference.identity === "PHOTO" ? "Photo-confirmed identity" : "Identity matched from eBay details · photos not checked"}</p>
                </div>
                <div className={styles.numbers}>
                    <div><span>Estimated total to buy</span><strong>{dollars(pricing.totalCost)}</strong>
                        <small>{dollars(price)} + {shipping === 0 ? "free shipping" : dollars(shipping) + " shipping"} + {dollars(pricing.totalCost - price - shipping)} estimated tax</small></div>
                    <div><span>Recent sold estimate</span><strong>{dollars(pricing.resale)}</strong><small>{pricing.sales} matched {pricing.sales === 1 ? "sale" : "sales"}</small></div>
                    <div data-outcome={outcome}>
                        <span>{loss ? "Projected resale loss" : pricing.profit > 0 ? "Projected resale profit" : "Projected break-even"}</span>
                        <strong>{dollars(Math.abs(pricing.profit))}</strong><small>{percent(pricing.roi)} return after configured costs and fees</small>
                    </div>
                </div>
                {loss && <p>Outside Deals because a resale at {dollars(pricing.resale)} would return {dollars(pricing.totalCost + pricing.profit)} after selling costs, less than the {dollars(pricing.totalCost)} purchase total.</p>}
                <p className={styles.source}>Item-price limit for your profit targets: {dollars(reference.ceiling)} with this shipping quote.</p>
                {seller && <p className={sellerRisk ? styles.caution : styles.source}>
                    Seller{seller.username ? ` ${seller.username}` : ""}: {seller.feedbackPercentage === null ? "feedback percentage unavailable" : `${seller.feedbackPercentage}% positive`} · {seller.feedbackScore === null ? "rating count unavailable" : `${seller.feedbackScore.toLocaleString()} ratings`}{sellerRisk ? " · limited or weak seller feedback" : ""}
                </p>}
                {reference.concerns?.length ? <ul className={styles.caution}>{reference.concerns.map(note => <li key={note}>{note}</li>)}</ul> : null}
            </div>
        </div>
        <div className={styles.footer}>
            <p>{coverage ? `${coverage.checked} ${coverage.checked === 1 ? "listing" : "listings"} checked from ${coverage.found} fetched. ` : ""}Compared by percentage below each copy’s matched sold estimate. Availability can change.</p>
            <div className={styles.actions}>
                {onOpen && <button type="button" onClick={onOpen}>View analysis</button>}
                <a href={link.url} target="_blank" rel="noopener noreferrer">View on eBay ↗</a>
            </div>
        </div>
    </section>;
}

export function RawCopyComparison({ comparison, evaluation, onOpen }: {
    comparison: RawBuyingComparison;
    evaluation: Evaluation;
    onOpen: (id: string) => void;
}) {
    const { listing, totalCost, nextTotal, copies, sales, sellerReported, betterConditionCopy } = comparison;
    const condition = CONDITION_NAMES[comparison.condition];
    const link = parseListingLink(listing.url);
    const estimate = soldMarketPrice(sales);
    if (!link || estimate === null) return null;
    const delta = Math.round((totalCost - estimate) * 100) / 100;
    const formats = saleFormatBreakdown(sales);
    const grade = displayedRawGrade(evaluation)?.range.likely;
    const psa = evaluation.gradedPricing?.PSA;
    const gradedSales = [...(psa?.byGrade ?? []), psa?.referenceGradeComps].find(row =>
        row?.grader === "PSA" && grade != null && Number(row.grade) === grade && row.count > 0 && soldMarketPrice(row) !== null);

    return <section className={styles.card} aria-label="Raw copy comparison">
        <div className={styles.heading}>
            <h2>Lowest checked {condition.toLowerCase()} copy</h2>
            <span className={styles.badge}>{copies} comparable copies</span>
        </div>
        <div className={styles.body}>
            {listing.images[0] && <img className={styles.image} src={listing.images[0]} alt="" loading="lazy" />}
            <div className={styles.details}>
                <div className={styles.identity}><h3>{listing.title}</h3><RawCardGrade evaluation={evaluation} /></div>
                <div className={styles.numbers}>
                    <div><span>Estimated total to buy</span><strong>{dollars(totalCost)}</strong>
                        <small>{dollars(listing.currentPrice)} + {dollars(listing.shipping)} shipping, plus estimated tax</small></div>
                    <div><span>Next lowest checked total</span><strong>{dollars(nextTotal)}</strong>
                        <small>{comparison.highestTotal > nextTotal ? `Other checked totals reach ${dollars(comparison.highestTotal)}` : "Same printing and assessed condition"}</small></div>
                    <div><span>Raw sold estimate</span><strong>{dollars(estimate)}</strong>
                        <small>{sales.count} {sales.count === 1 ? "sale" : "sales"} · {sellerReported ? "seller-described" : "photo-assessed"} {condition}</small>
                        {formats && <small>{formats}</small>}</div>
                </div>
                <p className={styles.basis}>{delta === 0 ? "The purchase total matches the raw sold estimate." :
                    `The purchase total is ${dollars(Math.abs(delta))} ${delta > 0 ? "above" : "below"} the raw sold estimate.`}</p>
                {betterConditionCopy && <div className={styles.upgrade}>
                    <span><strong>{CONDITION_NAMES[betterConditionCopy.condition]}</strong> {betterConditionCopy.difference === 0
                        ? "at the same price" : `for ${dollars(Math.abs(betterConditionCopy.difference))} ${betterConditionCopy.difference < 0 ? "less" : "more"}`} · {dollars(betterConditionCopy.totalCost)} total</span>
                    <button type="button" onClick={() => onOpen(betterConditionCopy.listing.id)}>View listing</button>
                </div>}
                {gradedSales && <p className={styles.source}>Certified PSA {gradedSales.grade} copies sold around {dollars(soldMarketPrice(gradedSales))} across {gradedSales.count} matched {gradedSales.count === 1 ? "sale" : "sales"}. This copy is ungraded.</p>}
            </div>
        </div>
        <div className={styles.footer}>
            <p>Compared Buy It Now listings with checked fronts, backs and shipping quotes.</p>
            <div className={styles.actions}>
                <button type="button" onClick={() => onOpen(listing.id)}>View analysis</button>
                <a href={link.url} target="_blank" rel="noopener noreferrer">View on eBay ↗</a>
            </div>
        </div>
    </section>;
}

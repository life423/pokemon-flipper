import type { ReactNode } from "react";
import type { Evaluation, MoneyPath, Targets, Underwriting } from "../../types";
import { dollars, name, percent, timeLeft } from "../../format";
import { MONEY_CONFIG } from "../../../../shared/money/config.ts";
import { returnText } from "../../../../shared/card-presentation.ts";
import { AuctionSummary } from "../AuctionSummary";
import { RatingBadge, VerdictBadge } from "../VerdictBadge";
import { Tween } from "../Tween";
import { Notes, Pairs, Section } from "./primitives";
import { isResearchDeferred } from "../../../../shared/photo-review.ts";
import styles from "../DetailPanel.module.css";
import { isRawSoldPrice, priceEvidenceGap } from "../../../../shared/money/price-evidence.ts";

export function FinancialDecision({ evaluation, targets, now }: { evaluation: Evaluation; targets: Targets; now: number }) {
    const priceGap = priceEvidenceGap(evaluation);
    if (priceGap) return <Section title="Resale price unconfirmed">
        <p>{priceGap}</p>
        <Pairs rows={[
            [evaluation.listing.buyingOption === "AUCTION" ? "Current bid" : "Asking price", dollars(evaluation.listing.price)],
            ["Shipping", evaluation.listing.shipping === null ? "Not quoted" : dollars(evaluation.listing.shipping)],
            ...(evaluation.underwriting?.best && evaluation.underwriting.best.path !== "RAW" ? [["Reference resale estimate before costs", dollars(evaluation.underwriting.best.salePrice)]] as [string, ReactNode][] : []),
        ]} />
        <p className={styles.small}>Saved photo findings remain available. A purchase or bid limit needs matched resale evidence.</p>
    </Section>;
    if (isResearchDeferred(evaluation)) return <Section title="Automatic research deferred">
        <p>{evaluation.rawPricing?.evidenceNote}</p>
        <p className={styles.small}>This is not a completed purchase recommendation. Run full research below to assess the resale routes; saved photo assessments will be reused.</p>
    </Section>;
    if (!evaluation.underwriting) return null;
    return evaluation.listing.buyingOption === "AUCTION" ? <Section title="Auction decision">
        <AuctionSummary evaluation={evaluation} targets={targets} now={now} />
        <Notes items={evaluation.underwriting.reasons} />
        <Notes items={evaluation.underwriting.assumptions} tone="muted" />
        <Notes items={evaluation.rating?.concerns ?? []} tone="bad" />
    </Section> : <VerdictSection underwriting={evaluation.underwriting} evaluation={evaluation} now={now} />;
}

function VerdictSection({
    underwriting,
    evaluation,
    now,
}: {
    underwriting: Underwriting;
    evaluation: Evaluation;
    now: number;
}) {
    const { listing } = evaluation;
    const best = underwriting.best;
    const shippingPending = underwriting.shippingUnconfirmed;
    const left = timeLeft(listing.endTime, now);
    const room = best?.maxBid !== undefined && listing.price !== null ? best.maxBid - listing.price : null;

    const rows: [string, ReactNode][] = [
        ["Buy It Now", dollars(listing.price)],
        ["Shipping", listing.shipping === null ? `Not quoted · ${dollars(MONEY_CONFIG.buying.assumedShippingWhenUnknown)} assumed` : dollars(listing.shipping)],
    ];
    if (best?.path === "RAW") {
        const quote = evaluation.rawPricing?.prices?.find(price => price.condition === best.priceCondition && isRawSoldPrice(price));
        rows.push(["Raw sale estimate before fees", dollars(best.salePrice)]);
        rows.push(["Resale evidence", `${quote?.comps?.count ?? "Matched"} eBay sold comps`]);
        rows.push(["Net sale proceeds after fees and shipping", dollars(best.expectedNet)]);
    }

    if (room !== null && !shippingPending) {
        rows.push([
            room >= 0 ? "Below your price limit" : "Above your price limit",
            <span className={room >= 0 ? styles.good : styles.bad}>{dollars(Math.abs(room))}</span>,
        ]);
    }
    if (best) {
        const { profit, cost } = best;
        rows.push([
            `${shippingPending ? "Modeled" : "Est."} net ${profit < 0 ? "loss" : "profit"} at asking`,
            <span className={shippingPending ? undefined : profit >= 0 ? styles.good : styles.bad}>
                {dollars(Math.abs(profit))} ({returnText(cost ? profit / cost : null)} return on total cost)
            </span>,
        ]);
        rows.push(["Est. total invested", dollars(cost)]);
    }
    if (left) {
        rows.push(["Ends in", left]);
    }

    return (
        <section className={styles.verdict}>
            <div className={styles.badges}>
                {evaluation.rating && <RatingBadge level={evaluation.rating.level} large />}
                <VerdictBadge verdict={underwriting.verdict} large />
            </div>

            {shippingPending && <Notes items={underwriting.reasons} />}
            {best?.maxBid !== undefined && (
                <div className={styles.hero}>
                    <span className={styles.heroLabel}>{shippingPending ? "Provisional max price" : "Max price"} · {best.label}</span>
                    <span
                        className={`${styles.heroValue} ${
                            underwriting.verdict === "BUY_AND_GRADE"
                                ? styles.gradeText
                                : underwriting.verdict.startsWith("BUY")
                                  ? styles.good
                                  : ""
                        }`}
                    >
                        <Tween value={best.maxBid} format={dollars} />
                    </span>
                </div>
            )}

            <Pairs rows={rows} />
            <Notes items={best?.pricingNotes ?? []} tone="muted" />
            {evaluation.rating && (
                <>
                    <Notes items={evaluation.rating.strengths} tone="good" />
                    <Notes items={evaluation.rating.concerns} tone="bad" />
                    <Notes items={evaluation.rating.notes} tone="muted" />
                </>
            )}
            {!shippingPending && <Notes items={underwriting.reasons} />}
            <Notes items={underwriting.assumptions} tone="muted" />
        </section>
    );
}

export function PathCard({ path, auction, referenceReason, shippingPending }: { path: MoneyPath; auction: boolean; referenceReason?: string | null; shippingPending?: boolean }) {
    if (path.status !== "PRICED") {
        return (
            <div className={styles.path}>
                <h4>{path.label}</h4>
                <p className={styles.muted}>Can't price: {path.reason}</p>
            </div>
        );
    }

    if (referenceReason) return <div className={styles.path}>
        <h4>{path.label} · reference estimate</h4>
        <p className={styles.muted}>{referenceReason}</p>
        <Pairs rows={[
            ["Reference resale before costs", dollars(path.salePrice)],
            ["Total purchase and route costs", dollars(path.cost)],
            ["Modeled result at that reference", dollars(path.profit)],
            ["Downside resale value", "Unknown"],
        ]} />
        <p className={styles.small}>The modeled result depends on an unverified resale reference. No purchase or bid limit is recommended from it.</p>
    </div>;
    const sale: [string, ReactNode][] =
        path.path === "GRADE"
            ? [
                  ["Service level", `${path.tier} (${dollars(path.gradingFee)})`],
                  ["Expected sale", dollars(path.expectedSale)],
              ]
            : [["Sells for", `${dollars(path.salePrice)}${path.priceCondition ? ` (${name(path.priceCondition)})` : ""}`]];

    const actionable = path.clears && !shippingPending;
    return (
        <div className={`${styles.path} ${actionable ? styles.clears : ""}`}>
            <div className={styles.pathHead}>
                <h4>{path.label}</h4>
                {actionable && <span className={styles.clearsTag}>Clears your targets</span>}
            </div>

            <Pairs
                rows={[
                    ...sale,
                    ["You keep", dollars(path.expectedNet)],
                    // An auction's bid days before the end means nothing, so its
                    // numbers are at the max bid; a Buy It Now's are at its price.
                    ...((auction
                        ? [
                              ["Cost at your max bid", dollars(path.costAtMaxBid)],
                              ["Profit at your max bid", `${dollars(path.profitAtMaxBid)} (${returnText(path.costAtMaxBid && path.profitAtMaxBid != null ? path.profitAtMaxBid / path.costAtMaxBid : null)})`],
                              ["Modeled downside at your max bid", path.downsideAtMaxBid === null ? "Unknown" : dollars(path.downsideAtMaxBid)],
                          ]
                        : [
                              [shippingPending ? "Cost with assumed shipping" : "All-in cost", dollars(path.cost)],
                              [
                                  shippingPending ? "Modeled profit" : "Profit",
                                  <span className={shippingPending ? undefined : (path.profit ?? 0) >= 0 ? styles.good : styles.bad}>
                                      {dollars(path.profit)} ({returnText(path.cost > 0 ? path.profit / path.cost : null)})
                                  </span>,
                              ],
                              ["Modeled downside", path.downside === null ? "Unknown" : dollars(path.downside)],
                          ]) as [string, ReactNode][]),
                    [auction ? "Max bid" : shippingPending ? "Provisional max price" : "Max price", <strong>{dollars(path.maxBid)}</strong>],
                ]}
            />

            {path.outlook && (
                <>
                <p className={styles.small}>Scenario weights are pricing assumptions, not measured probabilities of receiving a PSA or CGC grade.</p>
                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th>Grade</th>
                            <th>Scenario weight</th>
                            <th>Sells for</th>
                        </tr>
                    </thead>
                    <tbody>
                        {path.outlook.map((outlook) => (
                            <tr key={outlook.grade}>
                                <td>
                                    {path.grader} {outlook.grade}
                                </td>
                                <td>{percent(outlook.probability)}</td>
                                <td>
                                    {dollars(outlook.price)}
                                    {outlook.filledFrom !== null && (
                                        <span className={styles.muted}> (from {outlook.filledFrom})</span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                </>
            )}
        </div>
    );
}

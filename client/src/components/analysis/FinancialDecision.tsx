import type { ReactNode } from "react";
import type { Evaluation, MoneyPath, Targets, Underwriting } from "../../types";
import { dollars, name, percent, timeLeft } from "../../format";
import { MONEY_CONFIG } from "../../../../shared/money/config.ts";
import { returnText } from "../../../../shared/card-presentation.ts";
import { ceilingLabel } from "../../../../shared/format.ts";
import { AuctionSummary } from "../AuctionSummary";
import { RatingBadge, VerdictBadge } from "../VerdictBadge";
import { Tween } from "../Tween";
import { Notes, Pairs, Section } from "./primitives";
import { isResearchDeferred } from "../../../../shared/photo-review.ts";
import styles from "../DetailPanel.module.css";
import { priceEvidenceGap } from "../../../../shared/money/price-evidence.ts";

export function FinancialDecision({ evaluation, targets, now }: { evaluation: Evaluation; targets: Targets; now: number }) {
    const priceGap = priceEvidenceGap(evaluation);
    if (priceGap) return <Section title="Resale price unconfirmed">
        <p>{priceGap}</p>
        <Pairs rows={[
            [evaluation.listing.buyingOption === "AUCTION" ? "Current bid" : "Asking price", dollars(evaluation.listing.price)],
            ["Shipping", evaluation.listing.shipping === null ? "Not quoted" : dollars(evaluation.listing.shipping)],
            ...(evaluation.underwriting?.best ? [["Reference resale estimate before costs", dollars(evaluation.underwriting.best.salePrice)]] as [string, ReactNode][] : []),
        ]} />
        <p className={styles.small}>Saved photo findings remain available. A purchase or bid limit needs matched resale evidence; this estimate is not a purchase recommendation.</p>
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
    const left = timeLeft(listing.endTime, now);
    const room = best?.maxBid !== undefined && listing.price !== null ? best.maxBid - listing.price : null;

    const rows: [string, ReactNode][] = [
        [listing.buyingOption === "AUCTION" ? `Current bid (${listing.bids} bids)` : "Buy It Now", dollars(listing.price)],
        ["Shipping", listing.shipping === null ? `Not quoted · ${dollars(MONEY_CONFIG.buying.assumedShippingWhenUnknown)} assumed` : dollars(listing.shipping)],
    ];
    if (best?.path === "RAW") {
        const quote = evaluation.rawPricing?.prices?.find(price => price.condition === best.priceCondition);
        rows.push(["Raw sale estimate before fees", dollars(best.salePrice)]);
        rows.push(["Resale evidence", best.pricingNotes?.length ? "Conservative adjusted market fallback" : quote?.basis === "EBAY_SOLD" ? `${quote.comps?.count ?? "Matched"} eBay sold comps` : "TCGplayer market fallback"]);
        rows.push(["Net sale proceeds after fees and shipping", dollars(best.expectedNet)]);
    }

    if (room !== null) {
        // An auction's bid days before the end says nothing about the outcome.
        if (listing.buyingOption !== "AUCTION") rows.push([
            room >= 0 ? "Below your price limit" : "Above your price limit",
            <span className={room >= 0 ? styles.good : styles.bad}>{dollars(Math.abs(room))}</span>,
        ]);
    }
    if (best && (listing.buyingOption !== "AUCTION" || underwriting.verdict.startsWith("BUY"))) {
        // An auction's bid will rise, so its profit is shown at the max bid.
        const auction = listing.buyingOption === "AUCTION";
        const profit = auction ? best.profitAtMaxBid : best.profit;
        const investment = auction ? best.costAtMaxBid : best.cost;
        const roi = investment && profit !== null ? profit / investment : null;

        rows.push([
            auction ? "Est. profit at max bid" : (profit ?? 0) < 0 ? "Est. net loss at asking" : "Est. net profit at asking",
            <span className={(profit ?? 0) >= 0 ? styles.good : styles.bad}>
                {dollars(profit === null ? null : Math.abs(profit))} ({returnText(roi)} return on total cost)
            </span>,
        ]);
        if (!auction) rows.push(["Est. total invested", dollars(best.cost)]);
    }
    if (left) {
        rows.push(["Ends in", left]);
    }

    // An auction ends near its usual price, not near today's bid.
    const outlook = evaluation.rating?.auction;

    if (outlook) {
        rows.push(["Usually sells for", dollars(outlook.usualPrice)]);

        if (outlook.profitAtUsual != null) {
            rows.push([
                "Profit if it ends there",
                <span className={outlook.profitAtUsual >= 0 ? styles.good : styles.bad}>{dollars(outlook.profitAtUsual)}</span>,
            ]);
        }

        if (outlook.salesTotal !== null) {
            rows.push(["Recent sales at or under max bid", `${outlook.salesAtOrUnder} of ${outlook.salesTotal}`]);
        }
    }

    return (
        <section className={styles.verdict}>
            <div className={styles.badges}>
                {evaluation.rating && <RatingBadge level={evaluation.rating.level} large />}
                <VerdictBadge verdict={underwriting.verdict} large />
            </div>

            {best?.maxBid !== undefined && (
                <div className={styles.hero}>
                    <span className={styles.heroLabel}>{ceilingLabel(listing.buyingOption)} · {best.label}</span>
                    {/* Green to buy, purple to grade: the verdict's color, not today's bid. */}
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
                    <span className={styles.heroLabel}>{best.label}</span>
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
            <Notes items={underwriting.reasons} />
            <Notes items={underwriting.assumptions} tone="muted" />
        </section>
    );
}

export function PathCard({ path, auction, referenceReason }: { path: MoneyPath; auction: boolean; referenceReason?: string | null }) {
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

    return (
        <div className={`${styles.path} ${path.clears ? styles.clears : ""}`}>
            <div className={styles.pathHead}>
                <h4>{path.label}</h4>
                {path.clears && <span className={styles.clearsTag}>Clears your targets</span>}
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
                              ["All-in cost", dollars(path.cost)],
                              [
                                  "Profit",
                                  <span className={(path.profit ?? 0) >= 0 ? styles.good : styles.bad}>
                                      {dollars(path.profit)} ({returnText(path.cost > 0 ? path.profit / path.cost : null)})
                                  </span>,
                              ],
                              ["Modeled downside", path.downside === null ? "Unknown" : dollars(path.downside)],
                          ]) as [string, ReactNode][]),
                    [auction ? "Max bid" : "Max price", <strong>{dollars(path.maxBid)}</strong>],
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

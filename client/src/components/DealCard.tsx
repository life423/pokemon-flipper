import type { AnalysisState } from "../App";
import type { ListingSummary } from "../types";
import { dollars, percent, timeLeft } from "../format";
import { RatingBadge, VerdictBadge } from "./VerdictBadge";
import { describeOutlook } from "../../../shared/money/auction.ts";
import styles from "./DealCard.module.css";

interface Props {
    listing: ListingSummary;
    analysis?: AnalysisState;
    selected: boolean;
    now: number;
    onOpen: () => void;
}

const SCREEN_TAGS = {
    CANDIDATE: "Could be profitable",
    DROPPED: "Too pricey even at best",
    UNSCREENED: "Couldn't check",
};

export function DealCard({ listing, analysis, selected, now, onOpen }: Props) {
    const evaluation = analysis?.status === "done" ? analysis.evaluation : null;
    const underwriting = evaluation?.underwriting ?? null;
    const best = underwriting?.best ?? null;
    const rating = evaluation?.rating ?? null;
    const deal = underwriting?.verdict.startsWith("BUY") ?? false;
    const screen = listing.screen;

    const left = timeLeft(listing.endTime, now);
    const auction = listing.buyingOption === "AUCTION";

    const action =
        analysis?.status === "loading" ? "Analyzing..." : analysis ? "View analysis" : "Analyze";

    // One line under the title: why it's a deal, or what the free check found.
    let line: string | null = null;

    if (deal && best) {
        // For an auction, how often the card sells as low as the max bid.
        const why = rating?.auction ? describeOutlook(rating.auction, best.maxBid) : (rating?.concerns[0] ?? rating?.strengths[0]);
        line = why ? `${best.label}. ${why}` : best.label;
    } else if (!evaluation && screen?.status === "CANDIDATE") {
        line = `At best (${screen.assumed}): ${screen.bestCase?.label.toLowerCase()}.`;
    } else if (!evaluation && screen?.status === "UNSCREENED") {
        line = screen.reason;
    } else if (underwriting && !deal) {
        line = underwriting.reasons[0] ?? null;
    }

    return (
        <article className={`${styles.card} ${selected ? styles.selected : ""}`}>
            <div className={styles.inner}>
                <div className={styles.photo}>
                    {listing.images[0] && <img src={listing.images[0]} alt="" loading="lazy" />}
                </div>

                <div className={styles.body}>
                    <div className={styles.tags}>
                        {deal && rating && <RatingBadge level={rating.level} />}
                        {underwriting && <VerdictBadge verdict={underwriting.verdict} />}
                        {!underwriting && screen && (
                            <span className={styles.tag}>{screen.longShot ? "Long-shot auction" : SCREEN_TAGS[screen.status]}</span>
                        )}
                        <span className={styles.tag}>{auction ? `Auction, ${listing.bids} bids` : "Buy It Now"}</span>
                        <span className={styles.tag}>{listing.isGraded ? "Graded" : "Raw"}</span>
                    </div>

                    <h2 className={styles.name}>{listing.title}</h2>

                    <dl className={styles.numbers}>
                        <div>
                            <dt>{auction ? "Current bid" : "Price"}</dt>
                            <dd>{dollars(listing.currentPrice)}</dd>
                        </div>

                        {deal && best ? (
                            <>
                                <div className={styles.maxBid}>
                                    <dt>Max bid</dt>
                                    <dd>{dollars(best.maxBid)}</dd>
                                </div>
                                <div className={styles.profit}>
                                    {auction ? (
                                        <>
                                            <dt>Profit at max bid</dt>
                                            <dd>
                                                {dollars(best.profitAtMaxBid)} <span>{percent(best.roiAtMaxBid)}</span>
                                            </dd>
                                        </>
                                    ) : (
                                        <>
                                            <dt>Profit</dt>
                                            <dd>
                                                {dollars(best.profit)} <span>{percent(best.roi)}</span>
                                            </dd>
                                        </>
                                    )}
                                </div>
                                {rating?.room != null && (
                                    <div>
                                        <dt>Under max bid</dt>
                                        <dd>{percent(rating.room)}</dd>
                                    </div>
                                )}
                            </>
                        ) : (
                            <>
                                <div>
                                    <dt>Shipping</dt>
                                    <dd>{listing.shipping === null ? "Not quoted" : dollars(listing.shipping)}</dd>
                                </div>
                                {best ? (
                                    <div>
                                        <dt>Max bid</dt>
                                        <dd>{dollars(best.maxBid)}</dd>
                                    </div>
                                ) : (
                                    screen?.bestCase && (
                                        <div className={styles.muted}>
                                            <dt>Max bid at best</dt>
                                            <dd>{dollars(screen.bestCase.maxBid)}</dd>
                                        </div>
                                    )
                                )}
                            </>
                        )}

                        {left && (
                            <div>
                                <dt>Ends in</dt>
                                <dd>{left}</dd>
                            </div>
                        )}
                    </dl>

                    {line && <p className={styles.line}>{line}</p>}

                    <div className={styles.actions}>
                        <button type="button" className={styles.open} onClick={onOpen}>
                            {action}
                        </button>
                        <a href={listing.url} target="_blank" rel="noopener noreferrer">
                            eBay
                        </a>
                    </div>
                </div>
            </div>
        </article>
    );
}

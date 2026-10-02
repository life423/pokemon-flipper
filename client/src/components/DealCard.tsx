import type { AnalysisState } from "../App";
import type { ListingSummary } from "../types";
import { dollars, percent, timeLeft } from "../format";
import { RatingBadge, VerdictBadge } from "./VerdictBadge";
import { describeOutlook } from "../../../shared/money/auction.ts";
import { ceilingLabel } from "../../../shared/format.ts";
import { describeOffer, offerFor, offerWorthMaking } from "../../../shared/money/offer.ts";
import { bargainScore, bargainSignals } from "../../../shared/signals.ts";
import { Tween } from "./Tween";
import type { CSSProperties } from "react";
import styles from "./DealCard.module.css";

interface Props {
    // Place in the list, for the arrival stagger.
    index?: number;
    transitionName?: string;
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

export function DealCard({ listing, analysis, selected, now, onOpen, index = 0, transitionName }: Props) {
    const evaluation = analysis?.status === "done" ? analysis.evaluation : null;
    const underwriting = evaluation?.underwriting ?? null;
    const best = underwriting?.best ?? null;
    const rating = evaluation?.rating ?? null;
    const deal = underwriting?.verdict.startsWith("BUY") ?? false;
    const screen = listing.screen;

    const left = timeLeft(listing.endTime, now);
    const auction = listing.buyingOption === "AUCTION";
    const ceiling = ceilingLabel(listing.buyingOption);
    const plan = offerFor(listing, best?.maxBid);
    // Doesn't clear at its asking price, but would at a realistic offer.
    const offer = underwriting?.verdict === "PASS" && offerWorthMaking(plan) ? plan : null;
    // Signs it's overlooked because of how it was listed. Not a buy signal.
    const signals = bargainSignals(listing, evaluation, now);

    // The card's priority, in the palette's meanings: a deal in its path's
    // color, an offer in the interactive color, a closer look in amber, and
    // passes, drops, and long shots receding. Unverified stays neutral.
    const tone =
        rating?.level === "LONG_SHOT" || screen?.longShot
            ? "quiet"
            : deal
              ? rating?.level === "THIN"
                  ? "watch"
                  : best?.path === "GRADE"
                    ? "grade"
                    : "buy"
              : offer
                ? "offer"
                : underwriting?.verdict === "NEEDS_REVIEW" || underwriting?.verdict === "CANT_PRICE"
                  ? "watch"
                  : underwriting?.verdict === "PASS" || (screen && screen.status !== "CANDIDATE")
                    ? "quiet"
                    : "pending";

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
    } else if (offer && listing.currentPrice !== null) {
        line = describeOffer(offer, listing.currentPrice);
    } else if (underwriting && !deal) {
        line = underwriting.reasons[0] ?? null;
    }

    return (
        <article
            className={`${styles.card} ${selected ? styles.selected : ""}`}
            data-tone={tone}
            // A short stagger as results arrive; a name to glide by when sorted.
            style={{ "--i": Math.min(index, 10), viewTransitionName: transitionName } as CSSProperties}
        >
            <div className={styles.inner}>
                <div className={styles.photo}>
                    {listing.images[0] && <img src={listing.images[0]} alt="" loading="lazy" />}
                </div>

                <div className={styles.body}>
                    <div className={styles.tags}>
                        {deal && rating && <RatingBadge level={rating.level} />}
                        {offer ? (
                            <span className={styles.offerTag}>Make an offer: {dollars(offer.offer)}</span>
                        ) : (
                            underwriting && <VerdictBadge verdict={underwriting.verdict} />
                        )}
                        {deal && plan && <span className={styles.tag}>Accepts offers</span>}
                        {signals.length > 0 && (
                            <span className={styles.bargainTag} title={signals.map((signal) => signal.label).join(", ")}>
                                Bargain {bargainScore(signals)}: {signals[0].label}
                                {signals.length > 1 ? ` +${signals.length - 1}` : ""}
                            </span>
                        )}
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
                                    <dt>{ceiling}</dt>
                                    <dd><Tween value={best.maxBid} format={dollars} /></dd>
                                </div>
                                <div className={styles.profit}>
                                    {auction && rating?.auction?.profitAtUsual != null ? (
                                        <>
                                            <dt>Profit near usual price</dt>
                                            <dd><Tween value={rating.auction.profitAtUsual} format={dollars} /></dd>
                                        </>
                                    ) : auction ? (
                                        <>
                                            <dt>Profit at max bid</dt>
                                            <dd>
                                                <Tween value={best.profitAtMaxBid} format={dollars} /> <span>{percent(best.roiAtMaxBid)}</span>
                                            </dd>
                                        </>
                                    ) : (
                                        <>
                                            <dt>Profit</dt>
                                            <dd>
                                                <Tween value={best.profit} format={dollars} /> <span>{percent(best.roi)}</span>
                                            </dd>
                                        </>
                                    )}
                                </div>
                                {rating?.room != null && (
                                    <div>
                                        <dt>Under {ceiling.toLowerCase()}</dt>
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
                                        <dt>{ceiling}</dt>
                                        <dd><Tween value={best.maxBid} format={dollars} /></dd>
                                    </div>
                                ) : (
                                    screen?.bestCase && (
                                        <div className={styles.muted}>
                                            <dt>{ceiling} at best</dt>
                                            <dd><Tween value={screen.bestCase.maxBid} format={dollars} /></dd>
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

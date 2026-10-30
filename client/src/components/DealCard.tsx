import type { CSSProperties } from "react";
import type { AnalysisState } from "../App";
import type { ListingSummary, Targets } from "../types";
import { dollars, timeLeft, name } from "../format";
import { ceilingLabel } from "../../../shared/format.ts";
import { numbersAtOffer, offerFor, offerWorthMaking } from "../../../shared/money/offer.ts";
import { MONEY_CONFIG } from "../../../shared/money/config.ts";
import { auctionDecision, returnText } from "../../../shared/card-presentation.ts";
import { yearOf } from "../../../shared/sets.ts";
import { resaleActivity } from "../../../shared/liquidity.ts";
import { photoEvidence } from "../../../shared/photo-evidence.ts";
import { currentSellerMistakes } from "../../../shared/seller-mistakes.ts";
import { AuctionSummary } from "./AuctionSummary";
import { GradingComparison } from "./GradingComparison";
import { PhotoReview, type DeeperReviewState } from "./PhotoReview";
import styles from "./DealCard.module.css";

interface Props {
    index?: number;
    transitionName?: string;
    listing: ListingSummary;
    analysis?: AnalysisState;
    selected: boolean;
    now: number;
    onOpen: () => void;
    years: Record<string, number>;
    minGrade?: number;
    targets?: Targets;
    photoReviewState?: DeeperReviewState;
    saved?: boolean;
    saving?: boolean;
    onSave?: () => void;
}
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 2 });
const signed = (value: number) => `${value < 0 ? "−" : "+"}${dollars(Math.abs(value))}`;

export function DealCard({ listing, analysis, selected, now, onOpen, years, index = 0, transitionName, minGrade = 0, targets = MONEY_CONFIG.targets, photoReviewState, saved, saving, onSave }: Props) {
    const evaluation = analysis?.status === "done" ? analysis.evaluation : null;
    const best = evaluation?.underwriting?.best;
    const verdict = evaluation?.underwriting?.verdict;
    const deal = verdict?.startsWith("BUY");
    const auction = listing.buyingOption === "AUCTION";
    const decision = auction && evaluation ? auctionDecision(evaluation, targets, now) : null;
    const screen = listing.screen;
    const pricePending = !evaluation && screen?.priceAnomaly && !screen.priceAnomaly.photoChecked;
    const plan = offerFor(listing, best?.maxBid);
    const offer = verdict === "PASS" && offerWorthMaking(plan) ? plan : null;
    const offerNumbers = offer && best ? numbersAtOffer(best, offer) : null;
    const evidence = evaluation ? photoEvidence(evaluation, minGrade) : null;
    const mistakes = currentSellerMistakes(listing, evaluation);
    const activity = resaleActivity(evaluation, now);
    const card = evaluation?.identity ?? screen?.card;
    const number = card?.cardNumber?.replace(/^0+(?=\d)/, "");
    const title = card?.name ? [card.name, number].filter(Boolean).join(" ") : listing.title;
    const subtitle = card?.name ? [card.set, yearOf(years, card.set), card.printing !== "UNLIMITED" ? card.printingLabel : null].filter(Boolean).join(" · ") : listing.isGraded ? "Graded card" : "Raw card";
    const longShot = evaluation?.rating?.level === "LONG_SHOT" || screen?.longShot;
    const [badge, tone] = analysis?.status === "loading" ? ["Analyzing", "pending"]
        : decision?.status === "ENDED" ? ["Ended", "quiet"]
        : decision?.status === "OVER_LIMIT" ? ["Over limit", "pass"]
        : decision?.status === "PROVISIONAL" ? ["Your review needed", "watch"]
        : longShot ? ["Long shot", "quiet"]
        : deal && auction ? [decision?.breakEven ? "Break-even" : "Within limit", decision?.breakEven ? "watch" : "buy"]
        : deal ? [evaluation?.rating?.level === "THIN" ? "Thin margin" : best?.path === "GRADE" ? "Buy + grade" : "Buy", best?.path === "GRADE" ? "grade" : "buy"]
        : offer ? ["Offer", "offer"]
        : verdict === "NEEDS_REVIEW" ? ["Your review needed", "watch"]
        : verdict === "CANT_PRICE" ? ["Can't price", "watch"]
        : verdict === "PASS" ? ["Pass", "pass"]
        : pricePending ? ["Verify price", "watch"]
        : mistakes.length ? ["Photo lead", "watch"]
        : screen?.status === "CANDIDATE" ? [auction ? "Auction watch" : "Possible", "pending"]
        : screen?.status === "DROPPED" ? ["Above limit", "quiet"] : ["Unverified", "quiet"];
    const seller = listing.seller;
    const sellerText = seller?.feedbackScore === 0 ? "New seller" : seller?.feedbackPercentage != null
        ? `${seller.feedbackPercentage}% · ${seller.feedbackScore == null ? "rating count unavailable" : `${seller.feedbackScore < 1000 ? seller.feedbackScore.toLocaleString() : COMPACT.format(seller.feedbackScore)} ratings`}` : "Not available";
    const ceiling = best?.maxBid ?? (!evaluation ? screen?.bestCase?.maxBid : null);
    return <article className={`${styles.card} ${selected ? styles.selected : ""}`} data-tone={tone}
        style={{ "--i": Math.min(index, 10), viewTransitionName: transitionName } as CSSProperties}>
        <button type="button" className={styles.hit} onClick={onOpen} aria-label={`Open ${title}`} />
        <header className={styles.head}>
            <div className={styles.photo}>{listing.images[0] && <img src={listing.images[0]} alt="" loading="lazy" />}</div>
            <div className={styles.identity}><h2>{title}</h2><p>{subtitle}</p></div>
            <span className={styles.badge}>{badge}</span>
        </header>
        <PhotoReview compact evaluation={evaluation} listing={listing} state={photoReviewState} phase={analysis?.status === "loading" || analysis?.status === "error" ? analysis.status : undefined} />
        {auction && evaluation ? <AuctionSummary evaluation={evaluation} targets={targets} now={now} /> : <>
            <div className={styles.money}>
                <div><span className={styles.label}>{auction ? "Current bid" : "Asking price"}</span><strong className={styles.price}>{dollars(listing.currentPrice)}</strong></div>
                {best && <div><span className={styles.label}>Est. net {best.profit < 0 ? "loss" : "profit"} at asking</span><strong className={best.profit >= 0 ? styles.gain : styles.loss}>{dollars(Math.abs(best.profit))}</strong><span className={styles.label}>{returnText(best.cost > 0 ? best.profit / best.cost : null)} return on total cost</span></div>}
            </div>
            {best && <p className={styles.note}>{best.label} · total invested {dollars(best.cost)} · includes tax, shipping{best.path === "GRADE" ? " and grading" : ""}. Sale fees are included in net profit.</p>}
            {ceiling != null && <p className={styles.limit}>{best ? ceilingLabel(listing.buyingOption) : "Unverified screening ceiling"}: {dollars(ceiling)}</p>}
            <p className={styles.note}>{auction ? `${timeLeft(listing.endTime, now) ?? "End time unavailable"} · ${listing.bids} bids · ` : ""}{listing.shipping === null ? "Shipping not quoted" : listing.shipping === 0 ? "Free shipping" : `${dollars(listing.shipping)} shipping`}</p>
        </>}
        {pricePending && <p className={styles.notice}>Unusually low price. Awaiting photo verification.</p>}
        {offer && offerNumbers && <p className={styles.notice}>Offer {dollars(offer.offer)} · est. profit {signed(offerNumbers.profit)} if accepted. Acceptance is unknown.</p>}
        {mistakes[0] && <p className={styles.note}>{mistakes[0].detail}</p>}
        {evaluation?.condition && <GradingComparison evaluation={evaluation} />}
        {evaluation?.slab && <p className={styles.certified}>Certified label: {evaluation.slab.grader ?? "Unknown grader"} {evaluation.slab.grade ?? "Unreadable"}</p>}
        {minGrade > 0 && evidence && <p className={styles.note}>{evidence.target}</p>}
        <dl className={styles.facts}>
            <div><dt>Seller</dt><dd>{sellerText}</dd></div>
            <div><dt>AI raw condition</dt><dd>{evaluation?.condition ? name(evaluation.condition.rawCondition) : evaluation?.slab ? "Certified slab" : "Not assessed"}</dd></div>
        </dl>
        {evaluation && <p className={styles.note} title={activity.detail}>{activity.label}{activity.recentSales !== null ? ` · ${activity.recentSales} observed ${activity.recentSales === 1 ? "sale" : "sales"} / 30 days` : ""}</p>}
        <div className={styles.actions}><p className={styles.openHint}>View analysis <span aria-hidden="true">↗</span></p>
            {onSave && <button type="button" className={styles.save} onClick={() => { if (!saving) onSave(); }} aria-disabled={saving} aria-pressed={saved} aria-label={`${saved ? "Remove" : "Save"} ${title} ${saved ? "from" : "to"} shortlist`}>{saving ? "Saving…" : saved ? "Saved ✓" : "Save"}</button>}
        </div>
    </article>;
}

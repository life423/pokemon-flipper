import type { CSSProperties } from "react";
import type { AnalysisState } from "../analysis-state";
import { canRetryPricing } from "../../../shared/pricing-retries.ts";
import type { ListingSummary, Targets } from "../types";
import { dollars, timeLeft, name } from "../format";
import { ceilingLabel } from "../../../shared/format.ts";
import { numbersAtOffer, offerFor, offerWorthMaking } from "../../../shared/money/offer.ts";
import { MONEY_CONFIG } from "../../../shared/money/config.ts";
import { auctionDecision, returnText } from "../../../shared/card-presentation.ts";
import { yearOf } from "../../../shared/sets.ts";
import { resaleActivity } from "../../../shared/liquidity.ts";
import { observedCardKind, photoEvidence } from "../../../shared/photo-evidence.ts";
import { currentSellerMistakes } from "../../../shared/seller-mistakes.ts";
import { AuctionSummary } from "./AuctionSummary";
import { GradingComparison } from "./GradingComparison";
import { PhotoReview, type DeeperReviewState } from "./PhotoReview";
import styles from "./DealCard.module.css";
import { cardDetails } from "../../../shared/card-details.ts";
import { claimedCondition, CONDITION_NAMES } from "../../../shared/conditions.ts";
import { isResearchDeferred, photoReviewStatus } from "../../../shared/photo-review.ts";
import { SoldPriceScreening } from "./SoldPriceScreening";
import { priceEvidenceGap } from "../../../shared/money/price-evidence.ts";

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
const LISTED_DATE = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const signed = (value: number) => `${value < 0 ? "−" : "+"}${dollars(Math.abs(value))}`;
const dateOf = (value: string | null | undefined) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value) : null;

export function DealCard({ listing, analysis, selected, now, onOpen, years, index = 0, transitionName, minGrade = 0, targets = MONEY_CONFIG.targets, photoReviewState, saved, saving, onSave }: Props) {
    const evaluation = analysis?.status === "done" ? analysis.evaluation : null;
    const priceGap = priceEvidenceGap(evaluation);
    const deferred = Boolean(priceGap) || isResearchDeferred(evaluation);
    const priceReview = Boolean(priceGap && evaluation && photoReviewStatus(evaluation).needsYourReview);
    const best = evaluation?.underwriting?.best;
    const verdict = evaluation?.underwriting?.verdict;
    const deal = !priceGap && verdict?.startsWith("BUY");
    const auction = listing.buyingOption === "AUCTION";
    const decision = auction && evaluation ? auctionDecision(evaluation, targets, now) : null;
    const screen = listing.screen;
    const pricePending = !evaluation && screen?.priceAnomaly && !screen.priceAnomaly.photoChecked;
    const plan = offerFor(listing, best?.maxBid);
    const offer = !deferred && verdict === "PASS" && offerWorthMaking(plan) ? plan : null;
    const offerNumbers = offer && best ? numbersAtOffer(best, offer) : null;
    const evidence = evaluation ? photoEvidence(evaluation, minGrade) : null;
    const mistakes = currentSellerMistakes(listing, evaluation);
    const activity = resaleActivity(evaluation, now);
    const card = evaluation?.identity ?? screen?.card;
    const details = cardDetails(listing, evaluation);
    const observedKind = observedCardKind(evaluation);
    const rawConditionApplies = observedKind === "raw" || observedKind === null && !listing.isGraded &&
        !evaluation?.slab && !evaluation?.photoCheck?.slab?.present && evaluation?.photoCheck?.holder !== "GRADED_SLAB";
    const number = card?.cardNumber?.replace(/^0+(?=\d)/, "");
    const title = card?.name ? [card.name, number].filter(Boolean).join(" ") : listing.title;
    const subtitle = card?.name ? [card.set, yearOf(years, card.set), card.printing !== "UNLIMITED" ? card.printingLabel : null].filter(Boolean).join(" · ") : listing.isGraded ? "Graded card" : "Raw card";
    const [badge, tone] = analysis?.status === "loading" ? ["Analyzing", "pending"]
        : analysis?.status === "error" ? ["Analysis failed", "watch"]
        : deferred ? [priceReview ? "Your review needed" : priceGap ? "Price unconfirmed" : "Research deferred", priceReview ? "watch" : "quiet"]
        : decision?.status === "ENDED" ? ["Ended", "quiet"]
        : decision?.status === "OVER_LIMIT" ? ["Over limit", "pass"]
        : decision?.status === "PROVISIONAL" ? ["Your review needed", "watch"]
        : deal && auction ? ["Within limit", decision?.anyTargets ? "watch" : "buy"]
        : deal ? [evaluation?.rating?.level === "THIN" ? "Thin margin" : best?.path === "GRADE" ? "Buy + grade" : "Buy", best?.path === "GRADE" ? "grade" : "buy"]
        : offer ? ["Offer", "offer"]
        : verdict === "NEEDS_REVIEW" ? ["Your review needed", "watch"]
        : verdict === "CANT_PRICE" ? ["Can't price", "watch"]
        : verdict === "PASS" ? ["Pass", "pass"]
        : !evaluation && screen?.gradingLead ? ["Grading candidate", "pending"]
        : !evaluation && screen?.soldEvidence && screen.soldEvidence.status !== "AVAILABLE" ? ["Price unconfirmed", "quiet"]
        : !evaluation && canRetryPricing(listing, now) ? ["Waiting for price", "pending"]
        : pricePending ? ["Verify price", "watch"]
        : mistakes.length ? ["Photo lead", "watch"]
        : screen?.status === "CANDIDATE" ? [auction ? "Auction watch" : "Possible", "pending"]
        : screen?.status === "DROPPED" ? ["Preliminary: above target", "quiet"] : ["Unverified", "quiet"];
    const seller = listing.seller;
    const sellerText = seller?.feedbackScore === 0 ? "New seller" : seller?.feedbackPercentage != null
        ? `${seller.feedbackPercentage}% · ${seller.feedbackScore == null ? "rating count unavailable" : `${seller.feedbackScore < 1000 ? seller.feedbackScore.toLocaleString() : COMPACT.format(seller.feedbackScore)} ratings`}` : "Not available";
    const ceiling = best?.maxBid ?? (!evaluation ? screen?.bestCase?.maxBid : null);
    const listedAt = dateOf(evaluation?.listing.listedAt) ?? dateOf(listing.listedAt);
    const listingDate = listedAt ?? dateOf(evaluation?.listing.createdAt) ?? dateOf(listing.createdAt);
    return <article className={`${styles.card} ${selected ? styles.selected : ""}`} data-tone={tone}
        style={{ "--i": Math.min(index, 10), viewTransitionName: transitionName } as CSSProperties}>
        <button type="button" className={styles.hit} onClick={onOpen} aria-label={`Open ${title}, ${auction ? "Auction" : "Buy It Now"}, ${details.source}: ${details.grade}, ${details.finish}`} />
        <header className={styles.head}>
            <div className={styles.photo}>{listing.images[0] && <img src={listing.images[0]} alt="" loading="lazy" />}</div>
            <div className={styles.identity}><p className={styles.saleType}>{auction ? "Auction" : "Buy It Now"}</p><h2>{title}</h2><p>{subtitle}</p><p className={styles.details}><span>{details.source}: </span>{details.grade} · {details.finish}</p>
                <p>{listingDate ? <>{listedAt ? "Listed" : "Created"} <time dateTime={listingDate.toISOString()} title={listingDate.toUTCString()}>{LISTED_DATE.format(listingDate)}</time></> : "Listed time unavailable"}</p>
            </div>
            <span className={styles.badge}>{badge}</span>
        </header>
        <PhotoReview compact evaluation={evaluation} listing={listing} state={photoReviewState} phase={analysis?.status === "loading" || analysis?.status === "error" ? analysis.status : undefined} />
        {priceGap ? <p className={styles.note}>{priceGap}</p> : evaluation?.underwriting?.verdict === "CANT_PRICE" && <p className={styles.note}>{evaluation.underwriting.reasons[0]}</p>}
        {!evaluation && screen?.soldEvidence && <SoldPriceScreening listing={listing} compact />}
        {!evaluation && !screen?.soldEvidence && screen?.status === "UNSCREENED" && <p className={styles.note}>{screen.pricingIssue?.kind === "RATE_LIMIT" ? "Pricing paused for provider cooldown." : screen.pricingIssue?.kind === "TEMPORARY" ? "Price lookup temporarily unavailable." : screen.pricingIssue?.kind === "CREDITS" ? "Pricing unavailable. Check provider credits." : screen.pricingIssue?.kind === "CONFIG" ? "Pricing unavailable. Check provider setup." : screen.reason}</p>}
        {deferred ? <div className={styles.money}><div><span className={styles.label}>{auction ? "Current bid" : "Asking price"}</span><strong className={styles.price}>{dollars(listing.currentPrice)}</strong></div></div> : auction && evaluation ? <AuctionSummary evaluation={evaluation} targets={targets} now={now} /> : <>
            <div className={styles.money}>
                <div><span className={styles.label}>{auction ? "Current bid" : "Asking price"}</span><strong className={styles.price}>{dollars(listing.currentPrice)}</strong></div>
                {best && <div><span className={styles.label}>Est. net {best.profit < 0 ? "loss" : "profit"} at asking</span><strong className={best.profit >= 0 ? styles.gain : styles.loss}>{dollars(Math.abs(best.profit))}</strong><span className={styles.label}>{returnText(best.cost > 0 ? best.profit / best.cost : null)} return on total cost</span></div>}
            </div>
            {best && <p className={styles.note}>{best.label} · total invested {dollars(best.cost)} · includes tax, shipping{best.path === "GRADE" ? " and grading" : ""}. Sale fees are included in net profit.</p>}
            {ceiling != null && <p className={styles.limit}>{best ? ceilingLabel(listing.buyingOption) : "Unverified screening ceiling"}: {dollars(ceiling)}</p>}
            <p className={styles.note}>{auction ? `${timeLeft(listing.endTime, now) ?? "End time unavailable"} · ${listing.bids} bids · ` : ""}{listing.shipping === null ? !evaluation && screen?.soldEvidence
                ? "Shipping not quoted · preliminary screening excludes shipping; confirm before buying"
                : `Shipping not quoted · ${dollars(MONEY_CONFIG.buying.assumedShippingWhenUnknown)} assumed in estimates` : listing.shipping === 0 ? "Free shipping" : `${dollars(listing.shipping)} shipping`}</p>
        </>}
        {pricePending && <p className={styles.notice}>Unusually low price. Awaiting photo verification.</p>}
        {offer && offerNumbers && <p className={styles.notice}>Offer {dollars(offer.offer)} · est. profit {signed(offerNumbers.profit)} if accepted. Acceptance is unknown.</p>}
        {mistakes[0] && <p className={styles.note}>{mistakes[0].detail}</p>}
        {!priceGap && best?.path === "RAW" && <p className={styles.note}>Estimated resale {dollars(best.salePrice)} · {name(best.priceCondition ?? "UNKNOWN")} · eBay sold median.</p>}
        {best?.path === "GRADED_RESALE" && evaluation?.slabPricing?.activeReference && !evaluation.slabPricing.summary?.count && <p className={styles.note}>Resale target {dollars(best.salePrice)} · below photo-checked Buy It Now competition.</p>}
        {evaluation?.condition && <GradingComparison evaluation={evaluation} />}
        {evaluation?.condition && claimedCondition(evaluation.listing.cardCondition) && <p className={styles.note}>Seller says: {CONDITION_NAMES[claimedCondition(evaluation.listing.cardCondition)!]} · AI assesses: {name(evaluation.condition.rawCondition)}</p>}
        {minGrade > 0 && evidence && <p className={styles.note}>{evidence.target}</p>}
        <dl className={styles.facts}>
            <div><dt>Seller</dt><dd>{sellerText}</dd></div>
            {rawConditionApplies && <div><dt>AI raw condition</dt><dd>{evaluation?.condition ? name(evaluation.condition.rawCondition) : "Not assessed"}</dd></div>}
        </dl>
        {evaluation && <p className={styles.note} title={activity.detail}>{activity.label}{activity.recentSales !== null ? ` · ${activity.recentSales} ${activity.scope === "MATCHED" ? "matching sold comps" : evaluation.marketActivity?.scope === "RAW" ? "sales across raw conditions" : "sales across all grades"} / 30 days` : ""}</p>}
        <div className={styles.actions}><p className={styles.openHint}>View analysis <span aria-hidden="true">↗</span></p>
            {onSave && <button type="button" className={styles.save} onClick={() => { if (!saving) onSave(); }} aria-disabled={saving} aria-pressed={saved} aria-label={saving ? `Saving… ${title}` : saved ? `Saved: remove ${title} from shortlist` : `Save ${title} to shortlist`}>{saving ? "Saving…" : saved ? <>Saved <span className={styles.savedMark} aria-hidden="true">✓</span></> : "Save"}</button>}
        </div>
    </article>;
}

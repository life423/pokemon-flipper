import type { CSSProperties } from "react";
import type { AnalysisState } from "../analysis-state";
import { currentBinComparison } from "../../../shared/bin-market-comparison.ts";
import type { ListingSummary, Targets } from "../types";
import { dollars, timeLeft, name } from "../format";
import { ceilingLabel } from "../../../shared/format.ts";
import { numbersAtOffer } from "../../../shared/money/offer.ts";
import { MONEY_CONFIG } from "../../../shared/money/config.ts";
import { acquisitionCost } from "../../../shared/money/underwriting.ts";
import { slabBuyGuidance } from "../../../shared/money/slab-buy-guidance.ts";
import { applyVerifiedPurchase, PURCHASE_RECHECK_MESSAGE } from "../../../shared/money/verified-purchase.ts";
import { rawBuyGuidance } from "../../../shared/money/raw-buy-guidance.ts";
import { auctionDecision, returnText } from "../../../shared/card-presentation.ts";
import { readyForPricing } from "../../../shared/identity.ts";
import { unconfirmedResale } from "../../../shared/wait-skip-review.ts";
import { yearOf } from "../../../shared/sets.ts";
import { resaleActivity } from "../../../shared/liquidity.ts";
import { SALES_ACTIVITY_DAYS } from "../../../shared/sales-activity.ts";
import { hasSlabEvidence, photoEvidence } from "../../../shared/photo-evidence.ts";
import { currentSellerMistakes } from "../../../shared/seller-mistakes.ts";
import { AuctionSummary } from "./AuctionSummary";
import { AuctionReminderButton } from "./AuctionReminderButton";
import type { SniperDraft } from "./AuctionSniper";
import { RawCardGrade } from "./RawCardGrade";
import { ListingThumbnail } from "./ListingThumbnail";
import { PhotoReview, type DeeperReviewState } from "./PhotoReview";
import styles from "./DealCard.module.css";
import { releaseIssue, withReleaseEvidence } from "../../../shared/base-set-release.ts";
import { listingMarketPrices } from "../../../shared/listing-market-prices.ts";
import { MarketPrices } from "./MarketPrices";
import { cardDetails } from "../../../shared/card-details.ts";
import { claimedCondition, conditionGap, CONDITION_NAMES, isRawCondition } from "../../../shared/conditions.ts";
import { isResearchDeferred, photoReviewStatus, printingReviewReasons } from "../../../shared/photo-review.ts";
import { SoldPriceScreening } from "./SoldPriceScreening";
import { isRawSoldPrice, priceEvidenceGap, rawPriceForPath } from "../../../shared/money/price-evidence.ts";
import { resultGroup } from "../../../shared/analysis.ts";
import { listingOffer, SellerOfferDraft, type ReviewedDecision } from "./analysis/OfferSection";
import { soldEstimateBasis, tcgplayerEstimateLabel } from "./analysis/PricingSections";

interface Props {
    index?: number;
    transitionName?: string;
    listing: ListingSummary;
    analysis?: AnalysisState;
    assessmentNote?: string;
    automaticDecision?: ReviewedDecision;
    reviewPending?: boolean;
    reviewActive?: boolean;
    selected: boolean;
    now: number;
    onOpen: () => void;
    onSnipe?: (draft: SniperDraft) => void;
    years: Record<string, number>;
    minGrade?: number;
    targets?: Targets;
    includeOffers: boolean;
    photoReviewState?: DeeperReviewState;
    saved?: boolean;
    saving?: boolean;
    onSave?: () => void;
}
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 2 });
const LISTED_DATE = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const signed = (value: number) => `${value < 0 ? "−" : "+"}${dollars(Math.abs(value))}`;
const dateOf = (value: string | null | undefined) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value) : null;

export function DealCard({ listing, analysis, assessmentNote, automaticDecision: receipt, reviewPending, reviewActive, selected, now, onOpen, onSnipe, years, index = 0, transitionName, minGrade = 0, targets = MONEY_CONFIG.targets, includeOffers, photoReviewState, saved, saving, onSave }: Props) {
    const assessed = analysis?.status === "done" ? withReleaseEvidence(analysis.evaluation) : null;
    const reviewed = receipt?.decision === "BUY" && assessed?.listing.id === listing.id
        ? applyVerifiedPurchase(assessed, receipt.verifiedPurchase, targets, now) : null;
    const evaluation = reviewed ?? assessed;
    const automaticDecision: ReviewedDecision | undefined = receipt?.decision === "BUY" && !reviewed
        ? { decision: "WAIT", reason: PURCHASE_RECHECK_MESSAGE } : receipt;
    const identityGap = evaluation !== null && !readyForPricing(evaluation.identity);
    const pricingExpired = analysis?.status === "done" && analysis.pricingExpired;
    const priceGap = priceEvidenceGap(evaluation);
    const shippingPending = evaluation?.underwriting?.shippingUnconfirmed;
    const shipping = evaluation ? evaluation.listing.shipping : listing.shipping;
    const deferred = Boolean(priceGap) || isResearchDeferred(evaluation);
    const photoStatus = photoReviewStatus(evaluation, listing);
    const priceReview = Boolean(priceGap && photoStatus.needsYourReview);
    const guidance = priceGap && evaluation && !pricingExpired && !priceReview ? rawBuyGuidance(evaluation, now, targets) : null;
    const slabGuidance = !pricingExpired ? slabBuyGuidance(evaluation, now) : null;
    const best = evaluation?.underwriting?.best;
    const rawPrice = best && rawPriceForPath(evaluation?.rawPricing, best);
    const assessedCondition = evaluation?.condition?.rawCondition;
    const lowerConditionSales = evaluation?.rawPricing?.conditionEvidence === "AI_PHOTOS" && isRawCondition(assessedCondition) &&
        rawPrice && isRawSoldPrice(rawPrice) && isRawCondition(rawPrice.condition) && conditionGap(assessedCondition, rawPrice.condition) > 0 ? rawPrice.comps : undefined;
    const verdict = evaluation?.underwriting?.verdict;
    const group = resultGroup(listing, evaluation, includeOffers);
    const deal = group === "deals" && Boolean(best);
    const override = automaticDecision && automaticDecision.decision !== "BUY" ? automaticDecision : null;
    const auction = listing.buyingOption === "AUCTION";
    const opportunity = auction ? automaticDecision?.auctionOpportunity : undefined;
    const sellerInventory = auction ? listing.auctionResearch : undefined;
    const checkedPrice = evaluation?.listing.price;
    const totalToBuy = !auction && checkedPrice != null && shipping != null && !shippingPending
        ? acquisitionCost(checkedPrice, shipping, MONEY_CONFIG.buying) : null;
    const currentQuote = opportunity && opportunity.validUntil > now ? opportunity : null;
    const bids = currentQuote ? evaluation?.listing.bids ?? listing.bids : listing.bids;
    const purchaseLabel = auction ? (bids === 0 ? "Opening price" : "Current bid") : (totalToBuy != null ? "Estimated total to buy" : "Asking price");
    const decision = auction && evaluation ? auctionDecision(evaluation, targets, now) : null;
    const screen = listing.screen;
    const comparison = !pricingExpired && currentBinComparison(listing, evaluation, now);
    const unresolved = analysis?.status === "held" || analysis?.status === "inconclusive";
    const pricePending = !evaluation && !unresolved && screen?.priceAnomaly && !screen.priceAnomaly.photoChecked;
    const offer = !reviewPending && !identityGap && !pricingExpired && group === "offers" && evaluation
        ? listingOffer(listing, evaluation, targets, now, automaticDecision) : null;
    const offerNumbers = offer ? numbersAtOffer(offer.path, offer.plan) : null;
    const evidence = evaluation ? photoEvidence(evaluation, minGrade) : null;
    const mistakes = currentSellerMistakes(listing, evaluation);
    const activity = resaleActivity(evaluation, now);
    const card = evaluation?.identity ?? screen?.card;
    const details = cardDetails(listing, evaluation);
    const slab = hasSlabEvidence(evaluation);
    const sellerCondition = evaluation?.condition ? claimedCondition(evaluation.listing.cardCondition) : null;
    const number = card?.cardNumber?.replace(/^0+(?=\d)/, "");
    const title = card?.name ? [card.name, number].filter(Boolean).join(" ") : listing.title;
    const showUnlimited = evaluation?.identity?.status === "IDENTIFIED" && evaluation.identity.hasEditions && !/\bunlimited\b/i.test(card?.set ?? "");
    const subtitle = card?.name ? [card.set, yearOf(years, card.set), card.printing !== "UNLIMITED" || showUnlimited ? card.printingLabel : null].filter(Boolean).join(" · ") : null;
    const unavailable = listing.availability === "UNAVAILABLE" || evaluation?.listing.availability === "UNAVAILABLE" ||
        Boolean(listing.endTime && Date.parse(listing.endTime) <= now) || decision?.ended;
    const checking = !automaticDecision && (reviewPending || analysis?.status === "loading");
    const showEconomics = !identityGap && !deferred && !pricingExpired && !override && !opportunity && !checking && !unavailable;
    const underwritingReason = evaluation?.underwriting && printingReviewReasons(evaluation, evaluation.underwriting.reasons)[0];
    function buyerDecision(): [badge: string, tone: string, reason: string] {
        if (unavailable) return ["Skip", "pass", "This listing is no longer available to buy."];
        const release = evaluation && (evaluation.identity?.notThisCard || releaseIssue(evaluation));
        if (release) return evaluation?.identity?.notThisCard ? ["Skip", "pass", release] : ["Wait", "watch", release];
        if (opportunity && opportunity.validUntil <= now) return ["Wait", "watch", "The auction check expired. A fresh bid quote and matching sales are needed to update the bid limit."];
        if (opportunity?.status === "BID") {
            const reason = opportunity.nextBid != null && opportunity.nextTotal != null && opportunity.profitAtNext != null && opportunity.route
                ? `If you win at the next bid of ${dollars(opportunity.nextBid)}, the total is ${dollars(opportunity.nextTotal)} with shipping and estimated tax. ${opportunity.route} projects ${dollars(opportunity.profitAtNext)} profit after costs.`
                : opportunity.reason;
            return [`Bid up to ${dollars(opportunity.maxBid)}`, "buy", reason];
        }
        if (override && !offer) return [override.decision === "SKIP" ? "Skip" : "Wait", override.decision === "SKIP" ? "pass" : "watch", override.reason];
        if (checking) return reviewActive || analysis?.status === "loading"
            ? ["Checking listing", "pending", "The app is checking this copy against your buying criteria."]
            : ["Queued for review", "pending", "This copy will be checked after the current listings finish."];
        if (pricingExpired) return ["Wait for fresh sales", "watch", "The saved prices are too old to support a purchase at today's asking price."];
        if (shippingPending) return ["Wait for shipping", "watch", "eBay did not quote shipping. The delivered cost could exceed the purchase limit."];
        if (evaluation && identityGap && verdict !== "PASS") {
            if (evaluation.identity?.notThisCard) return ["Skip", "pass", evaluation.identity.notThisCard];
            const concern = evaluation.deeperPhotoReview?.findings.find(finding => finding.impact === "NEW_CONCERN")?.observation;
            return ["Wait", "watch", concern ?? unconfirmedResale(evaluation, now)];
        }
        if (slabGuidance) return [slabGuidance.headline === "Wait at this price" ? slabGuidance.headline : "Wait", "watch",
            [slabGuidance.explanation, slabGuidance.caseNote].filter(Boolean).join(" ")];
        if (guidance) return [guidance.headline, guidance.decision === "PASS" ? "pass" : "watch", guidance.explanation];
        if (priceGap) return ["Wait for resale evidence", "watch", priceGap];
        if (decision?.status === "OVER_LIMIT") return ["Skip", "pass", `The current bid exceeds the ${dollars(decision.ceiling)} limit for your targets.`];
        if (decision?.status === "PROVISIONAL") return ["Wait", "watch", photoStatus.reasons[0] ?? "The photos do not support a firm bid limit for this copy."];
        if (deal && !deferred && best) {
            const badge = auction ? "Bid within limit" : evaluation?.rating?.level === "THIN" ? "Buy · thin margin" : best.path === "GRADE" ? "Buy + grade" : "Buy";
            const reason = automaticDecision?.reason ?? (auction ? `Bidding up to ${dollars(best.maxBid)} meets your resale targets.`
                : `${best.label} projects ${dollars(best.profit)} in net profit after costs.`);
            return [badge, best.path === "GRADE" ? "grade" : "buy", reason];
        }
        if (offer && offerNumbers) return ["Offer", "offer", automaticDecision?.reason ??
            `The seller accepts Best Offer. Paying the asking price would miss your resale targets.`];
        if (verdict === "PASS") return ["Skip", "pass", underwritingReason ?? "This copy falls short of your resale targets."];
        if (deferred) return ["Wait for resale evidence", "watch", underwritingReason ?? "The preliminary resale estimate does not establish a margin at this price."];
        if (evaluation) {
            const limit = verdict === "CANT_PRICE" ? underwritingReason ?? photoStatus.reasons[0] : photoStatus.reasons[0] ?? underwritingReason;
            return ["Wait", "watch", limit ?? "The available sales and listing evidence do not establish a resale margin for this copy."];
        }
        if (unresolved) return ["Wait", "watch", analysis.message];
        if (analysis?.status === "error") return ["Wait", "watch", "The listing check ended before the app could verify a purchase price against matching sales."];
        if (screen?.status === "DROPPED") return ["Skip at this price", "pass", screen.reason ?? "This listing falls short of your targets in preliminary screening."];
        if (pricePending) return ["Wait", "watch", "The unusually low asking price still needs support from the listing photos."];
        if (screen?.soldEvidence && screen.soldEvidence.status !== "AVAILABLE") return ["Wait for resale evidence", "watch", screen.soldEvidence.note];
        return ["Wait", "watch", screen?.reason ?? "This copy has no completed comparison between the listing and matching sales."];
    }
    const [badge, tone, reason] = buyerDecision();
    const seller = listing.seller;
    const sellerText = seller?.feedbackScore === 0 ? "New seller" : seller?.feedbackPercentage != null
        ? `${seller.feedbackPercentage}% · ${seller.feedbackScore == null ? "rating count unavailable" : `${seller.feedbackScore < 1000 ? seller.feedbackScore.toLocaleString() : COMPACT.format(seller.feedbackScore)} ratings`}` : "Not available";
    const ceiling = best?.maxBid ?? (!evaluation && !unresolved ? screen?.bestCase?.maxBid : null);
    const listedAt = dateOf(evaluation?.listing.listedAt) ?? dateOf(listing.listedAt);
    const listingDate = listedAt ?? dateOf(evaluation?.listing.createdAt) ?? dateOf(listing.createdAt);
    const outcome = auction && evaluation ? decision?.atCurrent : best;
    const shownCeiling = auction && evaluation ? decision?.ceiling : ceiling;
    return <article className={`${styles.card} ${selected ? styles.selected : ""}`} data-tone={tone}
        style={{ "--i": Math.min(index, 10), viewTransitionName: transitionName } as CSSProperties}>
        <div className={styles.overview}>
            <header className={styles.head}>
                <button type="button" className={styles.photo} onClick={onOpen} aria-label={`View photos and analysis of ${title}`}>
                    <ListingThumbnail images={[...listing.images, ...(evaluation?.listing.photos ?? [])]} alt={title} />
                </button>
                <div className={styles.identity}>
                    <div className={styles.metaRow}><span className={styles.saleType}>{auction ? "Auction" : "Buy It Now"}</span><span className={styles.badge}>{badge}</span></div>
                    <h2><button type="button" onClick={onOpen}>{title}</button></h2>
                    {subtitle && <p>{subtitle}</p>}
                    <p className={styles.details}><span>{details.source}: </span>{details.grade} · {details.finish}</p>
                    {evaluation && !slab && <RawCardGrade evaluation={evaluation} />}
                    {evaluation?.photoCheck && <p className={styles.evidenceStatus}>{photoStatus.checked} of {photoStatus.total} photos checked{slab && ` · ${name(photoStatus.confidence)} confidence`}</p>}
                </div>
            </header>
            <div className={styles.decision}>
                <div className={styles.money}>
                    <div><span className={styles.label}>{purchaseLabel}</span><strong className={styles.price}>{dollars(totalToBuy ?? currentQuote?.currentPrice ?? listing.currentPrice)}</strong></div>
                    {slabGuidance && !override && !opportunity && !checking && <div><span className={styles.label}>Estimated {slabGuidance.grade} market value</span><strong className={styles.price}>{dollars(slabGuidance.price)}</strong><span className={styles.label}>{slabGuidance.evidence}</span></div>}
                    {showEconomics && outcome && <div><span className={styles.label}>{shippingPending ? "Modeled" : "Est."} net {outcome.profit < 0 ? "loss" : "profit"} at {auction ? "current bid" : "asking"}</span><strong className={shippingPending ? styles.price : outcome.profit >= 0 ? styles.gain : styles.loss}>{dollars(Math.abs(outcome.profit))}</strong><span className={styles.label}>{returnText(outcome.cost > 0 ? outcome.profit / outcome.cost : null)} return on total cost</span></div>}
                    {showEconomics && shownCeiling != null && <div className={styles.limit}><span className={styles.label}>{shippingPending ? "Provisional max price" : auction ? "Max snipe bid" : best ? ceilingLabel(listing.buyingOption) : "Unverified screening ceiling"}: </span><strong>{dollars(shownCeiling)}</strong></div>}
                </div>
                {totalToBuy != null && checkedPrice != null && shipping != null ? <p className={styles.note}>
                    {dollars(checkedPrice)} item · {shipping === 0 ? "Free shipping" : dollars(shipping) + " shipping"} · {dollars(totalToBuy - checkedPrice - shipping)} estimated tax
                </p> : <p className={styles.note}>{auction ? `${timeLeft(currentQuote?.endsAt ?? listing.endTime, now) ?? "End time unavailable"} · ${bids} ${bids === 1 ? "bid" : "bids"} · ` : ""}{shipping === null ? !evaluation && screen?.soldEvidence
                    ? "Shipping not quoted · preliminary screening excludes shipping"
                    : `Shipping not quoted · ${dollars(MONEY_CONFIG.buying.assumedShippingWhenUnknown)} assumed in estimates` : shipping === 0 ? "Free shipping" : `${dollars(shipping)} shipping`}</p>}
                <MarketPrices prices={listingMarketPrices(evaluation, listing, now)} screen={!evaluation ? listing.screen : undefined}
                    loadAdditional={!checking} now={now} />
                {showEconomics && best?.path === "RAW" && rawPrice && !priceGap && <p className={styles.note}>
                    Resale {dollars(rawPrice.price)} · {tcgplayerEstimateLabel(rawPrice.basis) ?? (evaluation?.rawPricing?.source === "pkmnprices" ? "Matched eBay sales via PKMNPrices" : "Matched eBay sales")}
                </p>}
                {showEconomics && best && outcome && <p className={styles.note}>{best.label} · total invested {dollars(outcome.cost)} · includes tax, shipping{best.path === "GRADE" ? " and grading" : ""}. Sale fees are included in net profit.</p>}
                {comparison && !override && !checking && <p className={styles.note}>
                    <strong>Price lead · {comparison.discountPercent}% below both medians at search time</strong><br />
                    {dollars(comparison.delivered)} with shipping · {dollars(comparison.otherAskMedian)} median across {comparison.otherAskCount} other Buy It Now listings · {dollars(comparison.soldMedian)} median across {comparison.soldCount} recent sales.
                    {" "}{listing.isGraded ? "Same grader and grade." : comparison.condition ? `Seller-described ${CONDITION_NAMES[comparison.condition]} copies.` : "Raw copies with unspecified condition."}
                </p>}
                {showEconomics && deal && !shippingPending && lowerConditionSales && rawPrice && <p className={styles.note}>
                    Photos support {name(assessedCondition)}. The {dollars(rawPrice.price)} resale estimate uses {lowerConditionSales.count} photo-checked {name(rawPrice.condition)} {lowerConditionSales.count === 1 ? "sale" : "sales"}.
                </p>}
            </div>
            <div className={styles.actions}>
                <button type="button" className={styles.open} onClick={onOpen} aria-label={`Open ${title}, ${auction ? "Auction" : "Buy It Now"}, ${details.source}: ${details.grade}, ${details.finish}`}>View analysis <span aria-hidden="true">↗</span></button>
                <AuctionReminderButton listing={listing} analysis={showEconomics ? analysis : undefined} now={now} targets={targets} onSnipe={onSnipe} />
                {onSave && <button type="button" onClick={() => { if (!saving) onSave(); }} aria-disabled={saving} aria-pressed={saved} aria-label={saving ? `Saving… ${title}` : saved ? `Saved: remove ${title} from shortlist` : `Save ${title} to shortlist`}>{saving ? "Saving…" : saved ? <>Saved <span className={styles.savedMark} aria-hidden="true">✓</span></> : "Shortlist"}</button>}
            </div>
        </div>
        <div className={styles.notices}>
            <p className={styles.note}>{reason}</p>
            {!unavailable && offer && offerNumbers && <p className={styles.note}>Open at {dollars(offer.plan.offer)} · walk away above {dollars(offer.plan.walkAway)} · {offer.path.label} · est. profit {signed(offerNumbers.profit)} if accepted.</p>}
        </div>
        <details className={styles.support}>
            <summary>Evidence and costs <span>Photos · condition · recent sales</span></summary>
            <div className={styles.supportBody}>
                {assessmentNote && <p className={styles.note}>{assessmentNote}</p>}
                {guidance?.details.map(detail => <p key={detail} className={styles.note}>{detail}</p>)}
                <PhotoReview compact evaluation={evaluation} listing={listing} state={photoReviewState} assessment={analysis?.status === "done" ? undefined : analysis} />
                {!evaluation && screen?.soldEvidence && <SoldPriceScreening listing={listing} compact />}
                {!evaluation && !screen?.soldEvidence && screen?.status === "UNSCREENED" && <p className={styles.note}>{screen.pricingIssue?.kind === "RATE_LIMIT" ? "Pricing paused for provider cooldown." : screen.pricingIssue?.kind === "TEMPORARY" ? "Price lookup temporarily unavailable." : screen.pricingIssue?.kind === "CREDITS" ? "Pricing unavailable. Check provider credits." : screen.pricingIssue?.kind === "CONFIG" ? "Pricing unavailable. Check provider setup." : screen.reason}</p>}
                {auction && evaluation && showEconomics && <AuctionSummary evaluation={evaluation} targets={targets} now={now} />}
                {offer && <SellerOfferDraft key={offer.plan.offer} cardName={card?.name} plan={offer.plan} />}
                {mistakes[0] && <p className={styles.note}>{mistakes[0].detail}</p>}
                {!priceGap && rawPrice && !(showEconomics && best?.path === "RAW") && <p className={styles.note}>Estimated resale {dollars(rawPrice.price)} · {name(rawPrice.condition)} · {tcgplayerEstimateLabel(rawPrice.basis) ?? soldEstimateBasis(rawPrice.comps)}.</p>}
                {best?.path === "GRADED_RESALE" && evaluation?.slabPricing?.activeReference && !evaluation.slabPricing.summary?.count && <p className={styles.note}>Resale target {dollars(best.salePrice)} · below photo-checked Buy It Now competition.</p>}
                {!slab && sellerCondition && sellerCondition !== evaluation?.condition?.rawCondition && <p className={styles.note}>Seller described this card as {CONDITION_NAMES[sellerCondition]}.</p>}
                {!slab && minGrade > 0 && evidence && <p className={styles.note}>{evidence.target}</p>}
                <dl className={styles.facts}>
                    <div><dt>Seller</dt><dd>{sellerText}</dd></div>
                    {sellerInventory && <div><dt>Seller inventory sample</dt><dd>{sellerInventory.cardListings.toLocaleString()} trading card {sellerInventory.cardListings === 1 ? "single" : "singles"} · {sellerInventory.otherListings.toLocaleString()} {sellerInventory.otherListings === 1 ? "listing" : "listings"} in {sellerInventory.categories.slice(1).join(" and ") || "other sampled categories"}</dd></div>}
                    <div><dt>Listing date</dt><dd>{listingDate ? <>{listedAt ? "Listed" : "Created"} <time dateTime={listingDate.toISOString()} title={listingDate.toUTCString()}>{LISTED_DATE.format(listingDate)}</time></> : "Listed time unavailable"}</dd></div>
                </dl>
                {evaluation && <p className={styles.note} title={activity.detail}>{activity.label}{activity.recentSales !== null && (activity.scope === "MATCHED"
                    ? ` · ${activity.recentSales} matching sold comps / ${SALES_ACTIVITY_DAYS} days`
                    : ` · ${activity.recentSales} sales across ${evaluation.marketActivity?.scope === "RAW" ? "raw conditions" : "all grades"} / 30 days`)}</p>}
            </div>
        </details>
    </article>;
}

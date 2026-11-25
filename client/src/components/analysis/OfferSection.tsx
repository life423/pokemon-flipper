import { useState } from "react";
import type { Evaluation, ListingSummary, Targets } from "../../types";
import { dollars, percent } from "../../format";
import { describeOffer, numbersAtOffer, offerFor, type OfferPlan } from "../../../../shared/money/offer.ts";
import type { BuyerListingReview } from "../../../../shared/wait-skip-review.ts";
import { applyVerifiedPurchase } from "../../../../shared/money/verified-purchase.ts";
import { retargetEvaluation } from "../../../../shared/money/targets.ts";
import { resultGroup } from "../../../../shared/analysis.ts";
import { Pairs, Section } from "./primitives";
import styles from "../DetailPanel.module.css";

export function SellerOfferDraft({ cardName, plan }: { cardName?: string | null; plan: OfferPlan }) {
    const [status, setStatus] = useState("");
    const card = cardName?.trim().slice(0, 100) || "card";
    const note = `Hi! I'm interested in your ${card}. Would you consider ${dollars(plan.offer)} for the card through eBay Best Offer? Thanks for considering it.`;

    async function copy() {
        try {
            await navigator.clipboard.writeText(note);
            setStatus("Draft copied.");
        } catch {
            setStatus("Select and copy the draft text.");
        }
    }

    return (
        <div className={styles.offerDraft}>
            <div className={styles.noteActions}>
                <strong>Draft for the seller</strong>
                <button type="button" className={styles.secondary} onClick={() => void copy()} aria-label="Copy offer draft">Copy</button>
            </div>
            <p>{note}</p>
            {status && <p className={styles.small} role="status">{status}</p>}
        </div>
    );
}

export type ReviewedDecision = Pick<BuyerListingReview, "decision" | "reason" | "offer" | "auctionOpportunity" | "verifiedPurchase">;

export function listingOffer(listing: ListingSummary, evaluation: Evaluation, targets: Targets, now: number, review?: ReviewedDecision) {
    const best = evaluation.underwriting?.best;
    const plan = offerFor(listing, best?.maxBid);
    if (!best || !plan) return null;
    if (!review || review.decision === "BUY") return { plan, path: best };
    const offer = review.offer;
    if (review.decision !== "WAIT" || !offer || plan.clearsAtAsking || plan.requiresPriceDrop ||
        evaluation.listing.id !== listing.id || evaluation.listing.bestOffer !== true || evaluation.listing.price !== listing.currentPrice ||
        offer.opening !== plan.offer || !Number.isFinite(offer.maxItemPrice) ||
        offer.maxItemPrice < offer.opening || offer.maxItemPrice > plan.walkAway) return null;
    const current = retargetEvaluation(evaluation, targets, listing);
    const opening = retargetEvaluation({ ...current, listing: { ...current.listing, price: offer.opening } }, targets);
    const path = applyVerifiedPurchase(opening, offer.verifiedPurchase, targets, now)?.underwriting?.best;
    return path?.maxBid === offer.maxItemPrice ? { plan: { ...plan, walkAway: path.maxBid }, path } : null;
}

export function OfferSection({ listing, evaluation, targets, now, automaticDecision }: {
    listing: ListingSummary; evaluation: Evaluation; targets: Targets; now: number; automaticDecision?: ReviewedDecision;
}) {
    const group = resultGroup(listing, evaluation, true);
    if ((group !== "offers" && group !== "deals") || listing.currentPrice === null) return null;
    const offer = listingOffer(listing, evaluation, targets, now, automaticDecision);
    if (!offer) return null;
    const { plan, path } = offer;
    const outcome = numbersAtOffer(path, plan);

    return (
        <Section title="Best Offer">
            <Pairs rows={[
                ["Opening offer", <strong>{dollars(plan.offer)}</strong>],
                ["Your walk-away price", dollars(plan.walkAway)],
                ["Resale plan", path.label],
                ["Est. profit if accepted", `${dollars(outcome.profit)} (${percent(outcome.roi)} return)`],
            ]} />
            <p className={styles.small}>{describeOffer(plan, listing.currentPrice)}</p>
            <SellerOfferDraft key={plan.offer} cardName={evaluation.identity?.name} plan={plan} />
        </Section>
    );
}

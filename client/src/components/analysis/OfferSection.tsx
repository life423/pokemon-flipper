import { useState } from "react";
import type { Evaluation, ListingSummary } from "../../types";
import { dollars, percent } from "../../format";
import { describeOffer, numbersAtOffer, offerFor, type OfferPlan } from "../../../../shared/money/offer.ts";
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

export function OfferSection({ listing, evaluation }: { listing: ListingSummary; evaluation: Evaluation }) {
    const group = resultGroup(listing, evaluation, true);
    if ((group !== "offers" && group !== "deals") || listing.currentPrice === null) return null;
    const best = evaluation.underwriting?.best;
    const plan = offerFor(listing, best?.maxBid);
    if (!best || !plan) return null;
    const outcome = numbersAtOffer(best, plan);

    return (
        <Section title="Best Offer">
            <Pairs rows={[
                ["Opening offer", <strong>{dollars(plan.offer)}</strong>],
                ["Your walk-away price", dollars(plan.walkAway)],
                ["Est. profit if accepted", `${dollars(outcome.profit)} (${percent(outcome.roi)} return)`],
            ]} />
            <p className={styles.small}>{describeOffer(plan, listing.currentPrice)}</p>
            <SellerOfferDraft key={plan.offer} cardName={evaluation.identity?.name} plan={plan} />
        </Section>
    );
}

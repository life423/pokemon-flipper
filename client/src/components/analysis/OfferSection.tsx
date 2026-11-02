import { useState, type ReactNode } from "react";
import type { Evaluation, ListingSummary } from "../../types";
import { dollars, percent } from "../../format";
import { describeOffer, numbersAtOffer, offerFor } from "../../../../shared/money/offer.ts";
import { writeOfferNote } from "../../api";
import { Pairs, Section } from "./primitives";
import styles from "../DetailPanel.module.css";

export function OfferSection({ listing, evaluation }: { listing: ListingSummary; evaluation: Evaluation }) {
    const plan = offerFor(listing, evaluation.underwriting?.best?.maxBid);
    const [note, setNote] = useState<string | null>(null);
    const [writing, setWriting] = useState(false);
    const [copied, setCopied] = useState(false);

    if (!plan || listing.currentPrice === null) return null;
    const best = evaluation.underwriting?.best;
    const offerNumbers = best ? numbersAtOffer(best, plan) : null;

    async function write() {
        setWriting(true);
        setCopied(false);

        try {
            setNote(await writeOfferNote(listing.title));
        } catch {
            setNote("Couldn't write a note just now. Try again in a moment.");
        } finally {
            setWriting(false);
        }
    }

    async function copy() {
        if (!note) return;
        await navigator.clipboard.writeText(note);
        setCopied(true);
    }

    return (
        <Section title="Best offer">
            <Pairs
                rows={[
                    [plan.longShot ? "Wait for price at or below" : "Suggested offer (not submitted)", <strong>{dollars(plan.longShot ? plan.walkAway : plan.offer)}</strong>],
                    ["Walk away above", dollars(plan.walkAway)],
                    ...(!plan.longShot && offerNumbers ? [["Est. profit if accepted", `${dollars(offerNumbers.profit)} (${percent(offerNumbers.roi)} return)`] as [string, ReactNode]] : []),
                ]}
            />
            <p className={styles.small}>{describeOffer(plan, listing.currentPrice)}</p>

            <p className={styles.small}>Notes are drafts only. Nothing is sent and no offer is submitted by this app.</p>
            {!plan.longShot && <div className={styles.noteActions}>
                <button type="button" className={styles.secondary} onClick={write} disabled={writing}>
                    {writing ? "Writing..." : note ? "Write another note" : "Write a note for the seller"}
                </button>
                {note && (
                    <button type="button" className={styles.secondary} onClick={copy}>
                        {copied ? "Copied" : "Copy"}
                    </button>
                )}
            </div>}
            {note && <p className={styles.note}>{note}</p>}
        </Section>
    );
}

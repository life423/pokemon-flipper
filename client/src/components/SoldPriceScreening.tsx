import type { ListingSummary } from "../types";
import { name } from "../format";
import { Section } from "./analysis/primitives";
import { CompsRow } from "./analysis/PricingSections";
import styles from "./DetailPanel.module.css";

export function SoldPriceScreening({ listing, compact = false }: { listing: ListingSummary; compact?: boolean }) {
    const screen = listing.screen;
    const evidence = screen?.soldEvidence;
    if (!evidence) return null;
    if (compact) return <div className={styles.small}>
        <strong>{screen?.gradingLead ? "Grading candidate" : evidence.status === "AVAILABLE" ? "Sold prices checked" : "Sold-price evidence limited"}</strong>
        <p>{screen?.reason ?? evidence.note}</p>
    </div>;
    return <Section title="Sold-price screening">
        {screen?.reason && <p>{screen.reason}</p>}
        <p className={styles.small}>{evidence.note}</p>
        {screen?.assumed && <p className={styles.small}>{screen.assumed}</p>}
        {[...evidence.references, ...(evidence.gradingReferences ?? [])].map(reference => <div key={JSON.stringify([reference.recordId, reference.printing, reference.finish, reference.grader, reference.grade, reference.condition])}>
            <h4 className={styles.subTitle}>{reference.name} {reference.cardNumber} · {reference.set} · {name(reference.printing)} · {name(reference.finish)}</h4>
            {!reference.grader && <p className={styles.small}>{reference.condition
                ? "Condition is stated in sold titles; this card's condition is not yet assessed."
                : "Sold condition is unspecified. This is market context, not a condition-matched raw valuation."}</p>}
            <CompsRow summary={reference.summary} sampleLimit={20} screening />
        </div>)}
    </Section>;
}

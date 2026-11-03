import type { ReactNode } from "react";
import type { Condition, Evaluation, Identity, ListingSummary, PhotoCheck, Slab, SlabPricing } from "../../types";
import { describeRange, dollars, name, percent } from "../../format";
import { CONDITION_AREAS, RAW_CONDITIONS, CONDITION_NAMES, CONDITION_DEFINITIONS } from "../../../../shared/conditions.ts";
import { ceilingLabel } from "../../../../shared/format.ts";
import { listingSignals } from "../../../../shared/signals.ts";
import { CompsRow } from "./PricingSections";
import { Notes, Pairs, Section } from "./primitives";
import styles from "../DetailPanel.module.css";

export function ListingEvidenceSection({ listing, evaluation }: { listing: ListingSummary; evaluation: Evaluation }) {
    const signals = listingSignals(listing, evaluation);

    if (signals.length === 0) return null;

    return (
        <Section title="Listing evidence">
            {([['OPPORTUNITY', 'Listing clues'], ['CAUTION', 'Checks and risks'], ['CONTEXT', 'Discovery and auction context']] as const).map(([kind, title]) => {
                const items = signals.filter((signal) => signal.kind === kind);
                return items.length ? <div key={kind}><h4>{title}</h4><ul className={styles.notes}>{items.map((signal) => <li key={signal.id}><strong>{signal.label}.</strong> {signal.detail}</li>)}</ul></div> : null;
            })}
        </Section>
    );
}

export function ListingSection({ listing, evaluation }: { listing: ListingSummary; evaluation: Evaluation }) {
    const seller = evaluation.listing.seller ?? listing.seller;
    const condition = evaluation.listing.cardCondition ?? listing.cardCondition ?? null;
    const notes = evaluation.listing.conditionNotes ?? listing.conditionNotes ?? [];
    const screen = listing.screen;
    const rows: [string, ReactNode][] = [];

    if (seller) {
        rows.push([
            "Seller",
            `${seller.username ?? "Unknown"}, ${seller.feedbackScore ?? "?"} feedback at ${seller.feedbackPercentage ?? "?"}%`,
        ]);
    }
    if (condition) {
        rows.push(["Seller's condition", condition]);
    }
    if (screen?.filledFromTitle?.length) {
        rows.push(["Read from the title", screen.filledFromTitle.join(", ").toLowerCase()]);
    }
    if (screen?.bestCase) {
        rows.push([
            "Preliminary screening estimate",
            `${dollars(screen.bestCase.maxBid)} ${ceilingLabel(listing.buyingOption).toLowerCase()} (${screen.assumed})`,
        ]);
    }

    if (rows.length === 0) return null;

    return (
        <Section title="Listing">
            <Pairs rows={rows} />
            <Notes items={notes} tone="muted" />
        </Section>
    );
}

export function IdentitySection({ identity, isSlab }: { identity: Identity; isSlab: boolean }) {
    const evidence = identity.evidence;

    return (
        <Section title="Card">
            <Pairs
                rows={[
                    ["Status", identity.status === "IDENTIFIED" ? "Identified" : "Needs review"],
                    ["Card", identity.name ?? "\u2014"],
                    ["Set", identity.set ?? "\u2014"],
                    ["Number", identity.cardNumber ?? "\u2014"],
                    ["Printing", identity.printingLabel ?? name(identity.printing)],
                    ["Finish", name(identity.finish)],
                    ["Language", identity.language],
                ]}
            />

            {evidence && (
                <>
                    <h4 className={styles.subTitle}>Printing evidence</h4>
                    <Pairs
                        rows={[
                            ["Title", name(evidence.title)],
                            ["Item details", name(evidence.itemSpecifics)],
                            ...(isSlab ? ([["Slab label", name(evidence.label)]] as [string, ReactNode][]) : []),
                            [`From the ${evidence.photoSource ?? "photos"}`, name(evidence.photo)],
                        ]}
                    />
                    <Notes items={evidence.photoNotes} tone="muted" />
                </>
            )}

            <Notes items={identity.reasons} tone="bad" />
        </Section>
    );
}

export function SlabSection({ slab, pricing }: { slab: Slab; pricing: SlabPricing | null }) {
    const grade = slab.grade ? `${slab.grade}${slab.gradeQualifier ? ` (${slab.gradeQualifier})` : ""}` : "Unreadable";

    return (
        <Section title="Slab">
            <Pairs
                rows={[
                    ["Status", slab.status === "OK" ? "Checks out" : name(slab.status)],
                    ["Grader", slab.grader ?? "Unreadable"],
                    ["Grade", grade],
                    [
                        "Cert",
                        slab.certUrl ? (
                            <a href={slab.certUrl} target="_blank" rel="noopener noreferrer">
                                {slab.certNumber}
                            </a>
                        ) : (
                            slab.certNumber ?? "Unreadable"
                        ),
                    ],
                    ["Case", name(slab.caseCondition)],
                    ["Label", slab.labelText ?? "\u2014"],
                ]}
            />
            <Notes items={slab.reasons} tone="bad" />
            <Notes items={slab.concerns} tone="muted" />
            {pricing?.summary && <CompsRow summary={pricing.summary} />}
            {pricing?.activeReference && <div>
                <p><strong>Current Buy It Now competition</strong></p>
                <p>Resale target {dollars(pricing.activeReference.resalePrice)} · {percent(pricing.activeReference.discountRate)} below the cheapest matching item plus shipping ({dollars(pricing.activeReference.lowestTotal)}).</p>
                <p className={styles.small}>Slab photos and labels checked · sellers have 100+ feedback and at least 98.5% positive.</p>
                <ul>{pricing.activeReference.listings.map(comp => <li key={comp.id}><a className={styles.listingLink} href={comp.url} target="_blank" rel="noopener noreferrer">{comp.title}</a><p>{dollars(comp.total)} including shipping · {comp.seller.username} · {comp.seller.feedbackPercentage}% positive</p></li>)}</ul>
            </div>}
            {pricing && pricing.status !== "PRICED" && <p className={styles.muted}>{pricing.reason}</p>}
        </Section>
    );
}

export function ConditionSection({ evaluation, condition }: { evaluation: Evaluation; condition: Condition }) {
    const areas = CONDITION_AREAS;

    return (
        <Section title="Condition">
            <p>Seller says: {evaluation.listing.cardCondition ?? "Not stated"} · AI assesses: <strong>{name(condition.rawCondition)}</strong></p>
            <details className={styles.details}><summary>Our six condition definitions</summary><dl>{RAW_CONDITIONS.map(key => <div key={key}><dt><strong>{CONDITION_NAMES[key]}</strong></dt><dd>{CONDITION_DEFINITIONS[key]}</dd></div>)}</dl></details>
            <Pairs
                rows={[
                    ["Grade range", condition.gradeRange ? `${describeRange(condition.gradeRange)} (${name(condition.confidence)} confidence)` : "Not supported by the photos"],
                    ["Raw condition", name(condition.rawCondition)],
                    ["Seller says", evaluation.listing.cardCondition ?? "Not stated"],
                    ["Creases", name(condition.creases)],
                    ["Authenticity", name(condition.authenticity.concern)],
                ]}
            />
            <Notes items={condition.authenticity.reasons} tone="bad" />

            <table className={styles.table}>
                <thead>
                    <tr>
                        <th>Area</th>
                        <th>Visible</th>
                        <th>Severity</th>
                    </tr>
                </thead>
                <tbody>
                    {areas.map((area) => (
                        <tr key={area}>
                            <td>{name(area)}</td>
                            <td>{name(condition[area].visibility)}</td>
                            <td>{name(condition[area].severity)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>

            {areas.map((area) =>
                condition[area].observations.length > 0 ? (
                    <details key={area} className={styles.details}>
                        <summary>{name(area)}: what the photos show</summary>
                        <Notes items={condition[area].observations} />
                    </details>
                ) : null
            )}

            <p className={styles.summary}>{condition.summary}</p>
            <Notes items={condition.limitations} tone="muted" />

            {evaluation.setAside.map((answer, index) => (
                <p key={index} className={styles.small}>
                    Second look, set aside as less cautious: {describeRange(answer.gradeRange)},{" "}
                    {name(answer.rawCondition)}.
                </p>
            ))}
        </Section>
    );
}

export function PhotosSection({ evaluation, photoCheck }: { evaluation: Evaluation; photoCheck: PhotoCheck }) {
    return (
        <Section title="Photos">
            <Pairs
                rows={[
                    ["Grading mode", name(evaluation.gradingMode)],
                    ["Photo check", `${name(photoCheck.photoSufficiency)}, ${name(photoCheck.confidence)} confidence`],
                    ["Cards shown", name(photoCheck.cardCount)],
                    ["Holder", name(photoCheck.holder)],
                    ["Analyzed", `${evaluation.listing.photosAnalyzed} of ${evaluation.listing.photosInListing}`],
                ]}
            />
            <Notes items={evaluation.modeReasons} tone="muted" />

            <ul className={styles.notes}>
                {photoCheck.images.map((photo) => (
                    <li key={photo.number}>
                        Photo {photo.number}: {name(photo.view)}, {photo.usable ? "usable" : "not usable"}
                        {photo.isStockImage ? ", stock image" : ""}
                        {photo.issues.length > 0 && <span className={styles.muted}> ({photo.issues.join("; ")})</span>}
                    </li>
                ))}
            </ul>

            {photoCheck.missingViews.length > 0 && (
                <>
                    <h4 className={styles.subTitle}>Additional photos requested by AI</h4>
                    <Notes items={photoCheck.missingViews} tone="muted" />
                </>
            )}
        </Section>
    );
}

import { useEffect, type ReactNode } from "react";
import type { AnalysisState } from "../App";
import type {
    CompSummary,
    Condition,
    Evaluation,
    GradedPricing,
    Identity,
    ListingSummary,
    MoneyPath,
    PhotoCheck,
    RawPricing,
    Slab,
    SlabPricing,
    Underwriting,
} from "../types";
import { describeRange, dollars, name, percent, timeLeft } from "../format";
import { useNow } from "../useNow";
import { CONDITION_AREAS } from "../../../shared/conditions.ts";
import { RatingBadge, VerdictBadge } from "./VerdictBadge";
import styles from "./DetailPanel.module.css";

interface Props {
    listing: ListingSummary;
    analysis?: AnalysisState;
    now: number;
    onClose: () => void;
    onAnalyze: (fresh: boolean) => void;
}

export function DetailPanel({ listing, analysis, now, onClose, onAnalyze }: Props) {
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };

        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    return (
        <>
            <div className={styles.backdrop} onClick={onClose} />

            <aside className={styles.panel} aria-label="Listing analysis">
                <header className={styles.head}>
                    <h2 className={styles.title}>{listing.title}</h2>
                    <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
                        &times;
                    </button>
                </header>

                <div className={styles.photos}>
                    {listing.images.map((src, index) => (
                        <img key={src} src={src} alt={`Listing photo ${index + 1}`} loading="lazy" />
                    ))}
                </div>

                <p className={styles.small}>
                    <a href={listing.url} target="_blank" rel="noopener noreferrer">
                        Open the listing on eBay
                    </a>
                </p>

                {!analysis && (
                    <div className={styles.cta}>
                        <p>
                            Checks the photos, identifies the exact card and printing, and prices every
                            path. About 20 seconds the first time.
                        </p>
                        <button type="button" className={styles.primary} onClick={() => onAnalyze(false)}>
                            Analyze
                        </button>
                    </div>
                )}

                {analysis?.status === "loading" && <Loading startedAt={analysis.startedAt} />}

                {analysis?.status === "error" && (
                    <div className={styles.cta}>
                        <p className={styles.bad}>The analysis failed: {analysis.message}</p>
                        <button type="button" className={styles.primary} onClick={() => onAnalyze(false)}>
                            Try again
                        </button>
                    </div>
                )}

                {analysis?.status === "done" && (
                    <Analysis
                        listing={listing}
                        evaluation={analysis.evaluation}
                        now={now}
                        onReanalyze={() => onAnalyze(true)}
                    />
                )}
            </aside>
        </>
    );
}

function Loading({ startedAt }: { startedAt: number }) {
    const now = useNow(1000);
    const seconds = Math.max(0, Math.round((now - startedAt) / 1000));

    return (
        <p className={styles.loading} aria-live="polite">
            Checking photos, identifying the printing, and pulling sold comps... {seconds}s
        </p>
    );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{title}</h3>
            {children}
        </section>
    );
}

function Pairs({ rows }: { rows: [string, ReactNode][] }) {
    return (
        <dl className={styles.pairs}>
            {rows.map(([key, value]) => (
                <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                </div>
            ))}
        </dl>
    );
}

function Notes({ items, tone }: { items: string[]; tone?: "good" | "bad" | "muted" }) {
    if (items.length === 0) return null;

    return (
        <ul className={`${styles.notes} ${tone ? styles[tone] : ""}`}>
            {items.map((item) => (
                <li key={item}>{item}</li>
            ))}
        </ul>
    );
}

function Analysis({
    listing,
    evaluation,
    now,
    onReanalyze,
}: {
    listing: ListingSummary;
    evaluation: Evaluation;
    now: number;
    onReanalyze: () => void;
}) {
    const tokens = evaluation.usage.reduce(
        (total, step) => total + (step.inputTokens ?? 0) + (step.outputTokens ?? 0),
        0
    );

    return (
        <>
            {evaluation.underwriting && (
                <VerdictSection underwriting={evaluation.underwriting} evaluation={evaluation} now={now} />
            )}

            {evaluation.underwriting && evaluation.underwriting.paths.length > 0 && (
                <Section title="Every path">
                    <div className={styles.paths}>
                        {evaluation.underwriting.paths.map((path) => (
                            <PathCard key={path.label} path={path} />
                        ))}
                    </div>
                </Section>
            )}

            <ListingSection listing={listing} evaluation={evaluation} />
            {evaluation.identity && <IdentitySection identity={evaluation.identity} isSlab={Boolean(evaluation.slab)} />}
            {evaluation.slab && <SlabSection slab={evaluation.slab} pricing={evaluation.slabPricing} />}
            {evaluation.condition && <ConditionSection evaluation={evaluation} condition={evaluation.condition} />}

            {(evaluation.rawPricing || evaluation.gradedPricing) && (
                <PricesSection raw={evaluation.rawPricing} graded={evaluation.gradedPricing} />
            )}

            {evaluation.photoCheck && <PhotosSection evaluation={evaluation} photoCheck={evaluation.photoCheck} />}

            <footer className={styles.footer}>
                <p className={styles.small}>
                    {evaluation.answeredAt && `Analyzed ${new Date(evaluation.answeredAt).toLocaleString()}. `}
                    {evaluation.usage.length > 0
                        ? `This run used ${tokens.toLocaleString()} tokens.`
                        : "Reused the saved answer: no AI calls this time."}
                </p>
                <button type="button" className={styles.secondary} onClick={onReanalyze}>
                    Analyze again (paid)
                </button>
            </footer>
        </>
    );
}

function VerdictSection({
    underwriting,
    evaluation,
    now,
}: {
    underwriting: Underwriting;
    evaluation: Evaluation;
    now: number;
}) {
    const { listing } = evaluation;
    const best = underwriting.best;
    const left = timeLeft(listing.endTime, now);
    const room = best?.maxBid !== undefined && listing.price !== null ? best.maxBid - listing.price : null;

    const rows: [string, ReactNode][] = [
        [listing.buyingOption === "AUCTION" ? `Current bid (${listing.bids} bids)` : "Buy It Now", dollars(listing.price)],
        ["Shipping", listing.shipping === null ? "Not quoted" : dollars(listing.shipping)],
    ];

    if (room !== null) {
        rows.push(["Room to bid", <span className={room >= 0 ? styles.good : styles.bad}>{dollars(room)}</span>]);
    }
    if (best && underwriting.verdict.startsWith("BUY")) {
        // An auction's bid will rise, so its profit is shown at the max bid.
        const auction = listing.buyingOption === "AUCTION";
        const profit = auction ? best.profitAtMaxBid : best.profit;
        const roi = auction ? best.roiAtMaxBid : best.roi;

        rows.push([
            auction ? "Profit at max bid" : "Profit at this price",
            <span className={styles.good}>
                {dollars(profit)} ({percent(roi)} return)
            </span>,
        ]);
    }
    if (left) {
        rows.push(["Ends in", left]);
    }

    return (
        <section className={styles.verdict}>
            <div className={styles.badges}>
                {evaluation.rating && <RatingBadge level={evaluation.rating.level} large />}
                <VerdictBadge verdict={underwriting.verdict} large />
            </div>

            {best?.maxBid !== undefined && (
                <div className={styles.hero}>
                    <span className={styles.heroLabel}>Max bid</span>
                    <span className={`${styles.heroValue} ${room !== null && room >= 0 ? styles.good : ""}`}>
                        {dollars(best.maxBid)}
                    </span>
                    <span className={styles.heroLabel}>{best.label}</span>
                </div>
            )}

            <Pairs rows={rows} />
            {evaluation.rating && (
                <>
                    <Notes items={evaluation.rating.strengths} tone="good" />
                    <Notes items={evaluation.rating.concerns} tone="bad" />
                    <Notes items={evaluation.rating.notes} tone="muted" />
                </>
            )}
            <Notes items={underwriting.reasons} />
            <Notes items={underwriting.assumptions} tone="muted" />
        </section>
    );
}

function PathCard({ path }: { path: MoneyPath }) {
    if (path.status !== "PRICED") {
        return (
            <div className={styles.path}>
                <h4>{path.label}</h4>
                <p className={styles.muted}>Can't price: {path.reason}</p>
            </div>
        );
    }

    const sale: [string, ReactNode][] =
        path.path === "GRADE"
            ? [
                  ["Service level", `${path.tier} (${dollars(path.gradingFee)})`],
                  ["Expected sale", dollars(path.expectedSale)],
              ]
            : [["Sells for", `${dollars(path.salePrice)}${path.priceCondition ? ` (${name(path.priceCondition)})` : ""}`]];

    return (
        <div className={`${styles.path} ${path.clears ? styles.clears : ""}`}>
            <div className={styles.pathHead}>
                <h4>{path.label}</h4>
                {path.clears && <span className={styles.clearsTag}>Clears your targets</span>}
            </div>

            <Pairs
                rows={[
                    ...sale,
                    ["You keep", dollars(path.expectedNet)],
                    ["All-in cost", dollars(path.cost)],
                    [
                        "Profit",
                        <span className={(path.profit ?? 0) >= 0 ? styles.good : styles.bad}>
                            {dollars(path.profit)} ({percent(path.roi)})
                        </span>,
                    ],
                    ["Worst case", dollars(path.downside)],
                    ["Profit at max bid", `${dollars(path.profitAtMaxBid)} (${percent(path.roiAtMaxBid)})`],
                    ["Max bid", <strong>{dollars(path.maxBid)}</strong>],
                ]}
            />

            {path.outlook && (
                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th>Grade</th>
                            <th>Chance</th>
                            <th>Sells for</th>
                        </tr>
                    </thead>
                    <tbody>
                        {path.outlook.map((outlook) => (
                            <tr key={outlook.grade}>
                                <td>
                                    {path.grader} {outlook.grade}
                                </td>
                                <td>{percent(outlook.probability)}</td>
                                <td>
                                    {dollars(outlook.price)}
                                    {outlook.filledFrom !== null && (
                                        <span className={styles.muted}> (from {outlook.filledFrom})</span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}

function ListingSection({ listing, evaluation }: { listing: ListingSummary; evaluation: Evaluation }) {
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
        rows.push(["Free check, at best", `${dollars(screen.bestCase.maxBid)} max bid (${screen.assumed})`]);
    }

    if (rows.length === 0) return null;

    return (
        <Section title="Listing">
            <Pairs rows={rows} />
            <Notes items={notes} tone="muted" />
        </Section>
    );
}

function IdentitySection({ identity, isSlab }: { identity: Identity; isSlab: boolean }) {
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

function SlabSection({ slab, pricing }: { slab: Slab; pricing: SlabPricing | null }) {
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
            {pricing && pricing.status !== "PRICED" && <p className={styles.muted}>{pricing.reason}</p>}
        </Section>
    );
}

function ConditionSection({ evaluation, condition }: { evaluation: Evaluation; condition: Condition }) {
    const areas = CONDITION_AREAS;

    return (
        <Section title="Condition">
            <Pairs
                rows={[
                    ["Grade range", `${describeRange(condition.gradeRange)} (${name(condition.confidence)} confidence)`],
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

function CompsRow({ summary }: { summary: CompSummary }) {
    const dropped = Object.entries(summary.dropped);

    return (
        <details className={styles.details}>
            <summary>
                <span>
                    {summary.grader} {summary.grade}
                </span>
                <span className={styles.compStats}>
                    {summary.count > 0
                        ? `${summary.count} sales, median ${dollars(summary.median)}, ${name(summary.confidence)}`
                        : "No verified sales"}
                </span>
            </summary>

            {summary.count > 0 && (
                <p className={styles.small}>
                    Range {dollars(summary.low)} to {dollars(summary.high)}. Newest sale {summary.newestSale}.
                </p>
            )}

            {dropped.length > 0 && (
                <p className={styles.small}>
                    Dropped: {dropped.map(([reason, count]) => `${count} ${reason}`).join(", ")}.
                </p>
            )}

            <ul className={styles.sales}>
                {summary.sales.map((sale, index) => (
                    <li key={`${sale.soldAt}-${index}`}>
                        <span className={styles.salePrice}>{dollars(sale.price)}</span>
                        <span className={styles.muted}>{sale.soldAt}</span>
                        {sale.url ? (
                            <a href={sale.url} target="_blank" rel="noopener noreferrer">
                                {sale.title}
                            </a>
                        ) : (
                            <span>{sale.title}</span>
                        )}
                    </li>
                ))}
            </ul>
        </details>
    );
}

function PricesSection({
    raw,
    graded,
}: {
    raw: RawPricing | null;
    graded: Record<string, GradedPricing> | null;
}) {
    return (
        <Section title="Prices">
            {raw && (
                <>
                    <h4 className={styles.subTitle}>Raw{raw.printingLabel ? `, ${raw.printingLabel}` : ""}</h4>
                    {raw.status === "PRICED" ? (
                        <Pairs rows={(raw.prices ?? []).map((price) => [name(price.condition), dollars(price.price)])} />
                    ) : (
                        <p className={styles.muted}>{raw.reason}</p>
                    )}
                </>
            )}

            {Object.entries(graded ?? {}).map(([grader, pricing]) => (
                <div key={grader}>
                    <h4 className={styles.subTitle}>
                        {grader} sold comps{pricing.printingLabel ? `, ${pricing.printingLabel}` : ""}
                    </h4>
                    {pricing.byGrade?.map((summary) => (
                        <CompsRow key={String(summary.grade)} summary={summary} />
                    ))}
                    {pricing.status !== "PRICED" && <p className={styles.muted}>{pricing.reason}</p>}
                </div>
            ))}
        </Section>
    );
}

function PhotosSection({ evaluation, photoCheck }: { evaluation: Evaluation; photoCheck: PhotoCheck }) {
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
                    <h4 className={styles.subTitle}>Missing views</h4>
                    <Notes items={photoCheck.missingViews} tone="muted" />
                </>
            )}
        </Section>
    );
}

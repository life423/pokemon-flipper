import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tween } from "./Tween";
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
    Targets,
} from "../types";
import { describeRange, dollars, name, percent, timeLeft } from "../format";
import { useNow } from "../useNow";
import { useDialog } from "../useDialog";
import { MONEY_CONFIG } from "../../../shared/money/config.ts";
import { AuctionSummary } from "./AuctionSummary";
import { GradingComparison } from "./GradingComparison";
import { PhotoGallery } from "./PhotoGallery";
import { PhotoReview, type DeeperReviewState } from "./PhotoReview";
import { CONDITION_AREAS, RAW_CONDITIONS, CONDITION_NAMES, CONDITION_DEFINITIONS } from "../../../shared/conditions.ts";
import { returnText } from "../../../shared/card-presentation.ts";
import { ceilingLabel } from "../../../shared/format.ts";
import { describeOffer, numbersAtOffer, offerFor } from "../../../shared/money/offer.ts";
import { resaleActivity, matchedSoldActivity } from "../../../shared/liquidity.ts";
import { photoEvidence } from "../../../shared/photo-evidence.ts";
import { listingSignals } from "../../../shared/signals.ts";
import { writeOfferNote } from "../api";
import { RatingBadge, VerdictBadge } from "./VerdictBadge";
import styles from "./DetailPanel.module.css";

interface Props {
    // Sliding away, just before the panel goes.
    closing?: boolean;
    listing: ListingSummary;
    analysis?: AnalysisState;
    now: number;
    onClose: () => void;
    onAnalyze: (fresh: boolean) => void;
    minGrade?: number;
    targets?: Targets;
    photoReviewState?: DeeperReviewState;
    onPhotoReview: () => void;
    onSave?: () => void;
    saved?: boolean;
    saving?: boolean;
}

export function DetailPanel({ listing, analysis, now, onClose, onAnalyze, closing = false, minGrade = 0, targets = MONEY_CONFIG.targets, photoReviewState, onPhotoReview, onSave, saved, saving }: Props) {
    const unavailable = listing.availability === "UNAVAILABLE" || Boolean(listing.endTime && Date.parse(listing.endTime) <= now);
    // A new listing opens at the top of the panel.
    const panel = useRef<HTMLElement>(null);

    useEffect(() => {
        panel.current?.scrollTo({ top: 0 });
    }, [listing.id]);

    useDialog(true, panel, onClose);

    return (
        <>
            <div className={`${styles.backdrop} ${closing ? styles.closing : ""}`} onClick={onClose} />

            <aside ref={panel} className={`${styles.panel} ${closing ? styles.closing : ""}`} aria-label="Listing analysis" role="dialog" aria-modal="true">
                {/* Switching listings crossfades the content; the panel stays put. */}
                <div key={listing.id} className={styles.content}>
                <header className={styles.head}>
                    <h2 className={styles.title}>{listing.title}</h2>
                    <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
                        &times;
                    </button>
                </header>

                {analysis?.status === "done" && <FinancialDecision evaluation={analysis.evaluation} targets={targets} now={now} />}
                <PhotoReview listing={listing} evaluation={analysis?.status === "done" ? analysis.evaluation : null}
                    phase={analysis?.status === "loading" || analysis?.status === "error" ? analysis.status : undefined}
                    state={photoReviewState} onReview={unavailable ? undefined : onPhotoReview} />
                {unavailable && <p className={styles.bad}>Saved analysis only. This listing is unavailable or ended.</p>}

                <PhotoGallery images={analysis?.status === "done" ? analysis.evaluation.listing.photos ?? listing.images : listing.images} />

                <p className={styles.small}>
                    <a className={styles.listingLink} href={listing.url} target="_blank" rel="noopener noreferrer">
                        Open the listing on eBay
                    </a>
                </p>
                {onSave && <button type="button" className={styles.secondary} onClick={() => { if (!saving) onSave(); }} aria-disabled={saving} aria-pressed={saved}>{saving ? "Saving…" : saved ? "Remove from shortlist" : "Save to shortlist"}</button>}

                {!analysis && !unavailable && (
                    <div className={styles.cta}>
                        <p>
                            Checks the photos, identifies the exact card and printing, and prices every
                            path. About 20 seconds the first time.
                        </p>
                        <button type="button" className={styles.primary} onClick={() => onAnalyze(false)}>
                            Analyze listing (paid)
                        </button>
                    </div>
                )}

                {analysis?.status === "loading" && <Loading startedAt={analysis.startedAt} />}

                {analysis?.status === "error" && !unavailable && (
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
                        minGrade={minGrade}
                        onReanalyze={() => onAnalyze(true)}
                        reviewing={photoReviewState?.status === "loading" || unavailable}
                    />
                )}
                </div>
            </aside>
        </>
    );
}

function Loading({ startedAt }: { startedAt: number }) {
    const now = useNow(1000);
    const seconds = Math.max(0, Math.round((now - startedAt) / 1000));

    // The shape of the answer that's coming, while the AI works.
    return (
        <div className={styles.loading} aria-live="polite">
            <div className={styles.skeleton} aria-hidden="true">
                <span className="shimmer" style={{ width: "35%" }} />
                <span className={`${styles.skeletonHero} shimmer`} />
                <span className="shimmer" />
                <span className="shimmer" style={{ width: "80%" }} />
                <span className="shimmer" style={{ width: "60%" }} />
            </div>
            <p>Checking photos, identifying the printing, and pulling sold comps... {seconds}s</p>
        </div>
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
    minGrade,
    reviewing,
}: {
    listing: ListingSummary;
    evaluation: Evaluation;
    now: number;
    onReanalyze: () => void;
    minGrade: number;
    reviewing: boolean;
}) {
    const tokens = evaluation.usage.reduce(
        (total, step) => total + (step.inputTokens ?? 0) + (step.outputTokens ?? 0),
        0
    );
    const evidence = photoEvidence(evaluation, minGrade);

    return (
        <>
            {evaluation.condition && <Section title="PSA and CGC comparison"><GradingComparison evaluation={evaluation} expanded /></Section>}
            <Section title="Photo evidence and grading confidence">
                <p>Assessment confidence: {name(evidence.confidence)}. {evidence.coverage}.</p>
                {!evaluation.slab && minGrade > 0 && <p>{evidence.target}</p>}
                <Notes items={evidence.issues} tone="muted" />
            </Section>

            {evaluation.underwriting && evaluation.underwriting.paths.length > 0 && (
                <Section title="Every path">
                    <div className={styles.paths}>
                        {evaluation.underwriting.paths.map((path) => (
                            <PathCard key={path.label} path={path} auction={evaluation.listing.buyingOption === "AUCTION"} />
                        ))}
                    </div>
                </Section>
            )}

            <ListingEvidenceSection listing={listing} evaluation={evaluation} />
            <OfferSection listing={listing} evaluation={evaluation} />
            <Section title="Resale activity">
                <p>{resaleActivity(evaluation, now).label}</p>
                <p className={styles.small}>{resaleActivity(evaluation, now).detail}</p>
                {(() => { const matched = matchedSoldActivity(evaluation, now); return matched && <><h4 className={styles.subTitle}>Matched sold listings · {matched.scope}</h4><Pairs rows={[
                    ["Observed / 7 days", String(matched.last7)], ["Observed / 30 days", String(matched.last30)], ["Observed / 90 days", String(matched.last90)],
                    ["Matching sample", `${matched.returned} sales / ${matched.windowDays}-day lookup`], ["Latest matching sale", matched.newest ?? "None in returned sample"],
                ]} /></>; })()}
                {evaluation.marketActivity?.status === "AVAILABLE" && <h4 className={styles.subTitle}>Broader activity · {evaluation.marketActivity.scope === "RAW" ? "all raw conditions" : "all graders and grades"}</h4>}
                {evaluation.marketActivity?.status === "AVAILABLE" && <Pairs rows={[
                    ["Recorded eBay sales / 30 days", `${evaluation.marketActivity.complete ? "" : "At least "}${evaluation.marketActivity.observedSales}`],
                    ["Average recorded sales / day", evaluation.marketActivity.dailyAverage.toFixed(evaluation.marketActivity.dailyAverage < 1 ? 2 : 1)],
                    ["Days with recorded sales", `${evaluation.marketActivity.activeDays} / 30`],
                    ["Latest recorded sale", evaluation.marketActivity.newestSale ?? "None recorded"],
                ]} />}
                {evaluation.marketActivity?.status === "UNAVAILABLE" && <p className={styles.small}>{evaluation.marketActivity.reason}</p>}
            </Section>
            <ListingSection listing={listing} evaluation={evaluation} />
            {evaluation.identity && <IdentitySection identity={evaluation.identity} isSlab={Boolean(evaluation.slab)} />}
            {evaluation.slab && <SlabSection slab={evaluation.slab} pricing={evaluation.slabPricing} />}
            {evaluation.condition && <ConditionSection evaluation={evaluation} condition={evaluation.condition} />}

            {(evaluation.rawPricing || evaluation.gradedPricing) && (
                <PricesSection raw={evaluation.rawPricing} graded={evaluation.gradedPricing} />
            )}
            {evaluation.rawPricing?.crossCheckNote && <p className={styles.small}>{evaluation.rawPricing.crossCheckNote}</p>}

            {evaluation.photoCheck && <PhotosSection evaluation={evaluation} photoCheck={evaluation.photoCheck} />}

            <footer className={styles.footer}>
                <p className={styles.small}>
                    {evaluation.answeredAt && `Analyzed ${new Date(evaluation.answeredAt).toLocaleString()}. `}
                    {evaluation.usage.length > 0
                        ? `The initial analysis used ${tokens.toLocaleString()} tokens.`
                        : "The initial analysis reused saved AI assessments."}
                </p>
                <button type="button" className={styles.secondary} onClick={onReanalyze} disabled={reviewing}>
                    Reanalyze full listing (paid)
                </button>
            </footer>
        </>
    );
}

function FinancialDecision({ evaluation, targets, now }: { evaluation: Evaluation; targets: Targets; now: number }) {
    if (!evaluation.underwriting) return null;
    return evaluation.listing.buyingOption === "AUCTION" ? <Section title="Auction decision">
        <AuctionSummary evaluation={evaluation} targets={targets} now={now} />
        <Notes items={evaluation.underwriting.reasons} />
        <Notes items={evaluation.underwriting.assumptions} tone="muted" />
        <Notes items={evaluation.rating?.concerns ?? []} tone="bad" />
    </Section> : <VerdictSection underwriting={evaluation.underwriting} evaluation={evaluation} now={now} />;
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
        ["Shipping", listing.shipping === null ? `Not quoted · ${dollars(MONEY_CONFIG.buying.assumedShippingWhenUnknown)} assumed` : dollars(listing.shipping)],
    ];
    if (best?.path === "RAW") {
        const quote = evaluation.rawPricing?.prices?.find(price => price.condition === best.priceCondition);
        rows.push(["Raw sale estimate before fees", dollars(best.salePrice)]);
        rows.push(["Resale evidence", best.pricingNotes?.length ? "Conservative adjusted market fallback" : quote?.basis === "EBAY_SOLD" ? `${quote.comps?.count ?? "Matched"} eBay sold comps` : "TCGplayer market fallback"]);
        rows.push(["Net sale proceeds after fees and shipping", dollars(best.expectedNet)]);
    }

    if (room !== null) {
        // An auction's bid days before the end says nothing about the outcome.
        if (listing.buyingOption !== "AUCTION") rows.push([
            room >= 0 ? "Below your price limit" : "Above your price limit",
            <span className={room >= 0 ? styles.good : styles.bad}>{dollars(Math.abs(room))}</span>,
        ]);
    }
    if (best && (listing.buyingOption !== "AUCTION" || underwriting.verdict.startsWith("BUY"))) {
        // An auction's bid will rise, so its profit is shown at the max bid.
        const auction = listing.buyingOption === "AUCTION";
        const profit = auction ? best.profitAtMaxBid : best.profit;
        const investment = auction ? best.costAtMaxBid : best.cost;
        const roi = investment && profit !== null ? profit / investment : null;

        rows.push([
            auction ? "Est. profit at max bid" : (profit ?? 0) < 0 ? "Est. net loss at asking" : "Est. net profit at asking",
            <span className={(profit ?? 0) >= 0 ? styles.good : styles.bad}>
                {dollars(profit === null ? null : Math.abs(profit))} ({returnText(roi)} return on total cost)
            </span>,
        ]);
        if (!auction) rows.push(["Est. total invested", dollars(best.cost)]);
    }
    if (left) {
        rows.push(["Ends in", left]);
    }

    // An auction ends near its usual price, not near today's bid.
    const outlook = evaluation.rating?.auction;

    if (outlook) {
        rows.push(["Usually sells for", dollars(outlook.usualPrice)]);

        if (outlook.profitAtUsual != null) {
            rows.push([
                "Profit if it ends there",
                <span className={outlook.profitAtUsual >= 0 ? styles.good : styles.bad}>{dollars(outlook.profitAtUsual)}</span>,
            ]);
        }

        if (outlook.salesTotal !== null) {
            rows.push(["Recent sales at or under max bid", `${outlook.salesAtOrUnder} of ${outlook.salesTotal}`]);
        }
    }

    return (
        <section className={styles.verdict}>
            <div className={styles.badges}>
                {evaluation.rating && <RatingBadge level={evaluation.rating.level} large />}
                <VerdictBadge verdict={underwriting.verdict} large />
            </div>

            {best?.maxBid !== undefined && (
                <div className={styles.hero}>
                    <span className={styles.heroLabel}>{ceilingLabel(listing.buyingOption)} · {best.label}</span>
                    {/* Green to buy, purple to grade: the verdict's color, not today's bid. */}
                    <span
                        className={`${styles.heroValue} ${
                            underwriting.verdict === "BUY_AND_GRADE"
                                ? styles.gradeText
                                : underwriting.verdict.startsWith("BUY")
                                  ? styles.good
                                  : ""
                        }`}
                    >
                        <Tween value={best.maxBid} format={dollars} />
                    </span>
                    <span className={styles.heroLabel}>{best.label}</span>
                </div>
            )}

            <Pairs rows={rows} />
            <Notes items={best?.pricingNotes ?? []} tone="muted" />
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

function PathCard({ path, auction }: { path: MoneyPath; auction: boolean }) {
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
                    // An auction's bid days before the end means nothing, so its
                    // numbers are at the max bid; a Buy It Now's are at its price.
                    ...((auction
                        ? [
                              ["Cost at your max bid", dollars(path.costAtMaxBid)],
                              ["Profit at your max bid", `${dollars(path.profitAtMaxBid)} (${returnText(path.costAtMaxBid && path.profitAtMaxBid != null ? path.profitAtMaxBid / path.costAtMaxBid : null)})`],
                              ["Modeled downside at your max bid", dollars(path.downsideAtMaxBid)],
                          ]
                        : [
                              ["All-in cost", dollars(path.cost)],
                              [
                                  "Profit",
                                  <span className={(path.profit ?? 0) >= 0 ? styles.good : styles.bad}>
                                      {dollars(path.profit)} ({returnText(path.cost > 0 ? path.profit / path.cost : null)})
                                  </span>,
                              ],
                              ["Modeled downside", dollars(path.downside)],
                          ]) as [string, ReactNode][]),
                    [auction ? "Max bid" : "Max price", <strong>{dollars(path.maxBid)}</strong>],
                ]}
            />

            {path.outlook && (
                <>
                <p className={styles.small}>Scenario weights are pricing assumptions, not measured probabilities of receiving a PSA or CGC grade.</p>
                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th>Grade</th>
                            <th>Scenario weight</th>
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
                </>
            )}
        </div>
    );
}

function ListingEvidenceSection({ listing, evaluation }: { listing: ListingSummary; evaluation: Evaluation }) {
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

function OfferSection({ listing, evaluation }: { listing: ListingSummary; evaluation: Evaluation }) {
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
            {pricing?.activeReference && <div>
                <p><strong>Current Buy It Now competition</strong></p>
                <p>Resale target {dollars(pricing.activeReference.resalePrice)} · {percent(pricing.activeReference.discountRate)} below the cheapest matching item plus shipping ({dollars(pricing.activeReference.lowestTotal)}).</p>
                <p className={styles.small}>Slab photos and labels checked · sellers have 100+ feedback and at least 98.5% positive · checked {new Date(pricing.activeReference.checkedAt).toLocaleString()}.</p>
                <ul>{pricing.activeReference.listings.map(comp => <li key={comp.id}><a className={styles.listingLink} href={comp.url} target="_blank" rel="noopener noreferrer">{comp.title}</a><p>{dollars(comp.total)} including shipping · {comp.seller.username} · {comp.seller.feedbackPercentage}% positive</p></li>)}</ul>
            </div>}
            {pricing && pricing.status !== "PRICED" && <p className={styles.muted}>{pricing.reason}</p>}
        </Section>
    );
}

function ConditionSection({ evaluation, condition }: { evaluation: Evaluation; condition: Condition }) {
    const areas = CONDITION_AREAS;

    return (
        <Section title="Condition">
            <p>Seller says: {evaluation.listing.cardCondition ?? "Not stated"} · AI assesses: <strong>{name(condition.rawCondition)}</strong></p>
            <details className={styles.details}><summary>Our six condition definitions</summary><dl>{RAW_CONDITIONS.map(key => <div key={key}><dt><strong>{CONDITION_NAMES[key]}</strong></dt><dd>{CONDITION_DEFINITIONS[key]}</dd></div>)}</dl></details>
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
                    {summary.grader === "RAW" ? `Raw · ${name(String(summary.grade))}` : `${summary.grader} ${summary.grade}`}
                </span>
                <span className={styles.compStats}>
                    {summary.count > 0
                        ? `${summary.count} sales, median ${dollars(summary.median)}, ${name(summary.confidence)}${summary.checkedByAI ? ", checked by AI" : ""}`
                        : "No verified sales"}
                </span>
            </summary>

            {summary.count > 0 && (
                <p className={styles.small}>
                    {summary.mean != null ? `Average ${dollars(summary.mean)}. ` : ""}Range {dollars(summary.low)} to {dollars(summary.high)}. Newest sale {summary.newestSale}.{summary.windowDays ? ` Up to ${summary.windowDays} days of recent sales; at most 40 returned rows per lookup are sampled. The median drives the estimate.` : ""}
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
                        {sale.photoCondition && <span className={styles.muted}>Seller says: {sale.sellerCondition ? CONDITION_NAMES[sale.sellerCondition] : "Not stated"} · AI assesses: {CONDITION_NAMES[sale.photoCondition]}</span>}
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
                        <Pairs rows={RAW_CONDITIONS.map(condition => {
                            const price = raw.prices?.find(entry => entry.condition === condition);
                            return [CONDITION_NAMES[condition], !price ? "No supported price" : `${dollars(price.price)} · ${price.basis === "EBAY_SOLD" ? `eBay sold median (${price.comps?.count} ${raw.conditionEvidence === "AI_PHOTOS" ? "photo-assessed " : ""}sales)` : price.basis === "TCGPLAYER" || raw.source === "pkmnprices" ? "TCGplayer market fallback" : "Market feed"}`];
                        })} />
                    ) : (
                        <p className={styles.muted}>{raw.reason}</p>
                    )}
                    {raw.evidenceNote && <p className={styles.small}>{raw.evidenceNote}</p>}
                    {raw.ebayComps?.filter(summary => summary.count > 0).map(summary => <CompsRow key={String(summary.grade)} summary={summary} />)}
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

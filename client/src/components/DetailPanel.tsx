import { MarketReferences } from "./analysis/MarketReferences";
import { useEffect, useRef, type RefObject } from "react";
import type { AnalysisState, PriceRefreshState } from "../analysis-state";
import type { ListingSummary, Targets } from "../types";
import { useNow } from "../useNow";
import { useDialog } from "../useDialog";
import { MONEY_CONFIG } from "../../../shared/money/config.ts";
import { priceEvidenceGap } from "../../../shared/money/price-evidence.ts";
import { readyForPricing } from "../../../shared/identity.ts";
import { PhotoGallery } from "./PhotoGallery";
import { PhotoReview, type DeeperReviewState } from "./PhotoReview";
import { SoldPriceScreening } from "./SoldPriceScreening";
import { AnalysisDetails } from "./analysis/AnalysisDetails";
import { GradingComparison } from "./GradingComparison";
import { SlabSection } from "./analysis/EvidenceSections";
import { PricesSection } from "./analysis/PricingSections";
import { Section } from "./analysis/primitives";
import type { DealHuntReport } from "../../../shared/deal-hunt.ts";
import { OfferSection, type ReviewedDecision } from "./analysis/OfferSection";
import { FinancialDecision } from "./analysis/FinancialDecision";
import styles from "./DetailPanel.module.css";

interface Props {
    huntFocus?: { report: DealHuntReport; alternative?: { reason: string } } | null;
    docked?: boolean;
    returnFocus?: RefObject<HTMLElement | null>;
    // Sliding away, just before the panel goes.
    closing?: boolean;
    listing: ListingSummary;
    analysis?: AnalysisState;
    automaticDecision?: ReviewedDecision;
    reviewPending?: boolean;
    now: number;
    onClose: () => void;
    onAnalyze: (fresh: boolean) => void;
    onRefreshPrices?: () => void;
    priceRefresh?: PriceRefreshState;
    minGrade?: number;
    targets?: Targets;
    includeOffers: boolean;
    photoReviewState?: DeeperReviewState;
    onPhotoReview: () => void;
    onSave?: () => void;
    saved?: boolean;
    saving?: boolean;
}

export function DetailPanel({ listing, analysis, automaticDecision, reviewPending, now, onClose, onAnalyze, onRefreshPrices, priceRefresh, closing = false, docked = false, returnFocus, huntFocus, minGrade = 0, targets = MONEY_CONFIG.targets, includeOffers, photoReviewState, onPhotoReview, onSave, saved, saving }: Props) {
    const unavailable = listing.availability === "UNAVAILABLE" || Boolean(listing.endTime && Date.parse(listing.endTime) <= now);
    const evaluation = analysis?.status === "done" ? analysis.evaluation : null;
    const checking = Boolean(reviewPending && !automaticDecision && !unavailable);
    const override = automaticDecision && automaticDecision.decision !== "BUY" ? automaticDecision : null;
    const showPurchaseScenarios = !checking && !override;
    const pricingExpired = analysis?.status === "done" && analysis.pricingExpired;
    const canRefreshPrices = onRefreshPrices && !unavailable && evaluation?.photoCheck &&
        (readyForPricing(evaluation.identity) || evaluation.pricingDeferred?.identityLookupPending) &&
        (pricingExpired || priceEvidenceGap(evaluation) || evaluation.underwriting?.verdict === "CANT_PRICE");
    const refreshingPrices = priceRefresh?.status === "loading";
    const reviewing = photoReviewState?.status === "loading" || refreshingPrices;
    // A new listing opens at the top of the panel.
    const panel = useRef<HTMLElement>(null);
    const huntEvidence = useRef<HTMLElement>(null);
    const destination = huntFocus?.report.destination;
    const section = showPurchaseScenarios && evaluation && destination?.listingId === listing.id ? destination.section : null;
    const label = section === "sales" ? "Price evidence" : section === "grading" ? "Grading breakdown" : "Photo evidence";
    const action = section === "sales" ? "check_sales" : section === "grading" ? "calculate_grading" : "inspect_photos";
    const observation = huntFocus?.report.steps.find(step => step.listingId === listing.id && step.action === action)?.observation;

    useEffect(() => {
        panel.current?.scrollTo({ top: 0 });
    }, [listing.id]);

    useDialog(true, panel, onClose, { modal: !docked, returnFocus });
    useEffect(() => {
        if (section) {
            panel.current?.scrollTo({ top: 0 });
            huntEvidence.current?.focus({ preventScroll: true });
        }
    }, [huntFocus, section]);
    const photoReview = <PhotoReview compact={checking} listing={listing} evaluation={evaluation}
        assessment={analysis?.status === "done" ? undefined : analysis}
        state={photoReviewState} onReview={unavailable || refreshingPrices ? undefined : onPhotoReview} />;

    return (
        <>
            {!docked && <div className={`${styles.backdrop} ${closing ? styles.closing : ""}`} onClick={onClose} />}

            <aside ref={panel} className={`${styles.panel} ${closing ? styles.closing : ""}`} data-docked={docked || undefined}
                aria-label="Listing analysis" role={docked ? "region" : "dialog"} aria-modal={docked ? undefined : true}>
                {/* Switching listings crossfades the content; the panel stays put. */}
                <div key={listing.id} className={styles.content}>
                <header className={styles.head}>
                    <h2 className={styles.title}>{listing.title}</h2>
                    <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
                        &times;
                    </button>
                </header>

                {checking && <section className={styles.section} role="status">
                    <h3 className={styles.sectionTitle}>Checking listing</h3>
                    <p>The app is checking this copy against your buying criteria.</p>
                </section>}
                {override && <Section title={override.auctionOpportunity?.status === "BID" && override.auctionOpportunity.validUntil > now ? "Bid opportunity" : override.decision === "SKIP" ? "Skip" : "Wait"}><p>{override.reason}</p></Section>}
                {section && evaluation && huntFocus && <section className={styles.huntEvidence} ref={huntEvidence} tabIndex={-1}
                    aria-label={label} data-hunt-section={section}>
                    <h3>{label}</h3>
                    <p><strong data-decision={huntFocus.report.decision}>{huntFocus.report.decision === "BID" ? "Bid opportunity" : huntFocus.report.decision === "BUY" ? "Buy" : "Wait"}</strong> · {huntFocus.report.reason}</p>
                    {huntFocus.alternative && <p>{huntFocus.alternative.reason}</p>}
                    {observation && observation !== huntFocus.report.reason && <p>{observation}</p>}
                    {section === "grading" && <GradingComparison evaluation={evaluation} expanded />}
                    {section === "photos" && photoReview}
                    {section === "sales" && <>
                        {evaluation.slab && <SlabSection slab={evaluation.slab} pricing={evaluation.slabPricing} showSales />}
                        {!evaluation.slab && (evaluation.rawPricing || evaluation.gradedPricing) &&
                            <PricesSection raw={evaluation.rawPricing} graded={evaluation.gradedPricing} />}
                        <MarketReferences evaluation={evaluation} />
                    </>}
                </section>}

                <div className={styles.detailActions}>
                    <a className={`${styles.primary} ${styles.listingLink}`} href={listing.url} target="_blank" rel="noopener noreferrer">Open on eBay ↗</a>
                    {onSave && <button type="button" className={styles.secondary} onClick={() => { if (!saving) onSave(); }} aria-disabled={saving} aria-pressed={saved}>{saving ? "Saving…" : saved ? "Remove from shortlist" : "Save to shortlist"}</button>}
                </div>
                <PhotoGallery images={analysis?.status === "done" ? analysis.evaluation.listing.photos ?? listing.images : listing.images} />
                {!checking && analysis?.status !== "done" && <SoldPriceScreening listing={listing} />}

                {showPurchaseScenarios && analysis?.status === "done" && <FinancialDecision evaluation={analysis.evaluation} targets={targets} now={now} />}
                {analysis?.status === "done" && section !== "sales" && <MarketReferences evaluation={analysis.evaluation} />}
                {!checking && (canRefreshPrices || priceRefresh) && <div className={styles.cta}>
                    {canRefreshPrices && <>
                        <p>Check current listing terms and sold prices using the saved photo assessment. This uses marketplace requests and no new AI.</p>
                        <button type="button" className={styles.primary} disabled={reviewing} onClick={onRefreshPrices}>{refreshingPrices ? "Refreshing pricing…" : "Refresh pricing"}</button>
                    </>}
                    {priceRefresh?.status === "error" && <p role="alert" className={styles.bad}>Pricing refresh failed. {priceRefresh.message} Your saved assessment is still shown.</p>}
                    {priceRefresh?.status === "done" && <p role="status">{priceRefresh.message}</p>}
                </div>}
                {!checking && includeOffers && !unavailable && !pricingExpired && analysis?.status === "done" && <OfferSection listing={listing} evaluation={analysis.evaluation} automaticDecision={automaticDecision} />}
                {section !== "photos" && (!checking || evaluation?.photoCheck) && photoReview}
                {unavailable && <p className={styles.bad}>Saved analysis only. This listing is unavailable or ended.</p>}

                {!checking && !analysis && !unavailable && (
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

                {!checking && analysis?.status === "loading" && <Loading startedAt={analysis.startedAt} />}

                {!checking && analysis?.status === "error" && !unavailable && (
                    <div className={styles.cta}>
                        <p className={styles.bad}>The analysis failed: {analysis.message}</p>
                        <button type="button" className={styles.primary} onClick={() => onAnalyze(false)}>
                            Try again
                        </button>
                    </div>
                )}

                {analysis?.status === "done" && (
                    <AnalysisDetails
                        listing={listing}
                        evaluation={analysis.evaluation}
                        now={now}
                        minGrade={minGrade}
                        promoted={section}
                        onReanalyze={unavailable || checking ? undefined : () => onAnalyze(Boolean(pricingExpired) || !analysis.evaluation.researchMode || analysis.evaluation.researchMode === "FULL")}
                        reviewing={reviewing}
                        showPurchaseScenarios={showPurchaseScenarios}
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

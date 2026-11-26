import { MarketPrices } from "./MarketPrices";
import { listingMarketPrices } from "../../../shared/listing-market-prices.ts";
import { MarketReferences } from "./analysis/MarketReferences";
import { useEffect, useRef, type RefObject } from "react";
import type { AnalysisState, PriceRefreshState } from "../analysis-state";
import type { ListingSummary, Targets } from "../types";
import { useNow } from "../useNow";
import type { SniperDraft } from "./AuctionSniper";
import { AuctionReminderButton } from "./AuctionReminderButton";
import { useDialog } from "../useDialog";
import { MONEY_CONFIG } from "../../../shared/money/config.ts";
import { priceEvidenceGap } from "../../../shared/money/price-evidence.ts";
import { applyVerifiedPurchase, PURCHASE_RECHECK_MESSAGE } from "../../../shared/money/verified-purchase.ts";
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
import { huntDecisionLabel } from "../search/hunt-result";
import { OfferSection, type ReviewedDecision } from "./analysis/OfferSection";
import { FinancialDecision } from "./analysis/FinancialDecision";
import { ResaleReceiptPanel } from "./ResaleReceipts";
import { CardmarketComparisonPanel } from "./CardmarketComparisonPanel";
import { cardmarketComparisonKey } from "../../../shared/cardmarket.ts";
import styles from "./DetailPanel.module.css";

interface Props {
    flipOffer?: import("../../../shared/auction-opportunity.ts").AuctionOpportunity | null;
    huntFocus?: { report: DealHuntReport; alternative?: { reason: string } } | null;
    docked?: boolean;
    returnFocus?: RefObject<HTMLElement | null>;
    // Sliding away, just before the panel goes.
    closing?: boolean;
    listing: ListingSummary;
    analysis?: AnalysisState;
    automaticDecision?: ReviewedDecision;
    reviewPending?: boolean;
    reviewActive?: boolean;
    now: number;
    onClose: () => void;
    onSnipe?: (draft: SniperDraft) => void;
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

export function DetailPanel({ listing, analysis, automaticDecision: receipt, reviewPending, reviewActive, now, onClose, onSnipe, onAnalyze, onRefreshPrices, priceRefresh, closing = false, docked = false, returnFocus, huntFocus, flipOffer, minGrade = 0, targets = MONEY_CONFIG.targets, includeOffers, photoReviewState, onPhotoReview, onSave, saved, saving }: Props) {
    const unavailable = listing.availability === "UNAVAILABLE" || Boolean(listing.endTime && Date.parse(listing.endTime) <= now);
    const assessed = analysis?.status === "done" ? analysis.evaluation : null;
    const collecting = huntFocus?.report.goal === "collect_slab" && huntFocus.report.destination?.listingId === listing.id;
    const report = huntFocus?.report;
    const huntPurchase = !collecting && report?.decision === "BUY" && report.destination?.listingId === listing.id;
    const review: ReviewedDecision | undefined = huntPurchase && receipt?.decision !== "WAIT"
        ? { decision: "BUY", reason: report.reason, verifiedPurchase: report.verifiedPurchase } : receipt;
    const reviewed = review?.decision === "BUY" && assessed?.listing.id === listing.id
        ? applyVerifiedPurchase(assessed, review.verifiedPurchase, targets, now) : null;
    const evaluation = reviewed ?? assessed;
    const automaticDecision: ReviewedDecision | undefined = review?.decision === "BUY" && !reviewed
        ? { decision: "WAIT", reason: PURCHASE_RECHECK_MESSAGE } : review;
    const checking = Boolean(!collecting && reviewPending && !automaticDecision && !unavailable);
    const override = !collecting && automaticDecision && automaticDecision.decision !== "BUY" ? automaticDecision : null;
    const showPurchaseScenarios = !collecting && !checking && !override;
    const comparisonMarket = evaluation && cardmarketComparisonKey(evaluation);
    const pricingExpired = analysis?.status === "done" && analysis.pricingExpired;
    const prices = !checking && !pricingExpired && !unavailable && evaluation ? listingMarketPrices(evaluation, listing, now) : undefined;
    const canRefreshPrices = onRefreshPrices && !unavailable && evaluation?.photoCheck &&
        (readyForPricing(evaluation.identity) || evaluation.pricingDeferred?.identityLookupPending) &&
        (pricingExpired || priceEvidenceGap(evaluation) || evaluation.underwriting?.verdict === "CANT_PRICE");
    const refreshingPrices = priceRefresh?.status === "loading";
    const reviewing = photoReviewState?.status === "loading" || refreshingPrices;
    // A new listing opens at the top of the panel.
    const panel = useRef<HTMLElement>(null);
    const huntEvidence = useRef<HTMLElement>(null);
    const destination = huntFocus?.report.destination;
    const sameWaitDecision = huntFocus?.report.decision === "WAIT" && override?.decision === "WAIT" &&
        !override.auctionOpportunity && !unavailable;
    const section = (collecting || showPurchaseScenarios || sameWaitDecision) && evaluation && destination?.listingId === listing.id ? destination.section : null;
    const label = section === "sales" ? "Price evidence" : section === "grading" ? "Grading breakdown" : "Photo evidence";
    const actions = section === "sales" ? ["check_sales", "check_price_references", "check_price_tracker", "search_web_sales", "check_price_history", "compare_cardmarket", "check_raw_resale"] :
        section === "grading" ? ["calculate_grading"] : ["inspect_photos", "resolve_printing"];
    const observation = huntFocus?.report.steps.filter(step => step.listingId === listing.id && actions.includes(step.action)).at(-1)?.observation;

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
                    <h3 className={styles.sectionTitle}>{reviewActive || analysis?.status === "loading" ? "Checking listing" : "Queued for review"}</h3>
                    <p>{reviewActive || analysis?.status === "loading" ? "The app is checking this copy against your buying criteria." : "This copy will be checked after the current listings finish."}</p>
                </section>}
                {override && <Section title={override.auctionOpportunity?.status === "BID" && override.auctionOpportunity.validUntil > now ? "Bid opportunity" : override.decision === "SKIP" ? "Skip" : "Wait"}><p>{override.reason}</p></Section>}
                {section && evaluation && huntFocus && <section className={styles.huntEvidence} ref={huntEvidence} tabIndex={-1}
                    aria-label={label} data-hunt-section={section}>
                    <h3>{label}</h3>
                    <p><strong data-decision={huntFocus.report.decision}>{huntDecisionLabel(huntFocus.report)}</strong> · {huntFocus.report.reason}</p>
                    {huntFocus.alternative && huntFocus.report.decision !== "BID" && <p>{huntFocus.alternative.reason}</p>}
                    {observation && observation !== huntFocus.report.reason && <p>{observation}</p>}
                    {section === "grading" && <GradingComparison evaluation={evaluation} expanded verifiedPurchase={Boolean(reviewed)} />}
                    {section === "photos" && photoReview}
                    {section === "sales" && <>
                        {prices && <MarketPrices prices={prices} now={now} />}
                        {evaluation.slab && <SlabSection slab={evaluation.slab} pricing={evaluation.slabPricing} showSales />}
                        {!evaluation.slab && (evaluation.rawPricing || evaluation.gradedPricing) &&
                            <PricesSection raw={evaluation.rawPricing} graded={evaluation.gradedPricing} />}
                        <MarketReferences evaluation={evaluation} />
                    </>}
                </section>}

                <div className={styles.detailActions}>
                    <a className={`${styles.primary} ${styles.listingLink}`} href={listing.url} target="_blank" rel="noopener noreferrer">Open on eBay ↗</a>
                    <AuctionReminderButton flipOffer={flipOffer === undefined ? undefined : huntFocus ? flipOffer : null} searchId={report?.searchId} listing={listing} analysis={showPurchaseScenarios ? analysis : undefined} targets={targets} now={now} className={styles.secondary} onSnipe={onSnipe} />
                    {onSave && <button type="button" className={styles.secondary} onClick={() => { if (!saving) onSave(); }} aria-disabled={saving} aria-pressed={saved}>{saving ? "Saving…" : saved ? "Remove from shortlist" : "Save to shortlist"}</button>}
                </div>
                <PhotoGallery images={analysis?.status === "done" ? analysis.evaluation.listing.photos ?? listing.images : listing.images} />
                {!checking && analysis?.status !== "done" && <SoldPriceScreening listing={listing} />}

                {showPurchaseScenarios && evaluation && <FinancialDecision evaluation={evaluation} targets={targets} now={now} />}
                {section !== "sales" && prices && <MarketPrices prices={prices} now={now} />}
                {analysis?.status === "done" && section !== "sales" && <MarketReferences evaluation={analysis.evaluation} />}
                {!checking && analysis?.status === "done" && comparisonMarket && <CardmarketComparisonPanel key={comparisonMarket}
                    listing={listing} state={analysis} now={now} market={comparisonMarket} />}
                {!checking && analysis?.status === "done" && <ResaleReceiptPanel listing={listing} state={analysis} now={now} />}
                {!checking && (canRefreshPrices || priceRefresh) && <div className={styles.cta}>
                    {canRefreshPrices && <>
                        <p>Check current listing terms and sold prices. This uses marketplace requests and no new AI.</p>
                        <button type="button" className={styles.primary} disabled={reviewing} onClick={onRefreshPrices}>{refreshingPrices ? "Refreshing pricing…" : "Refresh pricing"}</button>
                    </>}
                    {priceRefresh?.status === "error" && <p role="alert" className={styles.bad}>Pricing refresh failed. {priceRefresh.message}</p>}
                    {priceRefresh?.status === "done" && <p role="status">{priceRefresh.message}</p>}
                </div>}
                {!checking && includeOffers && !unavailable && !pricingExpired && evaluation && <OfferSection listing={listing} evaluation={evaluation} targets={targets} now={now} automaticDecision={automaticDecision} />}
                {section !== "photos" && (!checking || evaluation?.photoCheck) && photoReview}
                {unavailable && <p className={styles.bad}>This listing is unavailable or ended. Figures reflect the last check.</p>}

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
                        evaluation={evaluation ?? analysis.evaluation}
                        now={now}
                        minGrade={minGrade}
                        promoted={section}
                        onReanalyze={unavailable || checking ? undefined : () => onAnalyze(Boolean(pricingExpired) || !analysis.evaluation.researchMode || analysis.evaluation.researchMode === "FULL")}
                        reviewing={reviewing}
                        showPurchaseScenarios={showPurchaseScenarios}
                        verifiedPurchase={Boolean(reviewed)}
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

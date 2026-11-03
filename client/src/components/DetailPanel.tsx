import { useEffect, useRef } from "react";
import type { AnalysisState } from "../analysis-state";
import type { ListingSummary, Targets } from "../types";
import { useNow } from "../useNow";
import { useDialog } from "../useDialog";
import { MONEY_CONFIG } from "../../../shared/money/config.ts";
import { PhotoGallery } from "./PhotoGallery";
import { PhotoReview, type DeeperReviewState } from "./PhotoReview";
import { SoldPriceScreening } from "./SoldPriceScreening";
import { AnalysisDetails } from "./analysis/AnalysisDetails";
import { FinancialDecision } from "./analysis/FinancialDecision";
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

                <div className={styles.detailActions}>
                    <a className={`${styles.primary} ${styles.listingLink}`} href={listing.url} target="_blank" rel="noopener noreferrer">Open on eBay ↗</a>
                    {onSave && <button type="button" className={styles.secondary} onClick={() => { if (!saving) onSave(); }} aria-disabled={saving} aria-pressed={saved}>{saving ? "Saving…" : saved ? "Remove from shortlist" : "Save to shortlist"}</button>}
                </div>
                <PhotoGallery images={analysis?.status === "done" ? analysis.evaluation.listing.photos ?? listing.images : listing.images} />
                {analysis?.status !== "done" && <SoldPriceScreening listing={listing} />}

                {analysis?.status === "done" && <FinancialDecision evaluation={analysis.evaluation} targets={targets} now={now} />}
                <PhotoReview listing={listing} evaluation={analysis?.status === "done" ? analysis.evaluation : null}
                    phase={analysis?.status === "loading" || analysis?.status === "error" ? analysis.status : undefined}
                    state={photoReviewState} onReview={unavailable ? undefined : onPhotoReview} />
                {unavailable && <p className={styles.bad}>Saved analysis only. This listing is unavailable or ended.</p>}

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
                    <AnalysisDetails
                        listing={listing}
                        evaluation={analysis.evaluation}
                        now={now}
                        minGrade={minGrade}
                        onReanalyze={() => onAnalyze(!analysis.evaluation.researchMode || analysis.evaluation.researchMode === "FULL")}
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

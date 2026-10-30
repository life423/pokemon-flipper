import type { Evaluation, ListingSummary } from "../types";
import { name } from "../format";
import { photoReviewStatus, planDeeperPhotos } from "../../../shared/photo-review.ts";
import styles from "./PhotoReview.module.css";

export type DeeperReviewState = { status: "loading"; key: string } | { status: "error"; key: string; message: string };
interface Props {
    evaluation: Evaluation | null;
    listing: ListingSummary;
    phase?: "loading" | "error";
    compact?: boolean;
    state?: DeeperReviewState;
    onReview?: () => void;
}
const dateText = (date: string | null | undefined) => date && Number.isFinite(Date.parse(date))
    ? new Date(date).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
export function PhotoReview({ evaluation, listing, phase, compact = false, state, onReview }: Props) {
    const status = photoReviewStatus(evaluation, listing);
    const current = state?.key === evaluation?.photoReviewKey ? state : undefined;
    const deep = evaluation?.deeperPhotoReview;
    const plan = evaluation ? planDeeperPhotos(evaluation.photoCheck, evaluation.listing.photos ?? listing.images) : null;
    const time = dateText(status.reviewedAt);
    return <section className={styles.review} aria-label="AI photo review">
        <p className={styles.title}>{phase === "loading" ? "AI reviewing listing photos…" : phase === "error" ? "AI photo review failed" : status.title}</p>
        {evaluation?.photoCheck && <p className={styles.meta}>{status.checked} of {status.total} photos checked · Photo confidence: {name(status.confidence)}{time ? ` · ${time}` : " · date unavailable"}</p>}
        {status.needsYourReview && <div className={styles.caution}>
            <strong>Your review needed</strong>
            {compact ? <p>{status.reasons[0]}</p> : <ul>{status.reasons.slice(0, 4).map((reason) => <li key={reason}>{reason}</li>)}</ul>}
        </div>}
        {compact && deep && <p className={styles.meta}>Deeper AI review saved{dateText(deep.reviewedAt) ? ` · ${dateText(deep.reviewedAt)}` : ""}</p>}
        {compact && current?.status === "loading" && <p className={styles.meta} role="status">Deeper AI review in progress; initial assessment still shown.</p>}
        {compact && current?.status === "error" && <p className={styles.caution}>Deeper review failed; initial assessment kept. Open analysis for details.</p>}
        {!compact && evaluation?.photoCheck && <>
            {deep ? <div className={styles.deep}>
                <h3>Deeper AI photo review</h3>
                <p className={styles.meta}>{deep.photoNumbers.length} photos examined · {dateText(deep.reviewedAt)} · saved result</p>
                <p>{deep.summary}</p>
                <p className={styles.meta}>This second opinion adds evidence notes. It does not raise the grade estimate, confidence or bid limit. New concerns pause purchase advice.</p>
                {deep.findings.map((finding, i) => <div className={styles.finding} key={i}>
                    <p><strong>{name(finding.area)}</strong> · {finding.impact === "NEW_CONCERN" ? "New concern — your review needed" : finding.impact === "SUPPORTS_PRIOR" ? "Supports earlier assessment" : "Still uncertain"}</p>
                    <p>{finding.observation}</p>
                    <p className={styles.meta}>Listing {finding.photoNumbers.length === 1 ? "photo" : "photos"} {finding.photoNumbers.join(", ")}</p>
                </div>)}
                {deep.requestedPhotos.length > 0 && <div><h4>Photos to request from the seller</h4><ul>{deep.requestedPhotos.map((photo) => <li key={photo}>{photo}</li>)}</ul></div>}
                <p className={styles.meta}>Reopening this saved review makes no AI request.</p>
            </div> : <div className={styles.action}>
                <p>Ask AI to focus on unresolved corners, edges, surface and printing evidence. Your current assessment stays visible.</p>
                <button type="button" onClick={onReview} disabled={!onReview || !evaluation.photoReviewKey || !plan?.photos.length || current?.status === "loading"}>
                    {current?.status === "loading" ? "AI reviewing details…" : "Deeper AI photo review · paid"}
                </button>
                <p className={styles.meta}>{!evaluation.photoReviewKey ? "Refresh the app and open the listing to enable a saved review." : plan?.reason ?? `One AI request using up to ${plan?.photos.length} existing photos. Results are saved; better seller photos may still be needed.`}</p>
                {current?.status === "error" && <p role="alert" className={styles.caution}>{current.message} Your previous assessment is still shown.</p>}
            </div>}
        </>}
    </section>;
}

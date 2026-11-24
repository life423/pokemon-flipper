import { useState, type ReactNode } from "react";
import { CheckIcon, ChevronIcon, InfoIcon, SearchIcon, StackIcon, StopIcon } from "./Icons";
import { Tween, wholeNumber } from "./Tween";
import styles from "./SearchProgress.module.css";

// Where a search is: finding listings on eBay, the free check, the AI,
// then done. Or stopped, or failed.
export type SearchPhase = "finding" | "filtering" | "ai" | "done" | "paused" | "stopped" | "error";

const STEPS = ["Find listings", "Check sold prices", "Review photos", "Finish results"];
const STEP_OF: Record<SearchPhase, number> = { finding: 0, filtering: 1, ai: 2, done: 4, paused: -1, stopped: -1, error: -1 };
const COLLAPSED_KEY = "searchProgressCollapsed";

interface Props {
    phase: SearchPhase;
    query: string;
    error: string | null;
    // eBay's total results for the search.
    ebayTotal: number | null;
    // The free check: listings checked of those that match the search.
    checked: number;
    total: number | null;
    discoveryProgress?: { found: number; screened: number };
    buyerProgress?: { finished: number; total: number; priorityDone: number; priorityTotal: number; priorityUnavailable?: number; priorityPhotos?: number; unavailable: number; active: number };
    ai: { done: number; target: number; analyzing: number; waiting: number; failed: number; inconclusive?: number; held?: number; paused?: boolean };
    stats: { junk: number; dropped: number; unchecked: number; deals: number };
    usage: { text: string; note: string; braking: boolean } | null;
    onStop: () => void;
    canStopAssessment: boolean;
    // Explicit additional analysis controls, within the current search budget.
    actions?: ReactNode;
    // Everything else, one tap down.
    details?: ReactNode;
}

function readCollapsed(): boolean {
    try {
        return localStorage.getItem(COLLAPSED_KEY) !== "0";
    } catch {
        return true;
    }
}

// The search's progress, expanded with every step and count, or collapsed
// to one line to leave room for results.
export function SearchProgress({ phase: requestedPhase, query, error, ebayTotal, checked, total, discoveryProgress, ai, buyerProgress, stats, usage, onStop, canStopAssessment, actions, details }: Props) {
    const [collapsed, setCollapsed] = useState(readCollapsed);
    const listingWork = requestedPhase === "finding" || requestedPhase === "filtering";
    // A paid-AI pause does not stop the independently bounded metadata stream.
    // Keep its progress and Stop action while the photo status reports the pause.
    const buyerWork = buyerProgress && buyerProgress.finished + buyerProgress.unavailable < buyerProgress.total;
    const phase = requestedPhase === "stopped" || requestedPhase === "error" ? requestedPhase
        : requestedPhase === "paused" || ai.paused && !listingWork ? "paused"
        : requestedPhase === "done" && buyerWork && buyerProgress.active > 0 ? "ai" : requestedPhase;

    const toggle = () => {
        setCollapsed((now) => {
            try {
                localStorage.setItem(COLLAPSED_KEY, now ? "0" : "1");
            } catch {
                // Without storage it resets next visit.
            }
            return !now;
        });
    };

    const running = phase === "finding" || phase === "filtering" || phase === "ai";
    const halted = phase === "paused" || phase === "stopped" || phase === "error";
    const step = STEP_OF[phase];
    const analyzing = phase === "error" && !canStopAssessment ? 0 : ai.analyzing;
    const aiState = phase === "stopped" ? "stopped" : phase === "paused" || ai.paused ? "paused" : analyzing > 0 ? "working" : "idle";
    const inconclusive = ai.inconclusive ?? 0;
    const held = ai.held ?? 0;
    const completed = Math.max(0, ai.done - ai.failed - inconclusive - held);
    const priority = buyerProgress && buyerProgress.priorityTotal > 0
        ? `${buyerProgress.priorityDone.toLocaleString()} of ${buyerProgress.priorityTotal.toLocaleString()} priority listings checked` : null;
    const decisions = buyerProgress && `${buyerProgress.finished.toLocaleString()} of ${buyerProgress.total.toLocaleString()} buyer decisions ready`;
    const priorityRemaining = buyerProgress
        ? buyerProgress.priorityTotal - buyerProgress.priorityDone - (buyerProgress.priorityUnavailable ?? 0) : 0;
    const buyerTask = buyerProgress && (priorityRemaining > 0 ? "Checking priority listings" : "Sorting remaining listings");
    const loaded = `${checked.toLocaleString()} ${checked === 1 ? "listing" : "listings"} loaded`;
    const assessed = `${completed.toLocaleString()} ${completed === 1 ? "assessment" : "assessments"} completed`;
    const aiStatus = aiState === "stopped" ? "Photo reviews stopped"
        : aiState === "paused" ? "Photo reviews paused"
        : aiState === "working" ? `Reviewing ${analyzing.toLocaleString()} ${analyzing === 1 ? "card" : "cards"}`
        : listingWork ? "Checking listing matches and prices" : "No photo reviews running";
    const awaiting = ai.waiting > 0
        ? `${ai.waiting.toLocaleString()} ${ai.waiting === 1 ? "listing awaits" : "listings await"} assessment.`
        : "";

    // How far along: the free check while it runs, then the AI.
    const buyerFraction = buyerProgress && buyerProgress.total > 0 ? (buyerProgress.finished + buyerProgress.unavailable) / buyerProgress.total : null;
    const percent =
        phase === "finding" || listingWork && discoveryProgress
            ? null
            : phase === "ai"
              ? buyerProgress ? buyerFraction : ai.target > 0
                  ? ai.done / ai.target
                  : 1
              : phase === "done"
                ? 1
                : total
                  ? checked / total
                  : 0;
    const percentText = halted || percent === null ? "" : `${Math.round(percent * 100)}%`;

    const title = {
        finding: "Searching eBay",
        filtering: "Checking listings and sold prices",
        ai: buyerTask || "Reviewing photos",
        done: "Search complete",
        paused: buyerProgress ? "Listing checks paused" : "Photo reviews paused",
        stopped: "Search stopped",
        error: "Search incomplete",
    }[phase];

    const subtitle =
        phase === "error"
            ? `${loaded} · ${assessed}`
            : phase === "done"
              ? `${loaded} · ${assessed} for “${query}”`
              : phase === "stopped"
                ? discoveryProgress ? `Stopped after ${discoveryProgress.screened.toLocaleString()} preliminary listing checks.`
                    : `Stopped after ${checked.toLocaleString()} of ${(total ?? checked).toLocaleString()} checks. Saved results remain available.`
                : phase === "paused" ? `New photo checks are paused for “${query}”. Saved results remain available.`
                : phase === "ai"
                  ? `Checking the best candidates for \u201c${query}\u201d`
                  : `Scanning listings for \u201c${query}\u201d`;

    const caption =
        discoveryProgress
            ? `${discoveryProgress.screened.toLocaleString()} preliminary listing checks completed`
            : phase === "ai"
            ? `${ai.done} of ${ai.target} analysis attempts finished`
            : phase === "finding"
              ? "Finding listings..."
            : phase === "done"
              ? loaded
              : `${checked.toLocaleString()} of ${(total ?? 0).toLocaleString()} checks completed`;

    // What's happening right now, in a few words.
    const activity =
            phase === "stopped" ? "New checks are stopped. Already accepted answers can still finish and save."
            : phase === "paused" ? `New photo assessments are paused. ${awaiting ? `${awaiting} These listings have not failed verification. ` : ""}Completed assessments and search results remain available.`
            : phase === "error" ? "The search ended early. Automatic assessments stopped, and results checked so far are kept."
            : ai.paused && listingWork ? "Listing checks are still running. New photo assessments are paused; unassessed listings remain preliminary."
            : ai.analyzing > 0 ? `${aiStatus}. Results appear as each assessment finishes.`
            : phase === "finding"
            ? "Searching eBay..."
            : phase === "filtering"
                ? "Checking listing matches and recent sold evidence before photo assessment."
                : ai.waiting > 0
                  ? awaiting
                  : ai.failed > 0
                      ? `${ai.failed} ${ai.failed === 1 ? "assessment failed" : "assessments failed"}; see Wait or skip.`
                      : "Automatic analysis finished. Screened-only listings have not had full photo analysis.";

    const compact = discoveryProgress
        ? `${discoveryProgress.found.toLocaleString()} listings found · ${discoveryProgress.screened.toLocaleString()} preliminary checks completed`
        : `${loaded} · ${decisions || assessed} · ${stats.deals} ${stats.deals === 1 ? "deal" : "deals"}`;
    const showAssessmentStatus = phase !== "done" || analyzing > 0 || ai.waiting > 0 || ai.failed > 0 || inconclusive > 0 || held > 0;

    const buyerLabel = buyerProgress && (phase === "stopped" ? "Listing checks stopped" : phase === "error" ? "Search ended early"
        : phase === "paused" ? "Listing checks paused" : buyerProgress.active > 0 ? `Checking ${buyerProgress.active} ${buyerProgress.active === 1 ? "listing" : "listings"}`
        : listingWork ? "Checking listing matches and prices" : null);
    const unavailableLabel = buyerProgress?.unavailable
        ? `${buyerProgress.unavailable.toLocaleString()} ${buyerProgress.unavailable === 1 ? "check" : "checks"} unavailable` : null;
    const buyerActivity = buyerProgress && (listingWork ? "Finding listings and checking their selling prices."
        : phase === "paused" || phase === "stopped" || phase === "error" ? "Completed decisions remain available in results."
        : buyerProgress.active > 0 && priorityRemaining > 0 ? "The strongest candidates get the first checks."
        : buyerProgress.active > 0 ? "Checking the remaining listings against your buying criteria."
        : decisions);

    return (
        <section
            className={`${styles.card} ${collapsed ? styles.collapsed : ""}`}
            data-phase={phase}
            aria-label="Search progress"
        >
            <div className={styles.head}>
                <span className={styles.badge}>{phase === "done" ? <CheckIcon /> : halted ? <StopIcon /> : <SearchIcon />}</span>

                <div className={styles.titles} aria-live="polite">
                    <h2 className={styles.title}>{title}</h2>
                    <p className={styles.sub}>{collapsed || buyerProgress || discoveryProgress ? compact : subtitle}</p>
                    {collapsed && running && <ProgressBar percent={percent} thin />}
                </div>

                {(running || canStopAssessment) && (
                    <button
                        type="button"
                        className={`${styles.iconButton} ${styles.stop}`}
                        onClick={onStop}
                        aria-label="Stop search"
                        title="Stop search"
                    >
                        <StopIcon />
                    </button>
                )}
                <button
                    type="button"
                    className={`${styles.iconButton} ${styles.toggle}`}
                    onClick={toggle}
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? "Show search progress" : "Hide search progress"}
                >
                    <ChevronIcon />
                </button>
            </div>

            {/* Full photo work overlaps searching, and stays visible
                when the optional search details are collapsed. */}
            {buyerProgress && (buyerLabel || priority || unavailableLabel) && <div className={styles.aiStatus}
                data-ai-state={halted ? "paused" : buyerProgress.active > 0 ? "working" : "idle"} aria-label="Buyer decision progress" aria-live="polite">
                {buyerLabel && <span className={styles.aiStatusLabel}>{buyerLabel}</span>}
                {priority && <span className={styles.aiStatusCount}>{priority}</span>}
                {priority && buyerProgress.priorityPhotos !== undefined && <span className={styles.aiStatusCount}>
                    {buyerProgress.priorityPhotos.toLocaleString()} with photo assessments
                </span>}
                {unavailableLabel && <span className={styles.aiStatusCount}>{unavailableLabel}</span>}
            </div>}
            {!buyerProgress && showAssessmentStatus && <div className={styles.aiStatus} data-ai-state={aiState} aria-label="Photo assessment progress" aria-live="polite">
                <span className={styles.aiStatusLabel}>
                    {aiState === "working" && <span className={styles.dots} aria-hidden="true"><span /><span /><span /></span>}
                    {aiStatus}
                </span>
                {ai.waiting > 0 && <span className={styles.aiStatusCount}>{ai.waiting.toLocaleString()} awaiting assessment</span>}
                {(halted || ai.paused) && analyzing > 0 && aiState !== "working" && <span className={styles.aiStatusCount}>{analyzing.toLocaleString()} in progress</span>}
                {held > 0 && <span className={styles.aiStatusCount}>{held.toLocaleString()} on hold</span>}
                {inconclusive > 0 && <span className={styles.aiStatusCount}>{inconclusive.toLocaleString()} inconclusive</span>}
                {ai.failed > 0 && <span className={styles.aiStatusCount}>{ai.failed.toLocaleString()} failed</span>}
                {ai.paused && listingWork && <span>Listing checks are still running.</span>}
            </div>}
            {phase === "error" && <p className={styles.error} role="alert">{error ?? "The search ended early. Saved results remain available."}</p>}

            {/* Expands and collapses smoothly; hidden from tabbing when collapsed. */}
            <div className={styles.body} inert={collapsed}>
                <div className={styles.bodyInner}>
                    <div className={styles.content}>
                        {!halted && (
                            <ol className={styles.steps}>
                                {STEPS.map((label, index) => {
                                    const state =
                                        index < step || step === 4 ? "complete" : index === step ? "current" : "pending";
                                    return (
                                        <li key={label} data-state={state}>
                                            <span className={styles.node}>{state === "complete" && <CheckIcon />}</span>
                                            <span className={styles.stepLabel}>{buyerProgress && index === 2 ? "Check priority listings" : label}</span>
                                        </li>
                                    );
                                })}
                            </ol>
                        )}

                        {!halted && (
                            <div className={styles.progress}>
                                <div className={styles.progressRow}>
                                    <ProgressBar percent={percent} />
                                    <span className={styles.percent}>{percentText}</span>
                                </div>
                                <div className={styles.captions}>
                                    <span>{buyerProgress && !listingWork ? decisions : caption}</span>
                                    {ebayTotal !== null && <span>{ebayTotal.toLocaleString()} eBay results found</span>}
                                </div>
                            </div>
                        )}

                        <dl className={styles.stats}>
                            <div>
                                <dt>Junk skipped</dt>
                                <dd>
                                    <Tween value={stats.junk} format={wholeNumber} />
                                </dd>
                            </div>
                            <div>
                                <dt>Above target in screening</dt>
                                <dd>
                                    <Tween value={stats.dropped} format={wholeNumber} />
                                </dd>
                            </div>
                            <div>
                                <dt title="Preliminary checks have not finished. This is not a count of failed assessments.">Screening incomplete</dt>
                                <dd>
                                    <Tween value={stats.unchecked} format={wholeNumber} />
                                </dd>
                            </div>
                            <div>
                                <dt>Deals found</dt>
                                <dd className={stats.deals > 0 ? styles.deals : undefined}>
                                    <Tween value={stats.deals} format={wholeNumber} />
                                </dd>
                            </div>
                        </dl>

                        <div className={styles.activity}>
                            <p>
                                {!halted && (running || ai.analyzing > 0) && (
                                    <span className={styles.dots} aria-hidden="true">
                                        <span />
                                        <span />
                                        <span />
                                    </span>
                                )}
                                {buyerActivity || activity}
                            </p>
                            {usage && (
                                <span
                                    className={`${styles.usage} ${usage.braking ? styles.braking : ""}`}
                                    title={usage.note}
                                >
                                    <StackIcon />
                                    {usage.text}
                                    <InfoIcon className={styles.info} />
                                </span>
                            )}
                        </div>

                        {!halted && actions}

                        {details && (
                            <details className={styles.details}>
                                <summary>
                                    Search details
                                    <ChevronIcon />
                                </summary>
                                <div className={styles.detailsBody}>{details}</div>
                            </details>
                        )}
                    </div>
                </div>
            </div>
        </section>
    );
}

// A bar that fills to the percent; with no percent yet, a moving shimmer.
function ProgressBar({ percent, thin = false }: { percent: number | null; thin?: boolean }) {
    return (
        <div
            className={`${styles.bar} ${thin ? styles.thin : ""}`}
            role="progressbar"
            aria-label="Search completion"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent === null ? undefined : Math.round(percent * 100)}
        >
            <span
                className={`${styles.fill} ${percent === null ? styles.indeterminate : ""}`}
                style={percent === null ? undefined : { width: `${Math.max(2, percent * 100)}%` }}
            />
        </div>
    );
}

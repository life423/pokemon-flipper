import { useState, type ReactNode } from "react";
import { CheckIcon, ChevronIcon, InfoIcon, SearchIcon, StackIcon, StopIcon } from "./Icons";
import { Tween, wholeNumber } from "./Tween";
import styles from "./SearchProgress.module.css";

// Where a search is: finding listings on eBay, the free check, the AI,
// then done. Or stopped, or failed.
export type SearchPhase = "finding" | "filtering" | "ai" | "done" | "paused" | "stopped" | "error";

const STEPS = ["Finding listings", "Filtering listings", "AI analysis", "Finalizing results"];
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
    ai: { done: number; target: number; analyzing: number; waiting: number; failed: number; paused?: boolean };
    stats: { junk: number; dropped: number; unchecked: number; deals: number };
    usage: { text: string; note: string; braking: boolean } | null;
    onStop: () => void;
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
export function SearchProgress({ phase: requestedPhase, query, error, ebayTotal, checked, total, ai, stats, usage, onStop, actions, details }: Props) {
    const [collapsed, setCollapsed] = useState(readCollapsed);
    const listingWork = requestedPhase === "finding" || requestedPhase === "filtering";
    // A paid-AI pause does not stop the independently bounded metadata stream.
    // Keep its progress and Stop action, while the AI strip reports the pause.
    const phase = requestedPhase === "stopped" || requestedPhase === "error" ? requestedPhase
        : requestedPhase === "paused" || ai.paused && !listingWork ? "paused" : requestedPhase;

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
    const aiState = phase === "stopped" ? "stopped" : phase === "error" ? "idle" : phase === "paused" || ai.paused ? "paused" : ai.analyzing > 0 ? "working" : "idle";
    const completed = Math.max(0, ai.done - ai.failed);
    const aiStatus = aiState === "stopped" ? "AI analysis stopped"
        : aiState === "paused" ? "AI analysis paused"
        : aiState === "working" ? `AI assessing ${ai.analyzing.toLocaleString()} ${ai.analyzing === 1 ? "card" : "cards"}`
        : "No full card assessments running";
    const awaiting = ai.waiting > 0
        ? `${ai.waiting.toLocaleString()} ${ai.waiting === 1 ? "listing awaits" : "listings await"} AI assessment.`
        : "";

    // How far along: the free check while it runs, then the AI.
    const percent =
        phase === "finding"
            ? null
            : phase === "ai"
              ? ai.target > 0
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
        ai: "AI analysis",
        done: "Search complete",
        paused: "Analysis paused",
        stopped: "Search stopped",
        error: "Search failed",
    }[phase];

    const subtitle =
        phase === "error"
            ? (error ?? "Something went wrong.")
            : phase === "done"
              ? `${checked.toLocaleString()} listing and photo checks for \u201c${query}\u201d`
              : phase === "stopped"
                ? `Stopped after ${checked.toLocaleString()} of ${(total ?? checked).toLocaleString()} checks. Results so far stay below.`
                : phase === "paused" ? `New checks are stopped for “${query}”. Results checked so far stay below.`
                : phase === "ai"
                  ? `Checking the best candidates for \u201c${query}\u201d`
                  : `Scanning listings for \u201c${query}\u201d`;

    const caption =
        phase === "ai"
            ? `${ai.done} of ${ai.target} analysis attempts finished`
            : phase === "finding"
              ? "Finding listings..."
            : phase === "done"
              ? `${checked.toLocaleString()} checks completed`
              : `${checked.toLocaleString()} of ${(total ?? 0).toLocaleString()} checks completed`;

    // What's happening right now, in a few words.
    const activity =
            phase === "stopped" ? "New checks are stopped. Already accepted AI answers can still finish and save."
            : phase === "paused" ? `New AI assessments are paused. ${awaiting ? `${awaiting} These listings have not failed verification. ` : ""}Completed assessments and search results stay below.`
            : phase === "error" ? "The search could not finish. Any results checked so far are kept."
            : ai.paused && listingWork ? "Listing checks are still running. New AI assessments are paused; unassessed listings remain preliminary."
            : ai.analyzing > 0 ? `${aiStatus}. Results appear as each assessment finishes.`
            : phase === "finding"
            ? "Searching eBay..."
            : phase === "filtering"
                ? "Checking listing matches and recent sold evidence before full AI assessment..."
                : ai.waiting > 0
                  ? awaiting
                  : ai.failed > 0
                      ? `${ai.failed} AI ${ai.failed === 1 ? "analysis failed" : "analyses failed"}; see Review.`
                      : "Automatic analysis finished. Screened-only listings have not had full photo analysis.";

    const compact =
        phase === "error"
            ? (error ?? "Search failed")
            : [
                  phase === "done" ? "" : percentText,
                  phase === "done" ? `${checked.toLocaleString()} checks` : `${checked.toLocaleString()}/${(total ?? 0).toLocaleString()} checked`,
                  `${stats.deals} ${stats.deals === 1 ? "deal" : "deals"} found`,
              ]
                  .filter(Boolean)
                  .join(" \u00b7 ");

    return (
        <section
            className={`${styles.card} ${collapsed ? styles.collapsed : ""}`}
            data-phase={phase}
            aria-live="polite"
            aria-label="Search progress"
        >
            <div className={styles.head}>
                <span className={styles.badge}>{phase === "done" ? <CheckIcon /> : halted ? <StopIcon /> : <SearchIcon />}</span>

                <div className={styles.titles}>
                    {collapsed ? (
                        <>
                            <p className={styles.compactTitle}>
                                {phase === "done" ? "Done:" : phase === "paused" ? "Analysis paused:" : phase === "stopped" ? "Stopped:" : phase === "error" ? "Search incomplete:" : phase === "ai" ? "AI assessing" : "Searching"} “{query}”
                            </p>
                            <p className={styles.sub}>{compact}</p>
                            {!halted && <ProgressBar percent={percent} thin />}
                        </>
                    ) : (
                        <>
                            <h2 className={styles.title}>{title}</h2>
                            <p className={styles.sub}>{subtitle}</p>
                        </>
                    )}
                </div>

                {running && (
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
            <div className={styles.aiStatus} data-ai-state={aiState} aria-label="AI assessment progress">
                <span className={styles.aiStatusLabel}>
                    {aiState === "working" && <span className={styles.dots} aria-hidden="true"><span /><span /><span /></span>}
                    {aiStatus}
                </span>
                <span className={styles.aiStatusCount}>{completed.toLocaleString()} completed</span>
                {ai.waiting > 0 && <span className={styles.aiStatusCount}>{ai.waiting.toLocaleString()} awaiting analysis</span>}
                {(halted || ai.paused) && ai.analyzing > 0 && <span className={styles.aiStatusCount}>{ai.analyzing.toLocaleString()} in progress</span>}
                {ai.failed > 0 && <span className={styles.aiStatusCount}>{ai.failed.toLocaleString()} failed</span>}
            </div>

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
                                            <span className={styles.stepLabel}>{label}</span>
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
                                    <span>{caption}</span>
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
                                <dt title="Preliminary checks have not finished. This is not a count of failed AI assessments.">Screening incomplete</dt>
                                <dd>
                                    <Tween value={stats.unchecked} format={wholeNumber} />
                                </dd>
                            </div>
                            <div>
                                <dt>Deals found</dt>
                                <dd className={styles.deals}>
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
                                {activity}
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

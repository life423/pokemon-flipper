import { useState, type ReactNode } from "react";
import { CheckIcon, ChevronIcon, InfoIcon, SearchIcon, StackIcon, StopIcon } from "./Icons";
import { Tween, wholeNumber } from "./Tween";
import styles from "./SearchProgress.module.css";

// Where a search is: finding listings on eBay, the free check, the AI,
// then done. Or stopped, or failed.
export type SearchPhase = "finding" | "filtering" | "ai" | "done" | "stopped" | "error";

const STEPS = ["Finding listings", "Filtering listings", "AI analysis", "Finalizing results"];
const STEP_OF: Record<SearchPhase, number> = { finding: 0, filtering: 1, ai: 2, done: 4, stopped: -1, error: -1 };
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
    ai: { done: number; target: number; analyzing: number; waiting: number };
    stats: { junk: number; dropped: number; unchecked: number; deals: number };
    usage: { text: string; note: string; braking: boolean } | null;
    onStop: () => void;
    // The buttons that apply right now (Analyze more, Dig deeper) and the dig's status.
    actions?: ReactNode;
    // Everything else, one tap down.
    details?: ReactNode;
}

function readCollapsed(): boolean {
    try {
        return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
        return false;
    }
}

// The search's progress, expanded with every step and count, or collapsed
// to one line to leave room for results.
export function SearchProgress({ phase, query, error, ebayTotal, checked, total, ai, stats, usage, onStop, actions, details }: Props) {
    const [collapsed, setCollapsed] = useState(readCollapsed);

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
    const step = STEP_OF[phase];

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
    const percentText = percent === null ? "" : `${Math.round(percent * 100)}%`;

    const title = {
        finding: "Searching eBay",
        filtering: "Searching eBay",
        ai: "AI analysis",
        done: "Search complete",
        stopped: "Search stopped",
        error: "Search failed",
    }[phase];

    const subtitle =
        phase === "error"
            ? (error ?? "Something went wrong.")
            : phase === "done"
              ? `${checked.toLocaleString()} listings checked for \u201c${query}\u201d`
              : phase === "stopped"
                ? `Stopped after ${checked.toLocaleString()} of ${(total ?? checked).toLocaleString()} listings. Results so far stay below.`
                : phase === "ai"
                  ? `Checking the best candidates for \u201c${query}\u201d`
                  : `Scanning listings for \u201c${query}\u201d`;

    const caption =
        phase === "ai"
            ? `${ai.done} of ${ai.target} candidates analyzed`
            : phase === "finding"
              ? "Finding listings..."
              : `${checked.toLocaleString()} of ${(total ?? 0).toLocaleString()} candidates checked`;

    // What's happening right now, in a few words.
    const activity =
        phase === "finding"
            ? "Searching eBay..."
            : ai.analyzing > 0
              ? `AI analyzing ${ai.analyzing} ${ai.analyzing === 1 ? "candidate" : "candidates"}...`
              : phase === "filtering"
                ? "Checking listings for free..."
                : ai.waiting > 0
                  ? `${ai.waiting} ${ai.waiting === 1 ? "candidate is" : "candidates are"} waiting for the AI.`
                  : phase === "stopped"
                    ? "Nothing more is being checked."
                    : "The AI has looked at every candidate.";

    const compact =
        phase === "error"
            ? (error ?? "Search failed")
            : [
                  percentText,
                  `${checked.toLocaleString()}/${(total ?? 0).toLocaleString()} checked`,
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
                <span className={styles.badge}>{phase === "done" ? <CheckIcon /> : <SearchIcon />}</span>

                <div className={styles.titles}>
                    {collapsed ? (
                        <>
                            <p className={styles.compactTitle}>
                                {phase === "done" ? "Done:" : phase === "stopped" ? "Stopped:" : "Searching"} “{query}”
                            </p>
                            <p className={styles.sub}>{compact}</p>
                            {phase !== "error" && <ProgressBar percent={percent} thin />}
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

            {/* Expands and collapses smoothly; hidden from tabbing when collapsed. */}
            <div className={styles.body} inert={collapsed}>
                <div className={styles.bodyInner}>
                    <div className={styles.content}>
                        {phase !== "error" && (
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

                        {phase !== "error" && (
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
                                <dt>Too expensive</dt>
                                <dd>
                                    <Tween value={stats.dropped} format={wholeNumber} />
                                </dd>
                            </div>
                            <div>
                                <dt>Couldn't verify</dt>
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
                                {(running || ai.analyzing > 0) && (
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

                        {actions}

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

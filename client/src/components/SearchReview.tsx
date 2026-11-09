import { useEffect, useRef, useState } from "react";
import type { SearchDiagnosticResult } from "../../../shared/search-diagnostic.ts";
import { aiCents } from "./AiBudgetStatus";
import styles from "./SearchReview.module.css";

export function SearchReview({ ready, onReview }: {
    ready: boolean;
    onReview: (signal: AbortSignal) => Promise<SearchDiagnosticResult>;
}) {
    const [result, setResult] = useState<SearchDiagnosticResult | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [copyFeedback, setCopyFeedback] = useState("");
    const activeRequest = useRef<AbortController | null>(null);
    const attempted = useRef(false);
    const request = useRef(onReview);
    request.current = onReview;
    useEffect(() => () => activeRequest.current?.abort(), []);
    useEffect(() => {
        if (!ready || attempted.current) return;
        // Defer the side effect until the settled view commits. Strict Mode
        // and transient readiness changes can clear the timer before dispatch.
        const timer = window.setTimeout(async () => {
            attempted.current = true;
            const controller = new AbortController();
            activeRequest.current = controller;
            setBusy(true);
            try {
                const report = await request.current(controller.signal);
                if (!controller.signal.aborted) setResult(report);
            } catch (cause) {
                if (!controller.signal.aborted) {
                    setError(cause instanceof Error ? cause.message : "Could not review this search.");
                }
            } finally {
                if (activeRequest.current === controller) activeRequest.current = null;
                if (!controller.signal.aborted) setBusy(false);
            }
        }, 0);
        return () => window.clearTimeout(timer);
    }, [ready]);

    async function copy() {
        if (!result) return;
        try {
            await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
            setCopyFeedback("Review copied for Codex.");
        } catch {
            setCopyFeedback("Clipboard access is unavailable. You can select and copy the review text below.");
        }
    }

    return <section className={styles.panel} aria-label="Search review">
        <div className={styles.header}>
            <div>
                <h2>Search review</h2>
                <p>The app records why listings stopped and suggests checks for Codex. The review has a separate AI budget.</p>
            </div>
            {result && <button type="button" onClick={() => void copy()}>Copy review for Codex</button>}
        </div>
        {busy && <p role="status">Reviewing recorded listing decisions.</p>}
        {!ready && !busy && !result && !error && <p>Wait for listing assessments to finish.</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {copyFeedback && <p role="status">{copyFeedback}</p>}
        {result?.message && <p role="status">{result.message}</p>}
        {result?.reviewBudget?.capUsd != null && <p className={styles.cost}>Review cost {aiCents(result.reviewBudget.settledUsd)} of {aiCents(result.reviewBudget.capUsd)}.</p>}
        {result?.review && <div className={styles.report}>
            <p role="status">{result.review.summary}</p>
            {result.review.proposedTasks.length > 0 && <details>
                <summary>Suggested checks ({result.review.proposedTasks.length})</summary>
                <ol className={styles.tasks}>
                    {result.review.proposedTasks.map((task, index) => <li key={index}>
                        <h3>{task.title}</h3>
                        <p>{task.evidence}</p>
                        <p>{task.proposedFix}</p>
                        <ul>{task.checks.map((check, checkIndex) => <li key={checkIndex}>{check}</li>)}</ul>
                        {task.exampleRows?.length ? <p className={styles.cost}>Saved listing {task.exampleRows.length === 1 ? "reference" : "references"} {task.exampleRows.join(", ")}.</p> : null}
                    </li>)}
                </ol>
            </details>}
        </div>}
    </section>;
}

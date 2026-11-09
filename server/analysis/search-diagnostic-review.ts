import { withAiUsageContext } from "../ai/usage-context.ts";
import { assertSqlStorageReady, storageBackend } from "../storage/index.ts";
import { SEARCH_DIAGNOSTIC_CONFIDENCE, SEARCH_DIAGNOSTIC_EVIDENCE_GROUPS, type SearchDiagnosticReview } from "../../shared/search-diagnostic.ts";
import { createModelExperimentRunner } from "./model-experiment.ts";

export const SEARCH_DIAGNOSTIC_MODEL = "gpt-6-luna";
const SEARCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reviewSchema(exampleCount: number | undefined) {
    const examples = exampleCount === undefined ? {} : {
        exampleRows: { type: "array", maxItems: Math.min(3, exampleCount), items: { type: "integer", minimum: 1, maximum: Math.max(1, exampleCount) } },
    };
    return {
        type: "object", additionalProperties: false, required: ["summary", "proposedTasks"],
        properties: {
            summary: { type: "string" },
            proposedTasks: { type: "array", maxItems: 3, items: {
                type: "object", additionalProperties: false,
                required: ["title", "evidenceGroup", "evidence", "proposedFix", "confidence", "checks", ...Object.keys(examples)],
                properties: { title: { type: "string" }, evidenceGroup: { type: "string", enum: SEARCH_DIAGNOSTIC_EVIDENCE_GROUPS },
                    evidence: { type: "string" }, proposedFix: { type: "string" }, confidence: { type: "string", enum: SEARCH_DIAGNOSTIC_CONFIDENCE },
                    checks: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } }, ...examples },
            } },
        },
    };
}

const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const shortText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 900;

function validateReview(value: unknown, exampleCount: number | undefined): SearchDiagnosticReview {
    const { summary, proposedTasks } = record(value);
    if (!shortText(summary) || !Array.isArray(proposedTasks) || proposedTasks.length > 3) throw new Error("Invalid diagnostic review.");
    return { summary, proposedTasks: proposedTasks.map(value => {
        const { title, evidence, proposedFix, checks, exampleRows, evidenceGroup: group, confidence: level } = record(value);
        const evidenceGroup = SEARCH_DIAGNOSTIC_EVIDENCE_GROUPS.find(allowed => allowed === group);
        const confidence = SEARCH_DIAGNOSTIC_CONFIDENCE.find(allowed => allowed === level);
        if (!shortText(title) || !shortText(evidence) || !shortText(proposedFix) || !evidenceGroup || !confidence ||
            !Array.isArray(checks) || checks.length < 1 || checks.length > 3 || !checks.every(shortText)) throw new Error("Invalid proposed diagnostic task.");
        const task = { title, evidenceGroup, evidence, proposedFix, confidence, checks };
        if (exampleCount === undefined) return task;
        if (!Array.isArray(exampleRows) || exampleRows.length > 3 || new Set(exampleRows).size !== exampleRows.length ||
            !exampleRows.every(row => Number.isSafeInteger(row) && row >= 1 && row <= exampleCount)) {
            throw new Error("A proposed diagnostic task refers to unavailable example rows.");
        }
        return { ...task, exampleRows };
    }) };
}

// Keep the original CLI request stable so previous paid answers stay reusable.
const CLI_INSTRUCTIONS = "Review these saved search aggregates for actionable causes of missed or unverified opportunities. " +
    "Return at most three proposed Codex tasks for human review with observed evidence, a bounded fix or investigation, confidence, and offline verification checks. " +
    "The lower-price pass counts new source rows before matching and sold-price screening. Its added assessment candidates were eligible for possible follow-up, and their count says nothing about whether photos were reviewed or a deal was verified. " +
    "Supplemental review holds count resolved rechecks separately from still-unresolved listings. The loss count only describes resolved rechecks; zero losses with zero resolved rechecks leaves the economics unknown. " +
    "Distinguish observations from hypotheses. Price exclusions may be correct. Preserve profitable evidence standards, existing per-search limits and saved assessments. " +
    "The report's original AI cap applies to this search; the app's newer 25-cent cap applies only to new searches. " +
    "Do not invent sales or imply an assessed loss is a deal. Do not return executable commands or instructions to act without review.";

const APP_INSTRUCTIONS = "Review this completed app search for actionable causes of missed or unverified opportunities. " +
    "Return up to three prioritized diagnostic tasks with observed evidence, a bounded fix or investigation, confidence, and offline verification checks. " +
    "Treat source and screening counts as search funnel totals. Retained row decisions are the browser's observed outcomes and may not represent all marketplace inventory. The lower-price pass can discover listings before matching them. " +
    "Distinguish observed facts from hypotheses. Price exclusions may be correct, and missing evidence does not prove a deal was missed. Return no tasks if the evidence supports none. " +
    "Use exampleRows only for actual numbered examples in the supplied evidence, with at most three distinct numbers per task. Use an empty array when there is no relevant example. " +
    "Preserve profitable evidence standards, spending limits and saved assessments. Do not invent sales, code locations, or listing identities. Do not return executable commands or instructions to act without review.";

const experiment = createModelExperimentRunner();

export async function runSearchDiagnosticReview({ searchId, budgetSearchId, evidence, exampleCount, signal }: {
    searchId: string;
    budgetSearchId: string;
    /** Use only sanitized counts, fixed labels, and anonymous examples. */
    evidence: Readonly<Record<string, unknown>>;
    exampleCount?: number;
    signal?: AbortSignal;
}) {
    if (!SEARCH_ID.test(searchId) || !SEARCH_ID.test(budgetSearchId) ||
        exampleCount !== undefined && (!Number.isSafeInteger(exampleCount) || exampleCount < 0 || exampleCount > 50)) {
        throw new Error("A diagnostic review requires valid search IDs and bounded examples.");
    }
    signal?.throwIfAborted();
    if (storageBackend() !== "azure-sql") throw new Error("Live diagnostic reviews require the app's shared SQL dispatch protection.");
    await assertSqlStorageReady();
    signal?.throwIfAborted();

    const browserReview = exampleCount !== undefined;
    const answer = await withAiUsageContext({ searchId: budgetSearchId }, () => experiment({
        sourceKey: `${browserReview ? "app-search-diagnostic-review" : "search-diagnostic-review"}:v1:${searchId}`,
        model: SEARCH_DIAGNOSTIC_MODEL,
        validate: value => validateReview(value, exampleCount),
        signal,
        request: {
            step: "Search diagnostic review", schemaName: "search_diagnostic_review", schema: reviewSchema(exampleCount),
            maxOutputTokens: 1000, photos: [], prompt: JSON.stringify(evidence),
            instructions: browserReview ? APP_INSTRUCTIONS : CLI_INSTRUCTIONS,
        },
    }));
    return { review: answer.result, usage: answer.usage, reused: answer.reused };
}

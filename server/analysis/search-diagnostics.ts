import { getAiUsageContext } from "../ai/usage-context.ts";
import { createHash } from "node:crypto";
import type { AiSearchBudget, AiUsageStage } from "../../shared/ai-usage.ts";
import type { PricingResearchUsage } from "../../shared/pricing-usage.ts";
import type { SearchDiagnosticDiscovery, SearchDiagnosticResult, SearchDiagnosticRow } from "../../shared/search-diagnostic.ts";
import { aiSpending } from "../ai/spending.ts";
import { aiUsageToday } from "../ai/usage.ts";
import { browseSearchAllowance } from "../ebay/search-budget.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { priceResearchSummary } from "../pricing/research-budget.ts";
import { APP_REVIEW_OUTPUT_TOKENS, runSearchDiagnosticReview } from "./search-diagnostic-review.ts";
import { createSearchDiagnosticStore } from "./search-diagnostic-store.ts";

// One stable allowance per completed scan. The normal generation guard applies
// its configured ceiling to this account, independently of listing assessment.
function reviewAccount(searchId: string): string {
    const hash = createHash("sha256").update(`pokemon-flipper:search-review:${searchId}`).digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

interface SearchUsage {
    // Pin the request to its snapshot so reopening an older search reuses the same dispatch key.
    reviewOutputTokens?: number;
    budget: AiSearchBudget | null;
    stages: Pick<AiUsageStage, "step" | "calls" | "failed">[];
    ebayBrowseRequests: number | null;
    pricing: PricingResearchUsage | null;
}

async function usageFor(searchId: string): Promise<SearchUsage> {
    const [budget, ai, browse, pricing] = await Promise.allSettled([
        aiSpending.summary(searchId), aiUsageToday(searchId), browseSearchAllowance(), priceResearchSummary(searchId),
    ]);
    return {
        reviewOutputTokens: APP_REVIEW_OUTPUT_TOKENS,
        budget: budget.status === "fulfilled" ? budget.value : null,
        stages: ai.status === "fulfilled" ? ai.value.stages.map(({ step, calls, failed }) => ({ step, calls, failed })) : [],
        ebayBrowseRequests: browse.status === "fulfilled" ? browse.value?.used ?? null : null,
        pricing: pricing.status === "fulfilled" ? pricing.value : null,
    };
}

function evidenceFor(discovery: SearchDiagnosticDiscovery, rows: readonly SearchDiagnosticRow[], usage: SearchUsage) {
    const stops = new Map<string, { outcome: string; reason: string; count: number; example: SearchDiagnosticRow }>();
    for (const row of rows) {
        const key = `${row.outcome}:${row.reason}`;
        const previous = stops.get(key);
        if (previous) previous.count++;
        else stops.set(key, { outcome: row.outcome, reason: row.reason, count: 1, example: row });
    }
    const groups = [...stops.values()].sort((a, b) => b.count - a.count);
    const examples: Record<string, string> = {};
    const decisions = groups.map(({ outcome, reason, count, example }, index) => {
        const ordinal = index + 1;
        if (ordinal > 12) return { outcome, reason, count };
        examples[ordinal] = example.id;
        return { outcome, reason, count, exampleRow: ordinal, modeledProfitUsd: example.profit ?? null };
    });
    const { total, found, screened, priceExcluded, unresolvedOverflow, overflow, skipped, deferred, previouslySeen, soldPurchaseCeiling, pricePass, marketplaceOrder, retainedIds } = discovery;
    const overflowReasons = new Map<string, number>();
    for (const { reason } of overflow?.rows ?? []) overflowReasons.set(reason, (overflowReasons.get(reason) ?? 0) + 1);
    const sourceReasons = new Map<string, number>();
    for (const { reason } of discovery.sourceDispositions ?? []) sourceReasons.set(reason, (sourceReasons.get(reason) ?? 0) + 1);
    const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    return {
        examples,
        evidence: {
            discovery: { total, found, screened, priceExcluded, unresolvedOverflow, skipped, deferred, previouslySeen, soldPurchaseCeilingUsd: soldPurchaseCeiling, pricePass, marketplaceOrder, retained: retainedIds.length },
            screening: { decisions, ...(overflow && { overflow: { stage: overflow.stage, reasons: Object.fromEntries(overflowReasons) } }),
                ...(discovery.sourceCoverage && { sourceCoverage: discovery.sourceCoverage, sourceReasons: Object.fromEntries(sourceReasons) }) },
            assessment: {
                photoChecked: rows.filter(row => row.photoChecked).length,
                priced: rows.filter(row => row.priced).length,
                buyerDecisions: {
                    buy: rows.filter(row => row.reason === "BUYER_BUY").length,
                    wait: rows.filter(row => row.outcome === "WAIT").length,
                    skip: rows.filter(row => row.reason === "BUYER_SKIP").length,
                    unavailable: rows.filter(row => row.reason === "BUYER_CHECK_UNAVAILABLE").length,
                },
                deals: rows.filter(row => row.outcome === "DEAL").length,
                losses: rows.filter(row => row.outcome === "LOSS").length,
            },
            providerUsage: {
                ebayBrowseRequests: amount(usage.ebayBrowseRequests),
                pkmnPricesRequests: amount(usage.pricing?.used),
                pkmnPricesReportedCredits: amount(usage.pricing?.reportedCredits),
                searchAiCapUsd: amount(usage.budget?.capUsd),
                searchAiCostUsd: amount(usage.budget?.settledUsd),
                aiGenerationAttempts: amount(usage.budget?.attempts),
                listingTextCalls: amount(usage.stages.find(stage => stage.step === "Listing text screening")?.calls),
                slabLabelCalls: amount(usage.stages.find(stage => stage.step === "Bounded slab label assessment")?.calls),
            },
        },
    };
}

const store = createSearchDiagnosticStore<SearchUsage>();
const share = createSharedWork();
export const saveDiagnosticDiscovery = store.saveDiscovery;
export const loadDiagnosticDiscovery = store.loadDiscovery;
export async function loadDiagnosticResult(searchId: string) {
    const result = await store.loadResult(searchId);
    if (!result?.message) return result;
    // Older reports also included a storage notice after the failure reason.
    const message = result.message.replace(/ (?:The search decisions were saved|Your listing decisions are saved)\.$/, "");
    return { ...result, message };
}

// The scan has finished before it submits these decisions. Save the review
// even when the browser navigates away while its text request is in flight.
export function completeSearchDiagnostic(searchId: string, rows: unknown, signal?: AbortSignal): Promise<SearchDiagnosticResult | null> {
    return share(searchId, async workSignal => {
        const previous = await loadDiagnosticResult(searchId);
        if (previous) return previous;
        const snapshot = await store.loadSnapshot(searchId) ?? await store.saveSnapshot(searchId, rows, await usageFor(getAiUsageContext().watchBudgetId ?? searchId));
        if (!snapshot) return null;
        const { savedAt } = snapshot;
        const save = async (result: SearchDiagnosticResult) => await store.saveResult(searchId, result) ?? result;
        if (!snapshot.rows.length) return save({ searchId, savedAt, status: "skipped", message: "This search retained no listings to review." });

        workSignal.throwIfAborted();
        const budgetSearchId = getAiUsageContext().watchBudgetId ?? reviewAccount(searchId);
        const { evidence, examples } = evidenceFor(snapshot.discovery, snapshot.rows, snapshot.data);
        try {
            const { review } = await runSearchDiagnosticReview({ searchId, budgetSearchId, evidence,
                exampleCount: Object.keys(examples).length, outputTokens: snapshot.data.reviewOutputTokens, signal: workSignal });
            const reviewBudget = await aiSpending.summary(budgetSearchId).catch(() => undefined);
            return save({ searchId, savedAt, status: "complete", review, examples, reviewBudget });
        } catch (error) {
            workSignal.throwIfAborted();
            const reviewBudget = await aiSpending.summary(budgetSearchId).catch(() => undefined);
            const message = reviewBudget?.paused ? "AI reviews are paused."
                : error instanceof Error && error.message === "Search diagnostic review: response was cut off (max_output_tokens)"
                    ? "The review reached its response length limit."
                    : "The automatic review could not finish.";
            return save({ searchId, savedAt, status: "unavailable", message, reviewBudget });
        }
    }, signal);
}

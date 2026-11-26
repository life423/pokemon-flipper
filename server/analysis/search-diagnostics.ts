import { getAiUsageContext } from "../ai/usage-context.ts";
import type { AiSearchBudget, AiUsageStage } from "../../shared/ai-usage.ts";
import type { PricingResearchUsage } from "../../shared/pricing-usage.ts";
import type { SearchDiagnosticResult } from "../../shared/search-diagnostic.ts";
import { aiSpending } from "../ai/spending.ts";
import { aiUsageToday } from "../ai/usage.ts";
import { browseSearchAllowance } from "../ebay/search-budget.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { priceResearchSummary } from "../pricing/research-budget.ts";
import { createSearchDiagnosticStore } from "./search-diagnostic-store.ts";

interface SearchUsage {
    budget: AiSearchBudget | null;
    stages: Pick<AiUsageStage, "step" | "calls" | "failed">[];
    ebayBrowseRequests: number | null;
    pricing: PricingResearchUsage | null;
}

export async function diagnosticUsage(searchId: string): Promise<SearchUsage> {
    const [budget, ai, browse, pricing] = await Promise.allSettled([
        aiSpending.summary(searchId), aiUsageToday(searchId), Promise.resolve().then(() => browseSearchAllowance()),
        Promise.resolve().then(() => priceResearchSummary(searchId)),
    ]);
    return {
        budget: budget.status === "fulfilled" ? budget.value : null,
        stages: ai.status === "fulfilled" ? ai.value.stages.map(({ step, calls, failed }) => ({ step, calls, failed })) : [],
        ebayBrowseRequests: browse.status === "fulfilled" ? browse.value?.used ?? null : null,
        pricing: pricing.status === "fulfilled" ? pricing.value : null,
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

// Completion records the observed decisions under their original search account.
export function completeSearchDiagnostic(searchId: string, rows: unknown, signal?: AbortSignal): Promise<SearchDiagnosticResult | null> {
    return share(searchId, async workSignal => {
        const previous = await loadDiagnosticResult(searchId);
        if (previous) return previous;
        workSignal.throwIfAborted();
        const snapshot = await store.loadSnapshot(searchId) ?? await store.saveSnapshot(searchId, rows, await diagnosticUsage(getAiUsageContext().watchBudgetId ?? searchId));
        if (!snapshot) return null;
        const result: SearchDiagnosticResult = { searchId, savedAt: snapshot.savedAt, status: "recorded" };
        return await store.saveResult(searchId, result) ?? result;
    }, signal);
}

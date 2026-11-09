import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AI_SEARCH_HARD_CAP_USD, aiSpending } from "../server/ai/spending.ts";
import { runSearchDiagnosticReview, SEARCH_DIAGNOSTIC_MODEL } from "../server/analysis/search-diagnostic-review.ts";
import { closeDatabase, storageBackend } from "../server/storage/index.ts";

const SEARCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOLD_REASONS = ["SELLER_NAME_CONFLICT", "GRADER_UNREADABLE", "NO_MATCHED_SALES", "OTHER"] as const;
const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const dollars = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

// Only aggregates and fixed labels leave this process. Do not forward query,
// source strings, listing IDs, titles, notes, URLs, photos or provider errors.
export function summarizeSearchDiagnostic(report: unknown, searchId: string, supplemental: unknown = []) {
    const source = record(report), search = record(source.search), usage = record(source.usage);
    const budget = record(usage.budget), cap = dollars(budget.capUsd);
    const validCap = budget.capUsd === null || cap !== null && cap > 0 && cap <= AI_SEARCH_HARD_CAP_USD;
    if (!SEARCH_ID.test(searchId) || source.searchId !== searchId || budget.searchId !== searchId ||
        !validCap || !Array.isArray(source.rows) || !Array.isArray(source.deals) ||
        !source.assessments || typeof source.assessments !== "object" || Array.isArray(source.assessments)) {
        throw new Error("Provide a saved search diagnostic with its matching original search UUID and recorded AI cap.");
    }
    const rows = source.rows.map(record), assessments = Object.values(record(source.assessments)).map(record);
    const holds = assessments.filter(item => item.verdict === "NEEDS_REVIEW").length;
    const losses = assessments.flatMap(item => {
        const profit = dollars(item.profit);
        return item.priced === true && profit !== null && profit < 0 ? [profit] : [];
    });
    if (!Array.isArray(supplemental) || supplemental.length > HOLD_REASONS.length) throw new Error("Invalid supplemental review holds.");
    const reviewHolds = supplemental.map(value => {
        const entry = record(value), reason = HOLD_REASONS.find(key => key === entry.reason);
        const listings = count(entry.count), resolvedAfterRecheck = count(entry.resolvedAfterRecheck), losingAfterRecheck = count(entry.losingAfterRecheck);
        if (!reason || listings === null || listings === 0 || resolvedAfterRecheck === null || resolvedAfterRecheck > listings ||
            losingAfterRecheck === null || losingAfterRecheck > resolvedAfterRecheck) {
            throw new Error("Supplemental holds need a recognized reason and counts where losses do not exceed resolved rechecks or total holds.");
        }
        return { reason, count: listings, resolvedAfterRecheck, losingAfterRecheck, stillUnresolved: listings - resolvedAfterRecheck };
    });
    if (new Set(reviewHolds.map(entry => entry.reason)).size !== reviewHolds.length ||
        reviewHolds.reduce((total, entry) => total + entry.count, 0) > holds) throw new Error("Supplemental holds must describe distinct reasons within this diagnostic's review count.");
    const pricePass = record(search.pricePass), pricing = record(usage.pricing), browse = record(record(source.ebay).searchBudget);
    const stages = Array.isArray(usage.stages) ? usage.stages.map(record) : [];
    return {
        discovery: { reportedEbayResults: count(search.total), uniqueSourceRows: count(search.found), retained: rows.length,
            lowerPricePassNewSourceRows: count(pricePass.newListings), lowerPricePassAddedAssessmentCandidates: count(pricePass.candidates) },
        screening: { screened: count(search.screened), priceExcluded: count(search.priceExcluded),
            candidates: rows.filter(row => row.screen === "CANDIDATE").length,
            soldEvidenceUnavailable: rows.filter(row => row.soldStatus === "UNAVAILABLE").length,
            exactMarketUnconfirmed: rows.filter(row => typeof row.soldNote === "string" && row.soldNote.startsWith("The listing does not establish one exact card market for sold-price screening.")).length,
            noUsableRecentSale: rows.filter(row => typeof row.soldNote === "string" && row.soldNote.startsWith("No usable recent matched sale")).length },
        assessment: { photoChecked: assessments.filter(item => item.photoCheck === true).length,
            identityReview: assessments.filter(item => item.identityStatus === "NEEDS_REVIEW").length,
            holds, priced: assessments.filter(item => item.priced === true).length, pricedLosses: losses.length,
            smallestModeledLossUsd: losses.length ? -Math.max(...losses) : null, deals: source.deals.length },
        providerUsage: { ebayBrowseRequests: count(browse.used), pkmnPricesRequests: count(pricing.used),
            pkmnPricesReportedCredits: count(pricing.reportedCredits), originalSearchAiCapUsd: cap,
            reportedAiCostUsd: dollars(budget.settledUsd), aiGenerationAttempts: count(budget.attempts),
            aiTextScreenCalls: count(stages.find(stage => stage.step === "Listing text screening")?.calls),
            aiSlabLabelCalls: count(stages.find(stage => stage.step === "Bounded slab label assessment")?.calls) },
        reviewHolds,
    };
}

async function readJson(file: string): Promise<unknown> {
    if ((await fs.stat(file)).size > 4 * 1024 * 1024) throw new Error("Search diagnostic input is too large.");
    return JSON.parse(await fs.readFile(file, "utf8"));
}

export async function reviewSearchDiagnostic(args = process.argv.slice(2)) {
    const [mode, source, searchId, supplement, ...extra] = args;
    if ((mode !== "--live" && mode !== "--replay") || !source || !searchId || extra.length) {
        throw new Error("Usage: review-search-diagnostic.ts --live|--replay <diagnostic.json> <original-search-uuid> [review-holds.json]");
    }
    const evidence = summarizeSearchDiagnostic(await readJson(source), searchId, supplement ? await readJson(supplement) : []);
    if (mode === "--replay") return { mode, searchId, evidence };

    try {
        if (storageBackend() !== "azure-sql") throw new Error("Live diagnostic reviews require the app's shared SQL dispatch protection.");
        const budgetBefore = await aiSpending.summary(searchId);
        const originalCap = evidence.providerUsage.originalSearchAiCapUsd;
        if (budgetBefore.attempts < 1 || originalCap === null || budgetBefore.capUsd === null || budgetBefore.capUsd > originalCap) {
            throw new Error("Live review requires an existing paid search account within the original recorded allowance.");
        }
        const reviewed = await runSearchDiagnosticReview({ searchId, budgetSearchId: searchId, evidence });
        return { mode, searchId, evidence, model: SEARCH_DIAGNOSTIC_MODEL, ...reviewed,
            budgetBefore, budgetAfter: await aiSpending.summary(searchId) };
    } finally {
        await closeDatabase();
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const result = await reviewSearchDiagnostic();
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

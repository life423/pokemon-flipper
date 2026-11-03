// Explicit diagnostic, not a development-server worker or recurring search.
// npx tsx scripts/bounded-search-benchmark.ts --live --query 'Venusaur Base Set 15/102 Unlimited holo'
// npx tsx scripts/bounded-search-benchmark.ts --replay data/search-benchmarks/<run>/report.json
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Evaluation, ListingSummary, SearchIntent } from "../shared/types.ts";
import type { SearchSummary } from "../server/deals/find-deals.ts";
import type { AiSearchBudget } from "../shared/ai-usage.ts";
import { DEVELOPMENT_SEARCH_LIMIT } from "../shared/research-policy.ts";
import { runBenchmarkQueue, type BenchmarkQueueResult } from "./review/benchmark-queue.ts";
import { BENCHMARK_TRANSPORT_LIMITS, createBenchmarkTransport } from "./review/benchmark-transport.ts";
import { candidateAdmission, summarizeBenchmark } from "./review/benchmark-results.ts";

const args = process.argv.slice(2);
const argument = (name: string) => args[args.indexOf(name) + 1];
const replayFile = args.includes("--replay") ? argument("--replay") : undefined;
const queryArg = args.includes("--query") ? argument("--query") : undefined;
const live = args.includes("--live");
if (args.includes("--help")) {
    process.stdout.write("One bounded search: --live --query '<exact card/set/number/finish>'. Cache replay: --replay <report.json>. No forced refresh, broad discovery or automatic retries.\n");
    process.exit(0);
}
if (live && replayFile || !replayFile && (!live || !queryArg?.trim() || queryArg.length > 300)) {
    throw new Error("Choose either --live --query '<search>' or --replay <report.json>. Live provider work requires --live explicitly.");
}
const previous = replayFile ? JSON.parse(await fs.readFile(path.resolve(replayFile), "utf8")) : null;
if (previous && (!Array.isArray(previous.listings) || !previous.searchId || !previous.summary?.intent)) throw new Error("Replay requires a saved diagnostic report with listings, intent and the original search ID.");
const searchId: string = previous?.searchId ?? randomUUID();
const query: string = previous?.query ?? queryArg!.trim();
const targets = { minProfit: 0, minRoi: 0 };
const filters = { typeFilter: "FIXED_PRICE" as const, kindFilter: "all" as const };
const includeOffers = false;
const directory = path.resolve("data/search-benchmarks", `${new Date().toISOString().replace(/[:.]/g, "-")}-${live ? "live" : "replay"}-${searchId}`);
await fs.mkdir(directory, { recursive: true });
const context = new AsyncLocalStorage<{ searchId: string; listingId?: string; phase: string }>();
const observer = createBenchmarkTransport({ live, context: () => context.getStore() ?? { searchId, phase: "setup" }, allowAzureAuth: true });
const originalFetch = globalThis.fetch;
globalThis.fetch = observer.fetch;
const report: {
    searchId: string; query: string; startedAt: string; completedAt?: string;
    method: string; limitations: string[]; settings: object; summary?: SearchSummary;
    listings: ListingSummary[]; queue?: BenchmarkQueueResult; final?: ReturnType<typeof summarizeBenchmark>;
    snapshots: Record<string, unknown>; events: object[]; error?: string; transport?: unknown; costDelta?: object;
} = {
    searchId, query, startedAt: new Date().toISOString(),
    method: live ? "Actual bounded server search and evaluator under one existing spending/Browse scope; client eligibility/priority/feedback and two slots reproduced after metadata screening."
        : "Replay only the original completed assessments against saved metadata; same original search ID, SQL assessment/price reuse, all paid/provider transports prohibited.",
    limitations: [
        "One exact Buy It Now search, not an exhaustive marketplace scan or a general model accuracy evaluation.",
        "Not a browser timing test: automatic assessment begins after metadata screening; initial UI bootstrap/shortlist/set-year work is excluded.",
        "This diagnostic does not automatically retry network failures, force photo refreshes or run deeper reviews.",
        `The diagnostic transport ceiling is ${BENCHMARK_TRANSPORT_LIMITS.prices} uncached PKMNPrices requests, alongside the production persistent all-stage allowance. Requests and charged credits are reported separately.`,
        "Token-charge totals use actual returned usage and the existing configured rates; provider credit headers are not a cash invoice.",
        ...(live ? [] : ["Replayed listing availability is a saved snapshot, not a new eBay live check. Missing AI evidence fails before any reservation/preflight."]),
    ],
    settings: { targets, filters, includeOffers, matchingRows: DEVELOPMENT_SEARCH_LIMIT, aiCapUsd: 0.02, browseCap: 25, priceTransportsDiagnosticCap: BENCHMARK_TRANSPORT_LIMITS.prices },
    listings: [], snapshots: {}, events: [],
};
const started = performance.now();
const elapsedMs = () => Math.round(performance.now() - started);
const checkpoint = async () => {
    report.transport = observer.snapshot();
    await fs.writeFile(path.join(directory, "transports.json"), JSON.stringify(observer.records, null, 2) + "\n");
    await fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
};
let closeDatabase: (() => Promise<void>) | undefined;
try {
    const { withAiUsageContext } = await import("../server/ai/usage-context.ts");
    const storage = await import("../server/storage/index.ts");
    closeDatabase = storage.closeDatabase;
    await storage.assertSqlStorageReady();
    const { aiSpending } = await import("../server/ai/spending.ts");
    const { aiUsageToday } = await import("../server/ai/usage.ts");
    const { priceResearchSummary, withPriceResearchSignal } = await import("../server/pricing/research-budget.ts");
    const { browseSearchAllowance } = await import("../server/ebay/search-budget.ts");
    const { ebayUsage } = await import("../server/ebay/usage.ts");
    const { evaluationFailure } = await import("../server/analysis/failure.ts");
    const { createBoundedEvaluator } = await import("../server/analysis/bounded-evaluate.ts");
    const { searchDeals } = await import("../server/deals/search.ts");
    const scope = <T>(phase: string, work: () => T, listingId?: string): T => context.run({ searchId, phase, listingId }, () =>
        withAiUsageContext({ searchId, ...(listingId ? { listingId } : {}) }, work));
    const snapshots = async (phase: string) => scope(phase, async () => ({
        ai: await aiUsageToday(searchId), budget: await aiSpending.summary(searchId), browse: await browseSearchAllowance(), pricing: await priceResearchSummary(searchId),
        ...(live ? { accountEbay: await ebayUsage({ fresh: true }) } : {}),
    }));
    report.snapshots.before = await snapshots("before");
    await checkpoint();
    const guard = await aiSpending.summary(searchId);
    if (live && (!guard.configured || guard.paused || guard.capUsd === null || guard.capUsd > 0.02)) throw new Error("Existing AI spending configuration is not ready. The benchmark did not change it.");
    const stopped = new AbortController();
    const timer = setTimeout(() => stopped.abort(new Error("Diagnostic ten-minute deadline reached")), 600_000);
    const stop = () => stopped.abort(new Error("Diagnostic stopped"));
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
        if (previous) {
            report.summary = previous.summary;
            report.listings = previous.listings;
        } else await scope("sold-screening", () => withPriceResearchSignal(stopped.signal, () => searchDeals(query, {
            minPrice: 0,
            targets, filters, includeOffers, signal: stopped.signal,
            onStart: summary => { report.summary = summary; report.events.push({ type: "metadata", elapsedMs: elapsedMs(), summary }); },
            onListing: listing => { report.listings.push(listing); },
        })));
        report.events.push({ type: "metadata-finished", elapsedMs: elapsedMs(), loaded: report.listings.length,
            admissions: Object.fromEntries(report.listings.map(listing => [listing.id, candidateAdmission(listing, filters, Date.now(), targets)])) });
        await checkpoint();
        observer.assertNoBlock();
        stopped.signal.throwIfAborted();
        const evaluate = createBoundedEvaluator(live ? {} : {
            assess: async () => { throw new Error("Cache replay needs a saved photo assessment; no paid replacement was authorized."); },
        });
        const assessmentRows = previous ? report.listings.filter(listing => previous.queue?.evaluations?.[listing.id]) : report.listings;
        report.queue = await runBenchmarkQueue(assessmentRows, {
            filters, targets, signal: stopped.signal, assertTransport: observer.assertNoBlock,
            evaluate: (listing, signal) => scope("assessment", () => evaluate(listing.id, {
                automatic: true, signal,
                current: { title: listing.title, images: listing.images, price: listing.currentPrice, shipping: listing.shipping, bids: listing.bids, endTime: listing.endTime },
            }), listing.id),
            failureOf: evaluationFailure,
            onUpdate: async queue => {
                report.queue = queue;
                process.stdout.write(`Assessments completed ${Object.keys(queue.evaluations).length}; failed/blocked ${Object.keys(queue.failures).length}; waiting ${queue.waiting.length}\n`);
                await checkpoint();
            },
        });
        const intent = report.summary?.intent as SearchIntent | undefined;
        if (!intent) throw new Error("Search intent missing; final result grouping was not inferred.");
        const resolvedListings = report.listings.map(listing => report.queue!.otherLanguage.includes(listing.id) ? { ...listing, match: "OTHER_LANGUAGE" as const } : listing);
        report.final = summarizeBenchmark(resolvedListings, report.queue.evaluations as Record<string, Evaluation>, report.queue.errors, intent, targets,
            { filters: { typeFilter: "FIXED_PRICE", kindFilter: "all" }, includeOffers });
    } finally {
        clearTimeout(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop);
        report.snapshots.after = await snapshots("after");
    }
} catch (error) {
    report.error = error instanceof Error ? error.message : "Benchmark failed.";
    process.exitCode = 1;
} finally {
    report.completedAt = new Date().toISOString();
    const before = (report.snapshots.before as { budget?: AiSearchBudget } | undefined)?.budget;
    const after = (report.snapshots.after as { budget?: AiSearchBudget } | undefined)?.budget;
    if (before && after) report.costDelta = {
        settledUsd: Number((after.settledUsd - before.settledUsd).toFixed(9)),
        committedUsd: Number((after.committedUsd - before.committedUsd).toFixed(9)),
        heldUsd: Number((after.heldUsd - before.heldUsd).toFixed(9)),
        generationReservations: after.attempts - before.attempts,
    };
    await checkpoint();
    globalThis.fetch = originalFetch;
    await closeDatabase?.();
}
process.stdout.write(JSON.stringify({ report: path.join(directory, "report.json"), searchId, error: report.error ?? null, counts: report.final?.counts,
    snapshots: report.snapshots, transport: report.transport }, null, 2) + "\n");

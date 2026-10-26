// Run deliberately: npm run build && npx tsx scripts/search-review.ts --live
// Uses the same orchestration as /api/deals. No app defaults are changed.
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { ReviewBudget, REVIEW_LIMITS, type ReviewService } from "./review/request-budget.ts";
import type { Evaluation, ListingSummary } from "../shared/types.ts";

if (!process.argv.includes("--live")) throw new Error("Pass --live explicitly to allow bounded paid provider calls.");
const finishPrimary = process.argv.includes("--finish-primary");
const queries = ["1999 base set holo", "neo genesis lugia", "pikachu 151 illustration rare", "umbreon vmax 215/203", "charizard ex obsidian flames", "team rocket dark blastoise", "gengar fossil psa 8", "crown zenith mewtwo vstar", "pokemon promo swsh050", "vintage pokemon holo raw"];
const directory = path.resolve("data/reviews/2026-10-26");
await fs.mkdir(directory, { recursive: true });
const previous = finishPrimary ? JSON.parse(await fs.readFile(path.join(directory, "report.json"), "utf8")) : null;
if (finishPrimary && (previous.queries.length !== 10 || previous.used.ebayBrowse !== 150)) throw new Error("Supplement requires the saved 150-request review.");
const budget = new ReviewBudget(finishPrimary ? { ebayBrowse: 152, ai: previous.used.ai, prices: previous.used.prices } : REVIEW_LIMITS);
if (previous) Object.assign(budget.used, previous.used);
const context = new AsyncLocalStorage<{ query: string; signal: AbortSignal }>();
const requests: { query: string; service: string; schema?: string; status: number; ms: number; inputTokens?: number; outputTokens?: number }[] = [];
if (previous) requests.push(...previous.requests);
const priorRequestCount = requests.length;
const previousBlocked = { ...(previous?.blocked ?? {}) };
const nativeFetch = globalThis.fetch;
// Count only noncached transport attempts. Never store request bodies,
// credentials, response payloads or authentication headers in this ledger.
globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const scope = context.getStore();
    const query = scope?.query ?? "usage";
    const service: ReviewService | "ebayOther" = url.hostname === "api.openai.com" ? "ai"
        : url.hostname === "api.pkmnprices.com" ? "prices"
        : url.hostname === "api.ebay.com" ? url.pathname.startsWith("/buy/browse/") ? "ebayBrowse" : "ebayOther"
        : (() => { throw new Error(`Unrecognized review provider ${url.hostname}; blocked.`); })();
    scope?.signal.throwIfAborted();
    let schema: string | undefined;
    if (service === "ai") {
        const body = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : "{}";
        schema = JSON.parse(body).text?.format?.name;
    }
    if (service !== "ebayOther") budget.reserve(service, query, schema);
    const started = performance.now();
    const entry = { query, service, schema, status: 0, ms: 0, inputTokens: undefined as number | undefined, outputTokens: undefined as number | undefined };
    requests.push(entry);
    try {
        const response = await nativeFetch(input, { ...init, signal: scope ? AbortSignal.any([scope.signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal });
        entry.status = response.status;
        if (service === "ai" && response.ok) {
            const body = await response.clone().json();
            entry.inputTokens = body.usage?.input_tokens;
            entry.outputTokens = body.usage?.output_tokens;
        }
        return response;
    } finally { entry.ms = Math.round(performance.now() - started); }
};
const { searchWithDiscovery } = await import("../server/deals/search.ts");
const { evaluateListing } = await import("../server/analysis/evaluate.ts");
const { ebayUsage } = await import("../server/ebay/usage.ts");
const { compareAnalysisPriority, analysisPriority } = await import("../shared/analysis-priority.ts");
const { canAutoAnalyze, resultGroup } = await import("../shared/analysis.ts");
const { retargetEvaluation } = await import("../shared/money/targets.ts");
const { MODEL } = await import("../server/ai/openai.ts");
const targets = { minProfit: 0, minRoi: 0 };
const report: any = previous ?? {
    date: "2026-10-26", revision: "8b0574a", branch: "search-workflow-review", model: MODEL,
    method: "Actual /api/deals orchestration with 200 primary results, Any/Any, offers off, automatic discovery. Sequential diagnostic calls; no UI auto-analysis flood. Fresh normal cache TTLs, no forced refreshes. At most six NEW discovery photo requests per query; cached photo scans still run. At most four selected full analyses overall.",
    limits: { ...REVIEW_LIMITS, newDiscoveryPhotosPerQuery: 6, fullAnalyses: 4, searchTimeoutSeconds: 180, analysisTimeoutSeconds: 150 },
    limitations: ["A bounded diagnostic sample, not an exhaustive marketplace scan or a guarantee of profitability.", "Timings include safety-cap effects; discovery completeness and deferred requests are recorded separately.", "Existing independent app activity may contribute to the account-level eBay usage delta."],
    startedAt: new Date().toISOString(), usageBefore: await ebayUsage({ fresh: true }), queries: [],
};
if (report.usageBefore?.braking) throw new Error("eBay is already in reserve; live review stopped.");
let fullAnalyses = previous ? previous.queries.reduce((n: number, q: any) => n + q.fullAnalyses.length, 0) : 0;
const snapshots: { query: string; listings: ListingSummary[]; evaluations: Record<string, Evaluation> }[] = previous ? JSON.parse(await fs.readFile(path.join(directory, "snapshots.json"), "utf8")) : [];
if (previous) {
    report.queries = report.queries.slice(0, 8); snapshots.splice(8);
    report.supplement = "The 150-Browse cap stopped the last two primary pages. Exactly two further primary search pages were authorized within this diagnostic. No further AI or price requests; discovery/detail cache misses stay deferred.";
    report.limits.ebayBrowse = 152;
}
async function save() {
    report.used = { ...budget.used };
    report.blocked = Object.fromEntries([...new Set([...Object.keys(previousBlocked), ...Object.keys(budget.blocked)])].map((key) => [key, (previousBlocked[key] ?? 0) + (budget.blocked[key] ?? 0)]));
    report.requests = requests;
    await fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(directory, "snapshots.json"), JSON.stringify(snapshots));
}
const pendingQueries = finishPrimary ? queries.slice(8) : queries;
// Secure both final primary pages before screening can request any details.
if (finishPrimary) {
    const { searchListings } = await import("../server/ebay/listings.ts");
    for (const query of pendingQueries) {
        await context.run({ query, signal: AbortSignal.timeout(30000) }, () => searchListings(query, { maxResults: 200 }));
    }
}
for (const [index, query] of pendingQueries.entries()) {
    const started = performance.now();
    const elapsed = () => Math.round((performance.now() - started) / 10) / 100;
    const listings = new Map<string, ListingSummary>();
    const row: any = { query, startedAt: new Date().toISOString(), firstListingSeconds: null, primarySeconds: null, searchSeconds: null, completed: false, errors: [], discovery: [], fullAnalyses: [] };
    const snapshot = { query, listings: [] as ListingSummary[], evaluations: {} as Record<string, Evaluation> };
    snapshots.push(snapshot);
    report.queries.push(row);
    const requestOffset = finishPrimary ? priorRequestCount : requests.length;
    if (finishPrimary) row.scope = "Fresh primary page, cached-only screening; discovery and missing details/prices deferred by transport guard.";
    const blocksBefore = { ...budget.blocked };
    const stopped = new AbortController();
    const timer = setTimeout(() => stopped.abort(new Error("Review search deadline reached")), 180_000);
    process.stdout.write(`Starting ${index + 1}/10: ${query}\n`);
    try {
        await context.run({ query, signal: stopped.signal }, () => searchWithDiscovery(query, {
            maxResults: 200, minPrice: 0, targets, includeOffers: false, signal: stopped.signal,
            onStart: (summary) => { row.summary = summary; row.startSeconds = elapsed(); },
            onListing: (listing) => {
                row.firstListingSeconds ??= elapsed(); listings.set(listing.id, listing);
            },
            onDiscovery: (progress) => { row.primarySeconds ??= elapsed(); row.discovery.push({ ...progress, seconds: elapsed() }); },
        }));
        row.completed = !stopped.signal.aborted;
    } catch (error) { row.errors.push((error as Error).message); }
    finally { clearTimeout(timer); stopped.abort(); }
    row.searchSeconds = elapsed();
    snapshot.listings = [...listings.values()];
    row.receivedUnique = listings.size;
    row.statuses = {}; row.reasons = {};
    for (const listing of listings.values()) {
        const status = listing.match ?? listing.screen?.status ?? "NO_SCREEN";
        row.statuses[status] = (row.statuses[status] ?? 0) + 1;
        if (listing.screen?.reason) row.reasons[listing.screen.reason] = (row.reasons[listing.screen.reason] ?? 0) + 1;
    }
    const ranked = [...listings.values()].filter(canAutoAnalyze).sort((a, b) => compareAnalysisPriority(a, b, targets));
    row.eligibleForAutoAnalysis = ranked.length;
    row.strongestCandidates = ranked.slice(0, 3).map((listing) => ({ title: listing.title, price: listing.currentPrice, buyingOption: listing.buyingOption, priority: analysisPriority(listing, targets), screen: listing.screen?.bestCase, preliminaryMatch: listing.screen?.evidence?.mainPhoto }));
    // Sample a distinct eligible listing, never a long-shot auction or an
    // unverified extreme price. Full output stays in ignored local snapshots.
    if (ranked.length && fullAnalyses < 4 && budget.used.ai < budget.limits.ai - 4) {
        const listing = ranked[0]; fullAnalyses += 1;
        const analysisStopped = new AbortController();
        const analysisTimer = setTimeout(() => analysisStopped.abort(new Error("Review analysis deadline reached")), 150_000);
        const analysisStart = performance.now();
        try {
            const evaluation = retargetEvaluation(await context.run({ query, signal: analysisStopped.signal }, () => evaluateListing(listing.id, { current: { price: listing.currentPrice, shipping: listing.shipping, bids: listing.bids, endTime: listing.endTime } })), targets, listing);
            snapshot.evaluations[listing.id] = evaluation;
            row.fullAnalyses.push({ title: listing.title, seconds: Math.round((performance.now() - analysisStart) / 10) / 100, group: resultGroup(listing, evaluation), verdict: evaluation.underwriting?.verdict, route: evaluation.underwriting?.best?.label, profit: evaluation.underwriting?.best?.profit, downside: evaluation.underwriting?.best?.downside, maxBid: evaluation.underwriting?.best?.maxBid, condition: evaluation.condition?.rawCondition, range: evaluation.condition?.gradeRange, confidence: evaluation.condition?.confidence, reasons: evaluation.underwriting?.reasons, rating: evaluation.rating, usage: evaluation.usage, reusedSteps: evaluation.reusedSteps });
        } catch (error) { row.fullAnalyses.push({ title: listing.title, error: (error as Error).message }); }
        finally { clearTimeout(analysisTimer); analysisStopped.abort(); }
    }
    row.requests = requests.slice(requestOffset).filter((request) => request.query === query).reduce((counts, request) => { counts[request.service] = (counts[request.service] ?? 0) + 1; return counts; }, {} as Record<string, number>);
    row.deferred = Object.fromEntries(Object.entries(budget.blocked).map(([key, value]) => [key, value - (blocksBefore[key] ?? 0)]).filter(([, value]) => Number(value) > 0));
    await save();
    process.stdout.write(JSON.stringify({ query, first: row.firstListingSeconds, seconds: row.searchSeconds, statuses: row.statuses, discovery: row.discovery.at(-1), sampled: row.fullAnalyses, requests: row.requests, deferred: row.deferred }) + "\n");
}
report.usageAfter = await ebayUsage({ fresh: true });
report.finishedAt = new Date().toISOString();
await save();
process.stdout.write(`Finished. Counts: ${JSON.stringify(report.used)}; saved ${path.join(directory, "report.json")}\n`);

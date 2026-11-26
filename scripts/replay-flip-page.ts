// Replay one recorded Buy It Now page. The optional name/number/set arguments
// identify a legacy Browse cache entry which predates per-pass diagnostics.
import { readFile } from "node:fs/promises";
import { readFlipEvents } from "../server/analysis/flip-diagnostic.ts";
import { createHuntInventoryScanner } from "../server/deals/find-deals.ts";
import { freshResaleCandidates } from "../server/deals/discovery-order.ts";
import { orderFlipPreviewCopies } from "../server/deals/flip-preview-selection.ts";
import { readTitleByRules } from "../server/ai/title-reader.ts";
import { createCacheStore } from "../server/lib/cache.ts";
import { createScreeningPriceSource } from "../server/pricing/pkmnprices.ts";
import { buyerReviewBlock } from "../shared/wait-skip-review.ts";
import type { SearchIntent, ListingSummary } from "../shared/types.ts";
import type { SourceDispositionRow } from "../shared/search-diagnostic.ts";

const [file, name, number, set] = process.argv.slice(2);
// Report what actually ran, including partial passes left by a disconnect.
// This mode reads immutable receipts only and never reconstructs a verdict.
if (file === "--pass") {
    if (!name) throw new Error("Supply a diagnostic pass directory.");
    const { events, damagedLines } = await readFlipEvents(name);
    if (!events.length) throw new Error("No recorded events in this directory.");
    const start = events.find(e => e.event === "started");
    const end = events.find(e => e.event === "finished");
    const rows = new Map<string, { id: string; title?: string; history: string[]; reason?: string }>();
    const screened = new Map<string, ListingSummary>();
    const previewComparisons = [];
    function record(id: string, stage: string, reason?: string, title?: string) {
        if (!id) return;
        const row = rows.get(id) ?? { id, history: [] };
        row.history.push(stage);
        if (reason) row.reason = reason;
        if (title) row.title = title;
        rows.set(id, row);
    }
    let firstDecision: { id: string; decision: string; elapsedMs: number } | null = null;
    for (const e of events) {
        if (e.version !== 1 || e.pass !== events[0].pass || e.searchId !== events[0].searchId)
            throw new Error("Incompatible or mixed diagnostic events.");
        const v = e.evidence;
        if (e.event === "page") {
            for (const copy of v.page.listings) record(copy.id, "FOUND", undefined, copy.title);
            for (const copy of v.page.rejections ?? []) record(copy.id, copy.reason);
        } else if (e.event === "screened") {
            for (const copy of v.listings ?? []) screened.set(copy.id, copy);
            for (const copy of v.dispositions) record(copy.id, copy.reason);
            for (const id of v.pending) record(id, "PENDING_CONTINUATION");
            for (const copy of v.excludedPrices ?? []) record(copy.id, "SOLD_PRICE_EXCLUDED", copy.screen?.reason);
        } else if (e.event === "selection" && v.source === "vision" && start?.evidence.request?.targets) {
            const pool = (v.previous as string[]).map(id => screened.get(id));
            if (pool.every((copy): copy is ListingSummary => !!copy)) {
                const replay = orderFlipPreviewCopies(pool, v, start.evidence.request.targets, Date.parse(e.at));
                previewComparisons.push({ index: e.index, previewsSeen: v.seen.length, recordedOrder: v.ordered, replayOrder: replay });
            }
        } else if (e.event === "queue") {
            for (const copy of v.dispositions) record(copy.id, copy.reason === "ELIGIBLE_FOR_REVIEW" ? "ELIGIBLE_NOT_REACHED" : copy.reason, copy.evidence);
        } else if (e.event === "check") record(v.id, "STARTED_" + v.action);
        else if (e.event === "observation") {
            record(v.id, "COMPLETED_" + v.action, v.observation);
            if (start && !firstDecision && v.verdict === "PASS" && typeof v.pricedProfit === "number")
                firstDecision = { id: v.id, decision: "PRICED_PASS", elapsedMs: Date.parse(e.at) - Date.parse(start.at) };
        } else if (e.event === "finished" && v.destination && ["BUY", "BID"].includes(v.decision)) {
            record(v.destination.listingId, v.decision, v.reason);
            if (start && !firstDecision) firstDecision = { id: v.destination.listingId, decision: v.decision, elapsedMs: Date.parse(e.at) - Date.parse(start.at) };
        }
    }
    const counts: Record<string, number> = {};
    for (const row of rows.values()) {
        const last = row.history[row.history.length - 1];
        counts[last] = (counts[last] ?? 0) + 1;
    }
    const before = start?.evidence.usage, after = end?.evidence.usage;
    const diff = (a: unknown, b: unknown) => typeof a === "number" && typeof b === "number" ? b - a : null;
    console.log(JSON.stringify({ searchId: events[0].searchId, pass: events[0].pass, complete: Boolean(start && end),
        contiguous: damagedLines === 0 && events.every((e, index) => e.index === index + 1), decision: end?.evidence.decision ?? null,
        elapsedMs: start && end ? Date.parse(end.at) - Date.parse(start.at) : null, firstSupportedDecision: firstDecision,
        browseRequests: diff(before?.ebayBrowseRequests, after?.ebayBrowseRequests),
        pricingRequests: diff(before?.pricing?.used, after?.pricing?.used), pricingCredits: diff(before?.pricing?.reportedCredits, after?.pricing?.reportedCredits),
        aiUsd: diff(before?.budget?.settledUsd, after?.budget?.settledUsd), counts, previewComparisons, rows: [...rows.values()] }, null, 2));
    process.exit(0);
}
if (!file) throw new Error("Supply a saved flip page event, or a Browse cache file followed by the card name, collector number and set.");
const record = JSON.parse(await readFile(file, "utf8"));
const evidence = record.event === "page" && record.version === 1 ? record.evidence : null;
if (!evidence && !(record.key?.startsWith("ebay:search:") && name && number && set))
    throw new Error("A legacy page requires its original card name, collector number and set.");
const page = evidence?.page ?? record.data;
const asOf = evidence?.asOf ?? Date.parse(record.savedAt);
const intent: SearchIntent = evidence?.intent ?? { cardName: name, sets: [set], cardNumber: number, titleWords: [name], finish: null,
    graded: null, grader: null, minGrade: null, maxGrade: null, printing: null, source: "rules" };
const filters = evidence?.filters ?? { typeFilter: "FIXED_PRICE" };
const targets = evidence?.targets ?? { minProfit: 0, minRoi: 0 };
if (!Array.isArray(page?.listings) || !Number.isFinite(asOf) || filters.typeFilter !== "FIXED_PRICE")
    throw new Error("Expected one dated Buy It Now inventory page.");
// Historical term checks in the production pipeline also consult Date.now().
Date.now = () => asOf;
globalThis.fetch = async () => { throw new Error("Network disabled for replay."); };
const store = createCacheStore({ now: () => asOf });
const missing = new Set<string>();
const scan = createHuntInventoryScanner(new AbortController().signal, {
    readIntent: async () => intent, readTitle: async title => readTitleByRules(title, intent.sets),
    search: async () => page, priceSource: options => createScreeningPriceSource(options, {
        read: async (path, hours) => {
            const cached = await store.read<{ data?: unknown[] }>("pkmnprices:" + path, hours);
            if (!cached) missing.add(path);
            return cached;
        },
    }),
});
const rejected = new Map<string, string>();
const started = performance.now();
const result = await scan(evidence?.query ?? [name, number, set].join(" "), intent, filters, targets, asOf, {
    excludeIds: new Set(), freshGrading: false, freshListings: true,
    diagnostic: async (event, value) => {
        if (event !== "screened") return;
        const batch = value as { dispositions: SourceDispositionRow[]; pending: string[] };
        for (const row of batch.dispositions) rejected.set(row.id, row.reason);
        for (const id of batch.pending) rejected.set(id, "PENDING_CONTINUATION");
    },
});
const retained = new Map(result.listings.map(row => [row.id, row]));
const eligible = result.listings.filter(row => !buyerReviewBlock(row, asOf));
const order = freshResaleCandidates(eligible, targets, asOf);
const rows = (page.listings as ListingSummary[]).map(({ id, title, currentPrice, shipping }) => {
    const row = retained.get(id);
    return { id, title, currentPrice, shipping, disposition: row ? buyerReviewBlock(row, asOf) ?? "ELIGIBLE_FOR_REVIEW" : rejected.get(id) ?? "UNACCOUNTED",
        reason: row?.screen?.reason, priceEvidence: row?.screen?.soldEvidence?.status,
        screenRank: row ? eligible.findIndex(item => item.id === id) + 1 || null : null,
        reviewRank: order.findIndex(item => item.id === id) + 1 || null };
});
const counts: Record<string, number> = {};
for (const row of rows) counts[row.disposition] = (counts[row.disposition] ?? 0) + 1;
console.log(JSON.stringify({ asOf: new Date(asOf).toISOString(), coverage: evidence ? "Recorded page" : "Latest saved query snapshot",
    summaries: rows.length, providerRejected: page.rejections?.length ?? null, screened: result.summary.screened,
    counts, missingCachedLookups: missing.size, elapsedReplayMs: Math.round(performance.now() - started),
    providerCalls: 0, pricingCredits: 0, rows }, null, 2));

import type { LiveCollectorReport } from "../../shared/collector-strategy.ts";
import { dollars } from "../../shared/format.ts";
import { parseListingLink } from "../../shared/listing-link.ts";
import { cents } from "../../shared/money/cents.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../shared/search-diagnostic.ts";
import { soldMarketPrice } from "../../shared/sold-evidence.ts";
import { withAiUsageContext } from "../ai/usage-context.ts";
import { discoverCollectorListings, verifyCollectorListing } from "../deals/bin-competition.ts";
import { configuredShippingZip } from "../ebay/api.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createKeyedLock } from "../lib/keyed-lock.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { StorageUnavailableError } from "../storage/index.ts";
import { chooseCollectorListing } from "./collector-listing-choice.ts";
import { loadCollectorStrategyEvidence, type CollectorStrategyEvidence } from "./collector-strategy-evidence.ts";
import { isSearchDiagnosticId } from "./search-diagnostic-store.ts";

const share = createSharedWork();
const locked = createKeyedLock();
const runKey = (id: string) => `private-live-collector:v1:${id}`;
const latestKey = (source: string) => `private-latest-live-collector:v1:${source}`;
const MAX_DETAIL_CHECKS = 4;
const MENU_SIZE = 12;
export class LiveCollectorInputError extends Error {}

export async function checkLiveListings(runId: string, sourceSearchId: string, maxTotal: number,
    saved: CollectorStrategyEvidence, asOf: string, signal: AbortSignal,
    { discover = discoverCollectorListings, choose = chooseCollectorListing, verify = verifyCollectorListing, reuseRecentListings = false } = {}): Promise<LiveCollectorReport> {
    const { reference, query } = saved;
    const estimate = soldMarketPrice(reference.summary);
    if (estimate === null) throw new StorageUnavailableError("The saved exact-slab prices could not be verified.");
    const card = reference.name;
    const slab = `${reference.grader} ${reference.grade}`;
    const number = reference.cardNumber.split("/")[0];
    const cacheMode = reuseRecentListings ? "resume" : "refresh";
    const exact = await discover(`${card} ${number} ${slab}`, reference, signal, { cacheMode });
    const possible = (total: number) => cents(total) <= cents(maxTotal);
    // The wider pass finds listings that omit the number or are filed as raw. Item price
    // alone cannot exceed an all-in limit, even with free shipping and zero tax.
    const pages = [exact];
    const affordableExact = exact.candidates.filter(row => possible(row.minimumTotal)).length;
    if (affordableExact < MAX_DETAIL_CHECKS) {
        pages.push(await discover(`${card} ${slab}`, reference, signal, { cacheMode, maxPrice: maxTotal, includeUngraded: true }));
    }
    if (affordableExact === 0) {
        // eBay may carry the grade in the item specifics while the seller's
        // title only gives the collector number. Verify the holder in detail.
        pages.push(await discover(`${card} ${number}`, reference, signal, { cacheMode, maxPrice: maxTotal }));
    }
    const unique = new Map(pages.flatMap(page => page.candidates.map(row => [row.id, row] as const)));
    const withinBudgetAtScreening = [...unique.values()].filter(row => possible(row.minimumTotal)).length;
    const previousMatch = saved.listing.identity === "LISTING" ? undefined : parseListingLink(saved.listing.url)?.itemId;
    let pending = [...unique.values()].sort((a, b) => a.minimumTotal - b.minimumTotal);
    const steps: LiveCollectorReport["steps"] = [];
    const titleExclusions: NonNullable<LiveCollectorReport["titleExclusions"]> = [];
    let best: LiveCollectorReport["listing"];
    let verifiedAt: string | undefined;
    while (steps.length < MAX_DETAIL_CHECKS && titleExclusions.length < MAX_DETAIL_CHECKS && pending.length) {
        signal.throwIfAborted();
        // Show a known exact copy alongside cheap leads. An entirely different
        // release can be cheaper than every legitimate copy in the search.
        const pool = pending.filter(row => !best || row.minimumTotal < best.total);
        const baseline = pool.find(row => row.id === previousMatch);
        let menu = pool.slice(0, MENU_SIZE);
        if (baseline && !menu.includes(baseline)) menu = [...menu.slice(0, MENU_SIZE - 1), baseline];
        if (!best && baseline && steps.length === MAX_DETAIL_CHECKS - 1) menu = [baseline];
        if (!menu.length) break;
        const choice = await choose({ searchId: sourceSearchId, query, asOf, target: maxTotal,
            reference: { estimate, count: reference.summary.count }, candidates: menu, previousMatch,
            checked: steps.map(step => ({ id: step.listingId, outcome: step.outcome })) }, signal);
        if (choice.id === "skip_menu") {
            const ids = new Set(menu.map(row => row.id));
            titleExclusions.push({ listings: menu.map(({ id, title }) => ({ id, title })), reason: choice.reason });
            pending = pending.filter(row => !ids.has(row.id));
            continue;
        }
        const selected = menu.find(row => row.id === choice.id);
        if (!selected) throw new Error("The selected listing was outside the offered choices.");
        const result = await verify(selected, reference, saved, signal);
        const match = result.listing;
        let outcome = result.reason;
        if (match?.pricing) {
            const total = match.pricing.totalCost;
            const seller = match.seller;
            const concern = Boolean(match.concerns?.length || (seller?.feedbackScore != null && seller.feedbackScore < 10) ||
                (seller?.feedbackPercentage != null && seller.feedbackPercentage < 98));
            outcome += ` ${dollars(total)} including shipping and estimated tax.`;
            if (concern) outcome += " Seller or slab-condition concerns kept this copy out of the recommendation.";
            else if (Number.isFinite(total) && total > 0 && (!best || cents(total) < cents(best.total))) {
                best = { title: match.title, url: match.url, price: match.price, shipping: match.shipping, total };
                verifiedAt = match.checkedAt;
            }
        }
        steps.push({ listingId: selected.id, title: selected.title, reason: choice.reason, outcome });
        pending = pending.filter(row => row.id !== selected.id);
        if (best && possible(best.total)) break;
    }
    signal.throwIfAborted();
    const checkedAt = new Date().toISOString();
    if (best && !(verifiedAt && Date.parse(checkedAt) - Date.parse(verifiedAt) <= BEST_BUY_TERMS_MAX_AGE_MS)) {
        throw new Error("The verified purchase terms expired before the live comparison finished.");
    }
    const decision = best && possible(best.total) ? "BUY" : "WAIT";
    const reason = decision === "BUY" ? `The exact slab is available for ${dollars(best!.total)} including shipping and estimated tax, within your ${dollars(maxTotal)} limit.`
        : best ? `The lowest verified copy was ${dollars(best.total)}, ${dollars(best.total - maxTotal)} above your all-in limit. No checked copy qualified.`
        : `No checked listing established an available exact slab at or below ${dollars(maxTotal)} including shipping and estimated tax.`;
    return { runId, sourceSearchId, checkedAt, decision, maxTotal, reason, steps, fetched: pages.reduce((sum, p) => sum + p.fetched, 0),
        candidates: unique.size, withinBudgetAtScreening, ...(titleExclusions.length && { titleExclusions }), ...(best && { listing: best }) };
}

async function readRun(runId: string) {
    const report = await readCache<LiveCollectorReport>(runKey(runId), Infinity);
    if (report !== null && (report.runId !== runId || !isSearchDiagnosticId(report.sourceSearchId) ||
        !Number.isFinite(Date.parse(report.checkedAt)) || !["BUY","WAIT"].includes(report.decision) ||
        !Number.isFinite(report.maxTotal) || !Array.isArray(report.steps))) throw new StorageUnavailableError("Invalid saved live comparison.");
    return report;
}

export async function latestLiveCollector(source: string) {
    const id = await readCache<string>(latestKey(source), Infinity);
    if (id === null) return null;
    if (!isSearchDiagnosticId(id)) throw new StorageUnavailableError("Invalid saved live comparison reference.");
    const report = await readRun(id);
    if (!report || report.sourceSearchId !== source) throw new StorageUnavailableError("The saved live comparison could not be read.");
    return report;
}

export async function runLiveCollector(runId: string, source: string, maxTotal: number, signal: AbortSignal, reuseRecentListings = false) {
    if (!isSearchDiagnosticId(runId) || !isSearchDiagnosticId(source) || runId === source || !Number.isSafeInteger(cents(maxTotal)) ||
        cents(maxTotal) <= 0 || cents(maxTotal) / 100 !== maxTotal) throw new LiveCollectorInputError("Use a separate run ID, a saved search and a positive all-in limit in dollars and cents.");
    const mismatch = () => new LiveCollectorInputError("This run ID already belongs to another search or limit.");
    const report = await share(runKey(runId), async active => {
        const previous = await readRun(runId);
        if (previous) return previous;
        const zip = configuredShippingZip();
        if (!zip) throw new LiveCollectorInputError("Set a shipping ZIP before checking live purchase totals.");
        const saved = await loadCollectorStrategyEvidence(source);
        if (!saved) throw new LiveCollectorInputError("This search has no saved exact-slab sales to compare.");
        const key = runKey(runId) + ":request";
        const request = await readCache<{source: string; maxTotal: number; zip: string; asOf: string}>(key, Infinity);
        if (request && (request.source !== source || request.maxTotal !== maxTotal || request.zip !== zip)) throw mismatch();
        const asOf = request?.asOf ?? new Date().toISOString();
        if (!request) await writeCache(key, { source, maxTotal, zip, asOf });
        const report = await withAiUsageContext({ searchId: source }, () => checkLiveListings(runId, source, maxTotal, saved, asOf, active,
            { reuseRecentListings: reuseRecentListings || request !== null }));
        await writeCache(runKey(runId), report);
        return report;
    }, signal);
    if (report.sourceSearchId !== source || report.maxTotal !== maxTotal) throw mismatch();
    await locked(source, async () => {
        const current = await latestLiveCollector(source);
        if (!current || current.checkedAt < report.checkedAt) await writeCache(latestKey(source), runId);
    });
    return report;
}

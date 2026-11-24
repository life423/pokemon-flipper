import type { CollectorStrategyReport, CollectorStrategyState } from "../../shared/collector-strategy.ts";
import { dollars } from "../../shared/format.ts";
import { parseListingLink } from "../../shared/listing-link.ts";
import { cents } from "../../shared/money/cents.ts";
import { soldMarketPrice } from "../../shared/sold-evidence.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { StorageUnavailableError } from "../storage/index.ts";
import { loadCollectorStrategyEvidence } from "./collector-strategy-evidence.ts";
import { runCollectorStrategy } from "./collector-strategy.ts";

const share = createSharedWork();
const reportKey = (id: string) => `private-collector-guide:v1:${id}`;

async function savedReport(id: string) {
    const report = await readCache<CollectorStrategyReport>(reportKey(id), Infinity);
    if (report !== null && (report.searchId !== id || !["BUY", "WAIT"].includes(report.decision) ||
        !Array.isArray(report.steps) || typeof report.reason !== "string" || !Number.isFinite(Date.parse(report.asOf)))) {
        throw new StorageUnavailableError("The saved collector decision could not be read.");
    }
    return report;
}

export async function collectorGuideState(id: string): Promise<CollectorStrategyState> {
    const report = await savedReport(id);
    return { available: Boolean(report || await loadCollectorStrategyEvidence(id)), report };
}

export function runCollectorGuide(id: string, signal: AbortSignal): Promise<CollectorStrategyReport | null> {
    return share(reportKey(id), async active => {
        const existing = await savedReport(id);
        if (existing) return existing;
        const evidence = await loadCollectorStrategyEvidence(id);
        if (!evidence) return null;
        const { listing, reference, query, asOf, label } = evidence;
        const pricing = listing.pricing;
        const estimate = soldMarketPrice(reference.summary);
        const link = parseListingLink(listing.url);
        if (estimate === null || !pricing || cents(estimate) !== cents(pricing.resale) || !link ||
            !(pricing.totalCost > 0) || !Number.isFinite(pricing.totalCost) || !Number.isFinite(pricing.profit)) {
            throw new StorageUnavailableError("The saved listing and sale evidence do not agree.");
        }
        const fixedPriceSales = reference.summary.sales.filter(sale => sale.saleType === "fixed_price")
            .sort((a, b) => b.soldAt.localeCompare(a.soldAt)).slice(0, 2)
            .map(({ price, soldAt, url }) => ({ price, soldAt, url: parseListingLink(url)?.url ?? null }));
        const { steps } = await runCollectorStrategy({ searchId: id, query, asOf, checks: {
            check_listing: async () => ({ activeAtCapture: true, itemPrice: listing.price, shipping: listing.shipping, totalCost: pricing.totalCost }),
            check_sales: async () => ({ estimate, matchedCount: reference.summary.count, grader: reference.grader, grade: reference.grade, fixedPriceSales }),
            ...(label && { check_label: async () => ({ matched: true, grader: label.grader, grade: label.grade, source: label.source }) }),
        } }, active);
        const checked = new Set(steps.map(step => step.action));
        const compared = checked.has("check_listing") && checked.has("check_sales");
        const premium = (cents(pricing.totalCost) - cents(estimate)) / 100;
        const seller = listing.seller;
        const risk = Boolean(listing.concerns?.length || seller?.feedbackScore != null && seller.feedbackScore < 10 ||
            seller?.feedbackPercentage != null && seller.feedbackPercentage < 98);
        const decision = compared && premium <= 0 && checked.has("check_label") && !risk ? "BUY" : "WAIT";
        let reason = "The saved checks did not establish both the purchase total and a matching resale market.";
        if (compared) {
            if (premium > 0) reason = `The purchase total is ${dollars(premium)} above the matched sold estimate. Look for a copy at ${dollars(estimate)} or less including shipping and tax.`;
            else if (risk) reason = "The saved seller or holder concerns warrant another look before buying this copy.";
            else if (!checked.has("check_label")) reason = "The price fits the market, but these checks did not confirm this slab’s identity and grade from its label.";
            else reason = "The checked slab matches the requested printing and grade, and its purchase total is within the matched sold estimate.";
        }
        const report: CollectorStrategyReport = {
            searchId: id, query, asOf, decision, reason,
            ...(checked.has("check_listing") && { listing: { title: listing.title, url: link.url, price: listing.price, shipping: listing.shipping, total: pricing.totalCost } }),
            ...(checked.has("check_sales") && { market: { estimate, count: reference.summary.count, fixedPriceSales } }),
            ...(compared && { resaleProfit: pricing.profit }),
            steps: steps.map(({ action, reason, chosenBy }) => ({ action, reason, chosenBy })),
        };
        await writeCache(reportKey(id), report);
        return report;
    }, signal);
}

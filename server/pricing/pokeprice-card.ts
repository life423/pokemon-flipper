import { DomUtils, parseDocument } from "htmlparser2";
import { sameCardNumber } from "../../shared/card-number.ts";
import { setKey } from "../../shared/sets.ts";
import type { Identity } from "../../shared/types.ts";
import { parseListingLink } from "../../shared/listing-link.ts";
import { sameCatalogName } from "../identity/catalog-name.ts";
import { requireLiveProvider } from "../lib/saved-provider-evidence.ts";
import { storageFailure } from "../lib/storage-failure.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { fetchMarketHtml } from "./daily-market-import.ts";
import { readMarketData, saveMarketData } from "./market-cache.ts";
import { parsePokePriceDetail } from "./pokeprice-movers.ts";

const origin = "https://www.pokeprice.gg";
const share = createSharedWork();
function page<T>(path: string, hours: number, parse: (html: string) => T, signal: AbortSignal) {
    const key = "pokeprice:catalog:v1:" + path;
    return share(key, async active => {
        const cached = await readMarketData(key, hours);
        if (cached != null) return cached as T;
        requireLiveProvider("POKEPRICE");
        const result = parse(await fetchMarketHtml(origin + path, fetch, active));
        await saveMarketData(key, result);
        return result;
    }, signal);
}

function links(html: string, kind: "cards" | "sets") {
    return DomUtils.findAll(el => el.name === "a" && el.attribs.href?.startsWith("/" + kind + "/"), parseDocument(html))
        .flatMap(el => {
            const path = el.attribs.href;
            if (!/^\/(?:sets|cards)\/[a-z0-9.-]+$/i.test(path)) return [];
            const labels = DomUtils.findAll(child => child.name === "p", el).map(child => DomUtils.textContent(child).trim());
            return labels.length >= 2 ? [{ path, name: labels[kind === "sets" ? 0 : 1], number: labels[0].replace(/^#/, "") }] : [];
        });
}

// This is the public card page's "Load recent sold prices" response. Its feed
// includes other marketplaces and can explicitly suppress ambiguous grades.
export function pokePriceSales(payload: unknown, sku: string, now: number) {
    const data = payload as { cardId?: string; fetchedAt?: string; gradedHidden?: boolean; sales?: unknown[] } | null;
    const fetched = Date.parse(data?.fetchedAt ?? "");
    if (data?.cardId !== sku || typeof data.gradedHidden !== "boolean" || !Array.isArray(data.sales) ||
        // A just-generated response can be slightly ahead of the local clock.
        // Actual sale timestamps below still have to be in the past.
        !(fetched <= now + 30_000 && now - fetched <= 7 * 86400000)) return null;
    const seen = new Set<string>();
    const sales = data.sales.flatMap(input => {
        const row = input as { source?: string; grade?: string; grader?: string; price?: number; currency?: string; soldAt?: string; url?: string } | null;
        const at = Date.parse(row?.soldAt ?? "");
        if (row?.source !== "ebay" || (row.currency != null && row.currency !== "USD") ||
            typeof row.grade !== "string" || typeof row.price !== "number" || !Number.isFinite(row.price) ||
            row.price <= 0 || !(at <= now && now - at <= 90 * 86400000) || data.gradedHidden && row.grader != null) return [];
        const url = typeof row.url === "string" ? parseListingLink(row.url)?.url ?? null : null;
        const key = url ?? JSON.stringify([row.soldAt, row.grade, row.price]);
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ price: row.price, soldAt: new Date(at).toISOString(), grade: row.grade.slice(0, 32), url }];
    }).sort((a, b) => b.soldAt.localeCompare(a.soldAt));
    return { asOf: data.fetchedAt!, sales };
}

// Resolve the provider's own catalog first. Edition and wear can be pooled on
// the resulting page; these figures remain labeled context for the reviewer.
export async function pokePriceCard(identity: Identity, signal: AbortSignal) {
    if (!identity.set || !identity.cardNumber) return null;
    const sets = await page("/sets", 24, html => links(html, "sets"), signal);
    const canonical = (name: string) => setKey(name === "Base" ? "Base Set" : name);
    const matched = sets.filter(row => canonical(row.name) === canonical(identity.set!));
    if (matched.length !== 1) return null;
    const [set] = matched;
    const cards = await page(set.path, 24, html => links(html, "cards"), signal);
    const exact = cards.filter(row => sameCatalogName(row.name, identity.name) && sameCardNumber(row.number, identity.cardNumber));
    if (exact.length !== 1) return null;
    const [card] = exact;
    const sku = card.path.slice("/cards/".length);
    const detail = await page(card.path, 1, html => parsePokePriceDetail(html, {
        name: card.name, set: set.name, number: card.number, sku,
    }, Date.now()), signal);
    const receipts = await page("/api/card-sales/" + sku, 1, body => pokePriceSales(JSON.parse(body), sku, Date.now()), signal).catch(error => {
        signal.throwIfAborted();
        if (storageFailure(error)) throw error;
        return null;
    });
    return { url: origin + card.path, scope: "Catalog card; raw sales can pool wear and editions. eBay sales can overlap Silph Co.", ...detail, receipts };
}

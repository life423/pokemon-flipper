import { requireLiveProvider } from "../lib/saved-provider-evidence.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DomUtils, parseDocument } from "htmlparser2";
import { writeJsonAtomic } from "../lib/atomic-json.ts";
import { withFileLease } from "../lib/file-lease.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import type { ProviderPrice } from "../../shared/listing-market-prices.ts";
import { SALES_ACTIVITY_DAYS } from "../../shared/sales-activity.ts";
import { median } from "../../shared/sold-evidence.ts";
import { matchedPriceChartingProduct } from "../../shared/pricecharting-product.ts";
import { observedPriceChange, type DailyPrice } from "../../shared/price-history.ts";
import { finishClaim } from "../../shared/finish.ts";
import { printingClaimFromText } from "../../shared/identity.ts";
import { parseListingLink } from "../../shared/listing-link.ts";
import { gradeQualifier, hasSpecialSlabTitle } from "../../shared/grade-qualifier.ts";
import { observedCardKind } from "../../shared/photo-evidence.ts";
import type { Evaluation, Identity } from "../../shared/types.ts";
import { matchesSoldTarget, readSoldTitleClaims } from "./sold-comps.ts";
import { DATA_DIR } from "../lib/paths.ts";
import { getSqlRepositories, storageBackend, type SqlRepositories } from "../storage/index.ts";

interface Product { id: string; url: string }
interface HistoricalSale {
    source: string; transactionId: string; soldOn: string; price: number; title: string; url: string | null;
    guideBuckets: string[]; bucketConflict?: true;
}
interface Observation extends Product {
    observedAt: string; currency: "USD"; prices: Record<string, number>;
    monthlyGuide?: Record<string, DailyPrice[]>;
    history: { coverage: "PRODUCT_PAGE"; advertised: Record<string, number>; unreadableRows: number; unpublishedRows?: number; sales: HistoricalSale[] };
}
type GuideDatabase = Pick<SqlRepositories, "claimTask" | "completeTask" | "releaseTask" | "importCacheEntries">;
class GuideSourceError extends Error {}
interface Claim extends Product { claim: string; expires: number }

function validateProduct(product: Product) {
    if (typeof product.id !== "string" || typeof product.url !== "string" || !/^\d+$/.test(product.id) ||
        !/^https:\/\/www\.pricecharting\.com\/game\/pokemon-[a-z0-9-]+\/[a-z0-9-]+$/.test(product.url))
        throw new Error("Supply the exact Pokémon product URL and numeric PriceCharting product ID.");
}

// Product guides have generic grade columns as well as explicitly named graders.
// Keep the original label and verify each column against its corresponding cell ID.
const priceColumns: Record<string, string> = {
    Ungraded: "used_price", "Grade 7": "complete_price", "Grade 8": "new_price",
    "Grade 9": "graded_price", "Grade 9.5": "box_only_price", "PSA 10": "manual_only_price",
};
const saleTabs = { used: "Ungraded", cib: "Grade 7", new: "Grade 8", graded: "Grade 9" } as const;
// These additional histories share the product page. Some pages omit a tab.
const additionalSaleTabs = {
    "loose-and-manual": "Grade 1", "box-and-manual": "Grade 2", "grade-three": "Grade 3",
    "grade-four": "Grade 4", "grade-five": "Grade 5", "grade-six": "Grade 6", "box-only": "Grade 9.5",
    "manual-only": "PSA 10", "loose-and-box": "BGS 10", "grade-seventeen": "CGC 10",
    "grade-eighteen": "SGC 10", "grade-nineteen": "CGC 10 Prist.", "grade-twenty": "BGS 10 Black",
    "grade-twenty-one": "TAG 10", "grade-twenty-two": "ACE 10",
};

function publishedHistory(doc: ReturnType<typeof parseDocument>): Observation["history"] {
    const selector = DomUtils.findOne(el => el.attribs.id === "completed-auctions-condition", doc);
    if (!selector) throw new Error("Missing sales history index.");
    const sales = new Map<string, HistoricalSale>(), advertised: Record<string, number> = {};
    let unreadableRows = 0, unpublishedRows = 0;
    for (const [tab, bucket] of Object.entries({ ...saleTabs, ...additionalSaleTabs })) {
        const key = "completed-auctions-" + tab;
        const option = DomUtils.findOne(el => el.name === "option" && el.attribs.value === key, selector);
        if (!option && Object.hasOwn(additionalSaleTabs, tab)) continue;
        const heading = option && /^(.*?)\s*\((\d+)\)$/.exec(DomUtils.textContent(option).trim());
        if (!heading || heading[1].trim() !== bucket) throw new Error("Sales history grade label changed.");
        advertised[bucket] = Number(heading[2]);
        const panel = DomUtils.findOne(el => el.name === "div" && el.attribs.class === key, doc);
        if (!panel && advertised[bucket]) throw new Error("Missing sales history for " + bucket);
        if (!panel) continue;
        const rows = DomUtils.findAll(el => el.name === "tr" && Boolean(DomUtils.findOne(cell => cell.name === "td" && cell.attribs.class === "date", el)), panel);
        for (const row of rows) {
            const id = /^([a-z0-9]+)-([^\s]{1,500})$/i.exec(row.attribs.id ?? "");
            const cell = (name: string) => DomUtils.findOne(el => el.name === "td" && el.attribs.class === name, row);
            const date = cell("date"), amount = cell("numeric"), title = cell("title");
            const link = title && DomUtils.findOne(el => el.name === "a" && /^https?:\/\//i.test(el.attribs.href ?? ""), title);
            const soldOn = date && DomUtils.textContent(date).trim();
            const sold = amount && DomUtils.findOne(el => el.name === "span" &&
                el.attribs.class?.split(/\s+/).includes("js-price") && !/listed-price|list price/i.test((el.attribs.class ?? "") + " " + (el.attribs.title ?? "")), amount);
            const priceText = sold && DomUtils.textContent(sold).trim();
            const price = priceText && /^\$(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/.test(priceText) ? Number(priceText.slice(1).replaceAll(",", "")) : 0;
            const saleTitle = title && DomUtils.textContent(link ?? title).replace(/\s+/g, " ").trim();
            if (!id || !saleTitle || !soldOn || !/^\d{4}-\d{2}-\d{2}$/.test(soldOn) || !(Number.isFinite(Date.parse(soldOn)) && new Date(soldOn).toISOString().slice(0, 10) === soldOn) || price <= 0) {
                unreadableRows++; continue;
            }
            const previous = sales.get(id[0]);
            if (previous) {
                if (previous.price !== price || previous.soldOn !== soldOn) throw new Error("Conflicting transaction amounts or dates.");
                if (!previous.guideBuckets.includes(bucket)) previous.guideBuckets.push(bucket);
            } else sales.set(id[0], { source: id[1], transactionId: id[2], soldOn, price, title: saleTitle,
                url: link?.attribs.href ?? null, guideBuckets: [bucket] });
        }
        unpublishedRows += Math.max(0, advertised[bucket] - rows.length);
    }
    for (const sale of sales.values()) {
        const grade = /\b(PSA|CGC|BGS|SGC|TAG|ACE)\s*(10|[1-9](?:\.5)?)\b/i.exec(sale.title);
        const bucket = sale.guideBuckets[0];
        if (sale.guideBuckets.length > 1 || grade && bucket !== "Grade " + grade[2] &&
            bucket.split(" ").slice(0, 2).join(" ") !== grade[1].toUpperCase() + " " + grade[2]) sale.bucketConflict = true;
    }
    return { coverage: "PRODUCT_PAGE", advertised, unreadableRows, unpublishedRows, sales: [...sales.values()] };
}

export function readPriceChartingGuide(html: string, product: Product, observedAt: string): Observation {
    validateProduct(product);
    const doc = parseDocument(html);
    const byId = (id: string) => DomUtils.findOne(el => el.attribs.id === id, doc);
    const canonical = DomUtils.findOne(el => el.name === "link" && el.attribs.rel === "canonical", doc);
    const currency = byId("dropdown_selected_currency");
    if (canonical?.attribs.href !== product.url || byId("product_name")?.attribs.title !== product.id ||
        !currency || DomUtils.textContent(currency).trim() !== "USD") throw new Error("Product identity or currency does not match.");
    const table = byId("price_data");
    const head = table && DomUtils.findOne(el => el.name === "thead", table);
    const body = table && DomUtils.findOne(el => el.name === "tbody", table);
    const firstRow = body && DomUtils.findOne(el => el.name === "tr", body);
    if (!head || !firstRow) throw new Error("Missing guide table.");
    const headings = DomUtils.findAll(el => el.name === "th", head);
    const cells = DomUtils.findAll(el => el.name === "td" && !!el.attribs.id, firstRow);
    if (!headings.length || headings.length !== cells.length) throw new Error("Guide columns changed.");
    const prices: Record<string, number> = {};
    for (const [i, heading] of headings.entries()) {
        const label = DomUtils.textContent(heading).trim(), cell = cells[i];
        if (priceColumns[label] !== cell.attribs.id) throw new Error("Unrecognized guide column.");
        const amount = DomUtils.findOne(el => el.name === "span" && el.attribs.class?.split(/\s+/).includes("price"), cell);
        if (!amount) continue;
        const value = DomUtils.textContent(amount).trim();
        if (!/^\$(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/.test(value)) continue;
        const usd = Number(value.slice(1).replaceAll(",", ""));
        if (usd > 0) prices[label] = usd;
    }
    if (!Object.keys(prices).length) throw new Error("No current USD guide values found.");
    const full = byId("full-prices");
    const guideLabels = new Set<string>([...Object.values(saleTabs), ...Object.values(additionalSaleTabs), "CGC 10 Pristine"]);
    for (const row of full ? DomUtils.findAll(el => el.name === "tr", full) : []) {
        const cells = DomUtils.findAll(el => el.name === "td" && el.parent === row, row);
        if (cells.length !== 2) continue;
        const label = DomUtils.textContent(cells[0]).trim(), amount = DomUtils.textContent(cells[1]).trim();
        if (!guideLabels.has(label) || prices[label] || !/^\$(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/.test(amount)) continue;
        const price = Number(amount.slice(1).replaceAll(",", ""));
        if (price > 0) prices[label] = price;
    }
    const monthlyGuide: Record<string, DailyPrice[]> = {};
    const chart = /\bVGPC\.chart_data\s*=\s*(\{[^;]+\})\s*;/.exec(html)?.[1];
    if (chart && chart.length < 400_000) {
        let series;
        try { series = JSON.parse(chart); } catch { /* An optional chart can change independently of sales. */ }
        for (const [key, label] of Object.entries({ ...saleTabs, boxonly: "Grade 9.5", manualonly: "PSA 10" })) {
            const points = series?.[key];
            if (!Array.isArray(points)) continue;
            const dates = new Map<string, number>();
            for (const point of points) {
                if (!Array.isArray(point) || !Number.isSafeInteger(point[0]) || point[0] < Date.UTC(1996, 0) ||
                    point[0] > Date.parse(observedAt) || !Number.isSafeInteger(point[1]) || point[1] <= 0) continue;
                dates.set(new Date(point[0]).toISOString().slice(0, 10), point[1] / 100);
            }
            if (dates.size) monthlyGuide[label] = [...dates].sort(([a], [b]) => a.localeCompare(b)).map(([day, price]) => ({ day, price }));
        }
    }
    return { ...product, observedAt, currency: "USD", prices, ...(Object.keys(monthlyGuide).length && { monthlyGuide }), history: publishedHistory(doc) };
}

// A reusable import for one exact product. Each UTC day's successful observation
// is immutable. A failed or interrupted attempt leaves earlier days available.
export async function importPriceChartingGuide(product: Product, { directory = path.join(DATA_DIR, "pricecharting"),
    fetchPage = fetch, now = Date.now, database, signal }: { directory?: string; signal?: AbortSignal; fetchPage?: typeof fetch; now?: () => number; database?: GuideDatabase } = {}) {
    validateProduct(product);
    const start = now(), at = new Date(start).toISOString(), claim = randomUUID();
    const fetchObservation = async () => {
        const timeout = AbortSignal.timeout(15_000);
        try {
            requireLiveProvider("PRICECHARTING");
            const response = await fetchPage(product.url, { redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
            if (!response.ok) throw new Error("Guide request returned HTTP " + response.status);
            return readPriceChartingGuide(await response.text(), product, at);
        } catch (cause) {
            signal?.throwIfAborted();
            throw new GuideSourceError(cause instanceof Error ? cause.message : "Guide request failed.", { cause });
        }
    };
    if (database || storageBackend() === "azure-sql") {
        const repo = database ?? await getSqlRepositories();
        const key = "pricecharting:product-history:v2:" + product.id + ":" + at.slice(0, 10);
        const reservation = await repo.claimTask({ key, type: "PRICECHARTING_PRODUCT_HISTORY",
            inputHash: createHash("sha256").update(product.url).digest("hex"), ownerId: claim });
        if (!reservation.claimed) {
            const saved = reservation.result as Observation | null;
            if (reservation.state === "COMPLETED" && saved?.url === product.url && saved.id === product.id && Array.isArray(saved.history?.sales)) return saved;
            throw new GuideSourceError("The guide observation is unavailable or in progress.");
        }
        try {
            const observation = await fetchObservation();
            const rows = observation.history.sales.map(sale => ({ key: "pricecharting:sale:" + JSON.stringify([product.id, sale.source, sale.transactionId]),
                savedAt: at, data: { ...product, ...sale, currency: observation.currency } }));
            for (let start = 0; start < rows.length; start += 500) await repo.importCacheEntries(rows.slice(start, start + 500));
            await repo.completeTask(key, claim, observation);
            return observation;
        } catch (error) {
            await repo.releaseTask(key, claim);
            throw error;
        }
    }
    const file = path.join(directory, "history-v2", product.id, at.slice(0, 10) + ".json");
    const read = async (): Promise<Claim | Observation | null> => {
        try { return JSON.parse(await fs.readFile(file, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    };
    const locked = <T>(work: () => Promise<T>) => withFileLease(file, work, { timeoutError: () => new Error("Guide storage is busy.") });
    const existing = await locked(async () => {
        const saved = await read();
        if (saved && (saved.id !== product.id || saved.url !== product.url)) throw new Error("Product ID has a conflicting URL.");
        if (saved && "prices" in saved) return saved;
        if (saved && saved.expires > start) throw new GuideSourceError("A guide check is in progress.");
        await writeJsonAtomic(file, { ...product, claim, expires: start + 120_000 });
        return null;
    });
    if (existing) return existing;
    try {
        const observation = await fetchObservation();
        await locked(async () => {
            const saved = await read();
            if (!saved || !("claim" in saved) || saved.claim !== claim) throw new Error("Guide claim expired.");
            await writeJsonAtomic(file, observation);
        });
        return observation;
    } catch (error) {
        await locked(async () => {
            const saved = await read();
            if (saved && "claim" in saved && saved.claim === claim) await fs.unlink(file);
        });
        throw error;
    }
}

// The page provides sale dates at day precision and may truncate a busy market.
function publishedActivity(guide: Observation): string {
    const last = Date.parse(guide.observedAt.slice(0, 10));
    const first = last - (SALES_ACTIVITY_DAYS - 1) * 86_400_000;
    const recent = guide.history.sales.filter(sale => {
        const date = Date.parse(sale.soldOn);
        return !sale.bucketConflict && sale.guideBuckets.length === 1 && date >= first && date <= last;
    });
    const rows = Object.keys(guide.history.advertised).filter(label => guide.history.advertised[label] > 0 ||
        Object.values(saleTabs).some(required => required === label)).map(label => {
        const sales = recent.filter(sale => sale.guideBuckets[0] === label);
        if (!sales.length) return label + ": 0 observed";
        const days = new Set(sales.map(sale => sale.soldOn)).size;
        const typical = median(sales.map(sale => sale.price));
        return `${label}: ${sales.length} observed, ${days} selling ${days === 1 ? "day" : "days"}, ${(sales.length / SALES_ACTIVITY_DAYS).toFixed(2)}/day, median $${typical.toFixed(2)}`;
    });
    return `Published sales in the last ${SALES_ACTIVITY_DAYS} calendar days ending ${guide.observedAt.slice(0, 10)} (partial coverage). ${rows.join(". ")}.`;
}

const shareGuide = createSharedWork();

function guideLabel(value: Evaluation) {
    const kind = observedCardKind(value);
    if (kind === "raw") return "Ungraded";
    const slab = value.slab;
    if (kind !== "graded" || !slab?.grader || !slab.grade) return null;
    const qualifier = gradeQualifier(slab.gradeQualifier, slab.grader, String(slab.grade));
    if (qualifier && Number(slab.grade) === 10) {
        if (slab.grader === "CGC" && /^pristine$/i.test(qualifier)) return "CGC 10 Pristine";
        if (slab.grader === "BGS" && /^black label$/i.test(qualifier)) return "BGS 10 Black";
    }
    if (qualifier || hasSpecialSlabTitle(slab.labelText ?? "")) return null;
    return Number(slab.grade) === 10 ? slab.grader + " 10" : "Grade " + slab.grade;
}

function comparableGuideTrend(guide: Observation, label: string) {
    const since = Date.parse(guide.observedAt) - 120 * 86_400_000;
    const points = guide.monthlyGuide?.[label]?.filter(point => Date.parse(point.day) >= since);
    if (!points?.length) return;
    const last = points[points.length - 1];
    if (Date.parse(guide.observedAt) - Date.parse(last.day) > 40 * 86_400_000) return;
    const change = observedPriceChange(points);
    if (!change) return;
    const scope = label === "Ungraded" ? "across raw conditions" : label.startsWith("Grade ") ? "across graders" : "same grader";
    return `${label} monthly guide (${scope}) changed ${change.percent > 0 ? "+" : ""}${change.percent.toFixed(1)}% from ${points[0].day} to ${last.day}.`;
}

function ebayActivity(guide: Observation, value: Evaluation) {
    const id = value.identity, kind = observedCardKind(value), slab = value.slab;
    if (!id?.name || !id.set || !id.cardNumber || !kind) return;
    const label = guideLabel(value);
    if (!label || / (Pristine|Black)$/.test(label) || !Object.hasOwn(guide.history.advertised, label)) return;
    const seen = new Map<string, Set<number>>();
    const comps = [value.slabPricing?.summary, value.rawPricing?.sellerConditionComps, ...(value.rawPricing?.prices ?? []).map(row => row.comps),
        ...Object.values(value.gradedPricing ?? {}).flatMap(row => row.byGrade ?? [])];
    for (const group of comps) for (const sale of [...(group?.sales ?? []), ...(group?.activitySales ?? [])]) {
        const key = parseListingLink(sale.url)?.itemId;
        if (!key) continue;
        const itemId = key.split("|")[1], prices = seen.get(itemId) ?? new Set<number>();
        if (Number.isFinite(sale.price) && sale.price > 0) prices.add(Math.round(sale.price * 100));
        seen.set(itemId, prices);
    }
    const last = Date.parse(guide.observedAt.slice(0, 10));
    const first = last - 29 * 86_400_000;
    const market = kind === "raw" ? "ungraded, across conditions" : slab!.grader + " " + slab!.grade;
    const found = new Set<string>();
    const additionalSales: { date: string; priceUsd: number; url: string }[] = [];
    let overlap = 0, disagreements = 0;
    for (const sale of guide.history.sales) {
        const date = Date.parse(sale.soldOn);
        if (sale.source.toLowerCase() !== "ebay" || sale.bucketConflict || sale.guideBuckets.length !== 1 ||
            sale.guideBuckets[0] !== label || date < first || date > last || !Number.isFinite(date)) continue;
        const key = parseListingLink(sale.transactionId)?.itemId.split("|")[1];
        if (!key || parseListingLink(sale.url)?.itemId.split("|")[1] !== key || found.has(key)) continue;
        const printing = printingClaimFromText(sale.title), finish = finishClaim(sale.title);
        // A source tab can mix regular and reverse copies of the same number.
        // Preserve ambiguous rows in the imported history, outside the exact-copy sample.
        if (finish !== id.finish || (printing !== "NOT_STATED" ? printing !== id.printing : id.hasEditions || id.printing !== "UNLIMITED")) continue;
        const claims = readSoldTitleClaims(sale.title, [id.set]);
        if (!claims.cardNumber || !matchesSoldTarget(sale, { name: id.name, setName: id.set, cardNumber: id.cardNumber, requireTitleIdentity: true }) ||
            (kind === "graded" ? hasSpecialSlabTitle(sale.title) || claims.grader !== slab!.grader || Number(claims.grade) !== Number(slab!.grade) : !!claims.grader)) continue;
        found.add(key);
        const previous = seen.get(key);
        if (previous) {
            overlap++;
            if (previous.size && (previous.size !== 1 || !previous.has(Math.round(sale.price * 100)))) disagreements++;
        } else additionalSales.push({ date: sale.soldOn, priceUsd: sale.price, url: "https://www.ebay.com/itm/" + key });
    }
    const overlapNote = `${overlap} of these already appear in the eBay comparisons.`;
    const discrepancy = disagreements ? `The sources disagree on the price of ${disagreements} shared ${disagreements === 1 ? "transaction" : "transactions"}.` : "";
    const note = [`PriceCharting shows ${found.size} distinct eBay ${found.size === 1 ? "sale" : "sales"} (${market}) in its 30-day sample.`,
        overlapNote, discrepancy, "Additional rows are research leads."].filter(Boolean).join(" ");
    return { note, disagreements, history: { scope: market, sales: additionalSales.sort((a, b) => b.date.localeCompare(a.date)) } };
}

// Use exact, operator-verified product mappings. Similar products can have
// different guide pages even when their name and collector number are identical.
export async function priceChartingComparison(identity: Identity, signal?: AbortSignal, {
    authorized = process.env.PRICECHARTING_BUYER_USE_AUTHORIZED === "true",
    catalog = process.env.PRICECHARTING_PRODUCT_MAP,
    privateResearch = false, load = importPriceChartingGuide, evaluation,
}: { authorized?: boolean; privateResearch?: boolean; catalog?: string; load?: typeof importPriceChartingGuide; evaluation?: Evaluation } = {}): Promise<{
    observation: string; prices: ProviderPrice[]; ebayActivity?: string; trend?: string; recheckSoldPrice?: boolean;
    history?: NonNullable<ReturnType<typeof ebayActivity>>["history"];
    researchGuide?: { basis: string; usd: number; asOf: string };
    researchHistory?: NonNullable<ReturnType<typeof ebayActivity>>["history"];
} | null> {
    if (!authorized && !(privateResearch && process.env.PRICECHARTING_PERSONAL_RESEARCH === "true")) return null;
    const product = matchedPriceChartingProduct(identity, catalog);
    if (!product) return null;
    const { id, url } = product;
    try {
        const guide = await shareGuide(url + "#" + id, active => load({ id, url }, { signal: active }), signal);
        const activity = evaluation && ebayActivity(guide, evaluation);
        const label = evaluation && guideLabel(evaluation);
        const trend = label && comparableGuideTrend(guide, label);
        const recheck = activity?.disagreements ? { recheckSoldPrice: true } : {};
        if (!authorized) {
            // The private reviewer may use the trend. No guide amounts or
            // provider-sourced sale rows leave the personal research path.
            const basis = label === "Ungraded" ? "Ungraded · mixed conditions" : label?.startsWith("Grade ") ? label + " · mixed graders" : label;
            return { prices: [], ...recheck, ...(trend && { trend }),
                ...(label && basis && guide.prices[label] && { researchGuide: { basis, usd: guide.prices[label], asOf: guide.observedAt } }),
                ...(activity && { researchHistory: activity.history }),
                observation: activity?.disagreements ? "Recheck the completed eBay transaction amounts for this copy." :
                    "Checked the historical guide for the identified printing." };
        }
        const prices: ProviderPrice[] = Object.keys(guide.prices).map(label => ({
            source: "PriceCharting", basis: label === "Ungraded" ? "Ungraded guide · mixed conditions" : label.startsWith("Grade ") ? label + " guide · mixed graders" : label + " guide",
            price: guide.prices[label], currency: "USD", asOf: guide.observedAt, validUntil: Date.parse(guide.observedAt) + 86_400_000, url,
        }));
        const labels = prices.map(row => row.basis + " $" + row.price.toFixed(2));
        const conflicts = guide.history.sales.filter(sale => sale.bucketConflict).length;
        return { prices, ...recheck, ...(trend && { trend }), ...(activity && { ebayActivity: activity.note, history: activity.history }), observation: [activity?.note, trend, `PriceCharting guide (${guide.observedAt.slice(0, 10)}), ${labels.join(", ")}. Published product-page history includes ${guide.history.sales.length} distinct transactions, ${conflicts} with conflicting grade labels and ${guide.history.unreadableRows} unreadable or unavailable rows.${guide.history.unpublishedRows ? " Another " + guide.history.unpublishedRows + " advertised rows were absent from the page." : ""} ${publishedActivity(guide)} Ungraded spans conditions and numeric grades can span graders. Verify individual sales before using them to price this copy. ${guide.url}`].filter(Boolean).join(" ") };
    } catch {
        signal?.throwIfAborted();
        return { prices: [], observation: "The PriceCharting comparison is unavailable for this check." };
    }
}

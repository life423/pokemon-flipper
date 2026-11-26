import { silphSetSeeds } from "./silphco.ts";
import type { TradedCard } from "./traded-cards.ts";
import { setTimeout as pause } from "node:timers/promises";
import { DomUtils, parseDocument } from "htmlparser2";
import { fetchMarketHtml, importMarketDay, recentMarketDay, scheduleMarketImport, type MarketImportOptions } from "./daily-market-import.ts";

type Element = ReturnType<typeof DomUtils.findAll>[number];

const prefix = "pokeprice:movers:v1:";
const origin = "https://www.pokeprice.gg";
export const pokePriceMoversUrl = origin + "/movers";
const text = (el: Element) => DomUtils.textContent(el).replace(/\s+/g, " ").trim();
const children = (el?: Element | null) => el ? el.children.filter((child): child is Element => child.type === "tag") : [];
const parent = (el?: Element | null) => el?.parent?.type === "tag" ? el.parent : null;
const amount = (value: string) => /^\$(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value) ? Number(value.replace(/[$,]/g, "")) : null;

interface Lead { name: string; set: string; number: string; sku: string; url: string; marketUsd: number; changePercent: number }
interface Ask { grade: string; lowestUsd: number; listings: number; medianAskUsd: number | null }
interface Detail {
    observedAt: string; asksAsOf: string | null; soldAsOf: string | null;
    chartChange?: { observations: number; from: string; to: string; deltaUsd: number; percent: number };
    ebayAsks: Ask[]; ebaySales: { grade: string; count: number; medianUsd: number }[];
    tcgplayerNm: { finish: string; marketUsd: number; lowUsd: number | null }[];
}
export interface PokePriceSnapshot {
    source: string; observedAt: string; publishedDay: string; period: string;
    rows: (Lead & { detail: Detail | null })[];
}

export function parsePokePriceMovers(html: string) {
    const doc = parseDocument(html);
    const banner = DomUtils.findOne(el => el.name === "p" && /comparing TCGplayer market prices/i.test(text(el)), doc);
    const period = banner && /price changes (.+?), comparing TCGplayer market prices\. Updated ([A-Z][a-z]+ \d{1,2}, \d{4})\./i.exec(text(banner));
    const date = period ? Date.parse(period[2] + " UTC") : NaN;
    const section = DomUtils.findOne(el => el.name === "section" && !!DomUtils.findOne(child => child.name === "h2" && text(child) === "Biggest Gains", el), doc);
    if (!section || !period || !Number.isFinite(date)) throw new Error("PokéPrice gains or publication date could not be identified.");
    const rows = new Map<string, Lead>();
    for (const row of DomUtils.findAll(el => el.name === "li", section)) {
        const link = DomUtils.findOne(el => el.name === "a", row);
        const path = link?.attribs.href ?? "";
        const id = /^\/cards\/(([a-z0-9.-]+)-([a-z]*\d+[a-z]*))$/i.exec(path);
        const [name, set, price] = DomUtils.findAll(el => el.name === "p", row).map(text);
        const percent = DomUtils.findAll(el => el.name === "span", row).map(text).find(label => /^\+[\d,.]+%$/.test(label));
        const marketUsd = amount(price ?? ""), changePercent = Number(percent?.slice(1, -1).replaceAll(",", ""));
        if (!id || !name || !set || !marketUsd || !Number.isFinite(changePercent) || changePercent <= 0)
            throw new Error("Unrecognized PokéPrice gain row.");
        rows.set(id[1], { sku: id[1], name, set, number: id[3], url: origin + path, marketUsd, changePercent });
    }
    if (!rows.size) throw new Error("PokéPrice returned no gains.");
    return { period: period[1], publishedDay: new Date(date).toISOString().slice(0, 10), rows: [...rows.values()] };
}

export function parsePokePriceDetail(html: string, lead: Pick<Lead, "name" | "set" | "number" | "sku">, now: number): Detail {
    const doc = parseDocument(html);
    const heading = (name: string) => DomUtils.findOne(el => /^h[23]$/.test(el.name) && text(el) === name, doc);
    const products = DomUtils.findAll(el => el.name === "script" && el.attribs.type === "application/ld+json", doc)
        .map(el => JSON.parse(DomUtils.textContent(el))).filter(product => product?.["@type"] === "Product");
    const title = DomUtils.findOne(el => el.name === "h1", doc);
    if (products.length !== 1 || products[0].sku !== lead.sku || !title ||
        text(title) !== lead.name + lead.set + " · #" + lead.number || !heading("Prices & Marketplace"))
        throw new Error("PokéPrice detail does not match this card.");
    const asksHeader = parent(heading("Buy on eBay"));
    const ebayAsks: Ask[] = [];
    for (const link of children(parent(asksHeader)).filter(el => el.name === "a")) {
        const labels = DomUtils.findAll(el => el.name === "span", link).map(text);
        const [market, grade] = labels;
        const lowest = amount((labels.find(s => s.startsWith("Lowest $")) ?? "").slice(7));
        const count = labels.join(" ").match(/\b([\d,]+) active listings?\b/i);
        if (market !== "eBay" || !grade || !lowest || !count) continue;
        ebayAsks.push({ grade, lowestUsd: lowest, listings: Number(count[1].replaceAll(",", "")),
            medianAskUsd: amount((labels.find(s => s.includes("Median $")) ?? "").split("Median ")[1] ?? "") });
    }
    const salesPanel = parent(parent(heading("Recent sales")));
    const ebaySales: Detail["ebaySales"] = [];
    const medianLabels = salesPanel ? DomUtils.findAll(el => el.name === "div" && !children(el).length && text(el) === "median", salesPanel) : [];
    for (const label of medianLabels) {
        const price = children(parent(label))[0], description = children(parent(parent(label)))[0];
        const [grade, stats] = children(description).map(text);
        const count = /^(\d[\d,]*) sold\b/.exec(stats ?? "");
        const medianUsd = price && amount(text(price));
        if (grade && count && medianUsd) ebaySales.push({ grade, count: Number(count[1].replaceAll(",", "")), medianUsd });
    }
    const tcgPanel = parent(parent(heading("TCGPlayer (NM market)")));
    const tcgplayerNm: Detail["tcgplayerNm"] = [];
    for (const row of children(children(tcgPanel)[1])) {
        const [label, prices] = children(row);
        const values = children(prices).map(text);
        const marketUsd = amount(values.at(-1) ?? "");
        if (label && marketUsd) tcgplayerNm.push({ finish: text(label), marketUsd,
            lowUsd: amount((values.find(v => v.startsWith("low $")) ?? "").slice(4)) });
    }
    const chart = children(parent(heading("Price History")))[1], [summary, , dates] = children(chart);
    const [countLabel, changeLabel] = children(summary).map(text);
    const observations = /^(\d+) price points?$/.exec(countLabel ?? "");
    const change = /^([+−-]?[\d.]+)% \(([+−-]?)\$([\d,.]+)\)$/.exec(changeLabel ?? "");
    const [from, , to] = children(dates).map(text);
    const chartChange = observations && change && from && to ? { observations: Number(observations[1]), from, to,
        percent: Number(change[1].replace("−", "-")), deltaUsd: Number(change[3].replaceAll(",", "")) * (["-", "−"].includes(change[2]) ? -1 : 1) } : undefined;
    const updated = salesPanel && DomUtils.findOne(el => el.name === "span" && /^Updated /.test(text(el)), salesPanel);
    return { observedAt: new Date(now).toISOString(), ebayAsks, ebaySales, tcgplayerNm, chartChange,
        asksAsOf: children(asksHeader).map(text).find(s => /active asks/i.test(s)) ?? null,
        soldAsOf: updated ? text(updated) : null };
}

export function importPokePrice({ now = Date.now(), signal, fetchPage = fetch, delayMs = 1000 }: MarketImportOptions & { delayMs?: number } = {}) {
    return importMarketDay<PokePriceSnapshot>(prefix, now, async () => {
        const page = parsePokePriceMovers(await fetchMarketHtml(pokePriceMoversUrl, fetchPage, signal));
        const rows: PokePriceSnapshot["rows"] = [];
        let stopDetails = false;
        for (const lead of page.rows) {
            let detail: Detail | null = null;
            if (!stopDetails) {
                await pause(delayMs, undefined, { signal });
                try { detail = parsePokePriceDetail(await fetchMarketHtml(lead.url, fetchPage, signal), lead, now); }
                catch (error) {
                    signal?.throwIfAborted();
                    const message = error instanceof Error ? error.message : "Read failed";
                    console.warn("PokéPrice detail unavailable", lead.sku, message);
                    stopDetails = /HTTP (?:403|429|5\d\d)\b/.test(message);
                }
            }
            rows.push({ ...lead, detail });
        }
        return { source: pokePriceMoversUrl, observedAt: new Date(now).toISOString(), period: page.period, publishedDay: page.publishedDay, rows };
    });
}

const silphPrefix = "silph:set-movers:v1:";

export async function importDailyDiscovery(options: MarketImportOptions = {}) {
    const now = options.now ?? Date.now();
    const snapshot = await importPokePrice({ ...options, now });
    let silph: TradedCard[] | null = null;
    if (snapshot && process.env.SILPHCO_API_KEY?.trim()) {
        const sets = [...new Map(snapshot.rows.map(r => [r.sku.slice(0, -(r.number.length + 1)), r.set])).entries()]
            .sort(([a], [b]) => a.localeCompare(b));
        const selected = sets[Math.floor(now / 86_400_000) % sets.length];
        if (selected) silph = await importMarketDay(silphPrefix, now, () =>
            silphSetSeeds(selected[0], selected[1], options.signal ?? new AbortController().signal));
    }
    return { snapshot, silph };
}

export async function recentSilphSeeds(now: number) {
    return await recentMarketDay<TradedCard[]>(silphPrefix, now) ?? [];
}

export function startPokePriceSchedule(signal: AbortSignal) {
    scheduleMarketImport(prefix, signal, importDailyDiscovery);
}

export async function recentPokePriceSeeds(now: number, kind: "all" | "raw" | "graded") {
    const snapshot = await recentMarketDay<PokePriceSnapshot>(prefix, now);
    if (!snapshot) return [];
    const age = now - Date.parse(snapshot.publishedDay + "T00:00:00Z");
    if (!Number.isFinite(age) || age < -86_400_000 || age > 8 * 86_400_000) return [];
    // Only compare like grade buckets. The shortlist still needs actual listing photos,
    // shipping, exact completed sales and fees before it can produce a buyer decision.
    const discount = (lead: PokePriceSnapshot["rows"][number]) => {
        let best = 0;
        const bucket = (s: string) => s.toLowerCase().replace(/\s+/g, "") === "raw/ungraded" ? "raw" : s.toLowerCase().replace(/\s+/g, "");
        for (const ask of lead.detail?.ebayAsks ?? []) {
            const grade = bucket(ask.grade);
            if (kind !== "all" && (kind === "raw") !== (grade === "raw")) continue;
            const sales = lead.detail?.ebaySales.find(row => bucket(row.grade) === grade);
            if (sales) best = Math.max(best, 1 - ask.lowestUsd / sales.medianUsd);
        }
        return best;
    };
    return snapshot.rows.map(row => ({ row, discount: discount(row) })).sort((a, b) => b.discount - a.discount)
        .map(({ row }) => ({ name: row.name, set: row.set, number: row.number, mover: "PokéPrice rising card" as const }));
}

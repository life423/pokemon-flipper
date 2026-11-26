import { DomUtils, parseDocument } from "htmlparser2";
import { fetchMarketHtml, importMarketDay, marketImportSchedule, recentMarketDay, scheduleMarketImport, type MarketImportOptions } from "./daily-market-import.ts";

export const moversUrl = "https://www.pricecharting.com/big-movers?category=pokemon-cards";
const keyPrefix = "pricecharting:pokemon-big-movers:v1:";

export const moversSchedule = (now: number) => marketImportSchedule(keyPrefix, now);

interface Mover { id: string; title: string; set: string; url: string; loosePriceUsd: number; changeUsd: number }
export interface MoversSnapshot { source: string; observedAt: string; rows: Mover[] }

export function parseMovers(html: string): Mover[] {
    const doc = parseDocument(html);
    const byId = (id: string) => DomUtils.findOne(el => el.attribs.id === id, doc);
    const table = byId("games_table"), currency = byId("dropdown_selected_currency");
    const category = DomUtils.findOne(el => el.name === "select" && el.attribs.name === "category", doc);
    if (!table || !currency || DomUtils.textContent(currency).trim() !== "USD" ||
        !category || !DomUtils.findOne(el => el.name === "option" && el.attribs.value === "pokemon-cards" && "selected" in el.attribs, category))
        throw new Error("PriceCharting did not return the Pokémon movers table in USD.");
    const headings = DomUtils.findAll(el => el.name === "th", table).map(el => DomUtils.textContent(el).trim().toLowerCase());
    if (headings.slice(0, 4).join("|") !== "title|console|loose price|change") throw new Error("PriceCharting movers columns have changed.");
    const rows = new Map<string, Mover>();
    for (const row of DomUtils.findAll(el => el.name === "tr" && DomUtils.getChildren(el).some(cell => "name" in cell && cell.name === "td"), table)) {
        const cells = DomUtils.findAll(el => el.name === "td" && el.parent === row, row);
        const [name, set, price, change] = cells.map(cell => DomUtils.textContent(cell).trim());
        const id = row.attribs["data-product"], link = cells[0] && DomUtils.findOne(el => el.name === "a", cells[0]);
        const href = link?.attribs.href;
        const money = /^\$(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/;
        if (!/^\d+$/.test(id ?? "") || !name || !set || !href || !/^https:\/\/www\.pricecharting\.com\/game\/pokemon-[^/?#]+\/[^/?#]+$/.test(href) ||
            !money.test(price ?? "") || !/^[+−-]/.test(change ?? "") || !money.test(change.slice(1)))
            throw new Error("PriceCharting movers contains an unrecognized product or price.");
        const amount = (usd: string) => Number(usd.replace(/[$,]/g, ""));
        rows.set(id, { id, title: name, set, url: href, loosePriceUsd: amount(price), changeUsd: amount(change.slice(1)) * (change[0] === "+" ? 1 : -1) });
    }
    if (!rows.size) throw new Error("PriceCharting movers contained no product rows.");
    return [...rows.values()];
}

export function importMovers({ now = Date.now(), signal, fetchPage = fetch }: MarketImportOptions = {}) {
    return importMarketDay(keyPrefix, now, async () => ({
        source: moversUrl, observedAt: new Date(now).toISOString(),
        rows: parseMovers(await fetchMarketHtml(moversUrl, fetchPage, signal)),
    }));
}

export function startMoversSchedule(signal: AbortSignal) {
    scheduleMarketImport(keyPrefix, signal, importMovers);
}

// Keep the full page for research. Only unambiguous, numbered singles can seed
// the English card catalog. Special variants and sealed products stay in the snapshot.
export function moverCardSeeds(snapshot: MoversSnapshot) {
    return snapshot.rows.flatMap(row => {
        const card = /^([^#[\]]+?)\s+#([a-z]*\d+[a-z]*)$/i.exec(row.title);
        if (row.changeUsd <= 0 || !card || !/^Pok[eé]mon\s+/i.test(row.set) ||
            /\b(?:Japanese|Chinese|Korean|German|French|Italian|Portuguese|Spanish|Indonesian|Thai)\b/i.test(row.set)) return [];
        return [{ name: card[1], number: card[2], set: row.set.replace(/^Pok[eé]mon\s+/i, ""), mover: "PriceCharting Big Movers" as const }];
    });
}

export async function recentMoverSeeds(now: number) {
    if (process.env.PRICECHARTING_BUYER_USE_AUTHORIZED !== "true") return [];
    const snapshot = await recentMarketDay<MoversSnapshot>(keyPrefix, now);
    return snapshot ? moverCardSeeds(snapshot) : [];
}

import { readBoundedText } from "../lib/http.ts";
import { readMarketData, saveMarketData } from "./market-cache.ts";
import { createSharedWork } from "../lib/shared-work.ts";

const source = "https://pokeforecast.com/most-traded/";
const key = "pokeforecast:most-traded:v1";
const share = createSharedWork();
export interface TradedCard { name: string; set: string; number: string; mover?: "Silph Co set activity" | "PriceCharting Big Movers" | "PokéPrice rising card" }

export function tradedCardSeeds(html: string): TradedCard[] {
    const cards: TradedCard[] = [];
    for (const match of html.matchAll(/<li class="pfdb-ma-row">([\s\S]*?)<\/li>/g)) {
        const row = match[1];
        const field = (name: string) => row.match(new RegExp('class="pfdb-ma-' + name + '"[^>]*>([^<]+)'))?.[1]?.trim();
        const name = field("name")?.replaceAll("&amp;", "&").replace(/&#0?39;|&#8217;/g, "’");
        const market = field("set")?.match(/^(.+) #([A-Z]*\d+[A-Z]?)$/i);
        const reference = Number(field("price")?.replace(/[$,]/g, ""));
        if (name && market && reference >= 20 && reference <= 500 && Number(field("vol")?.replaceAll(",", "")) >= 7)
            cards.push({ name, set: market[1].replaceAll("&amp;", "&"), number: market[2] });
        if (cards.length === 20) break;
    }
    return cards;
}

export async function tradedCards(signal: AbortSignal, cachedOnly = false): Promise<TradedCard[]> {
    const cached = await readMarketData(key, 24);
    if (Array.isArray(cached)) return cached;
    if (cachedOnly) return [];
    return share(key, async workSignal => {
        const stop = AbortSignal.any([workSignal, AbortSignal.timeout(3500)]);
        let cards: TradedCard[] = [];
        try {
            const response = await fetch(source, { signal: stop });
            if (!response.ok || !response.body) { await response.body?.cancel(); return []; }
            cards = tradedCardSeeds(await readBoundedText(response, 800_000));
        } catch { workSignal.throwIfAborted(); return []; }
        if (cards.length) await saveMarketData(key, cards);
        return cards;
    }, signal);
}

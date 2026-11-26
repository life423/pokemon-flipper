import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";

// Count actual HTTP starts in this pass, including failed attempts. Shared
// fetches belong to the pass that dispatched them. Never record keys or URLs.
const current = new AsyncLocalStorage<Map<string, number>>();
const services: Record<string, string> = {
    "https://api.openai.com": "OpenAI", "https://www.pokemonpricetracker.com": "Pokémon Price Tracker",
    "https://www.pricecharting.com": "PriceCharting", "https://www.pokeprice.gg": "PokéPrice",
    "https://silphcoanalytics.xyz": "Silph Co", "https://pokeforecast.com": "PokeForecast",
    "https://api.tcgdex.net": "TCGdex", "https://assets.tcgdex.net": "TCGdex images",
    "https://assets.pokemon.com": "Pokémon images", "https://i.ebayimg.com": "eBay photos",
    "https://www.ebay.com": "eBay listing pages", "https://www.ecb.europa.eu": "ECB exchange rates",
    "https://www.cgccards.com": "CGC", "https://www.psacard.com": "PSA",
    "https://sales-history.fanaticscollect.com": "Fanatics Collect", "https://www.fanaticscollect.com": "Fanatics Collect",
};
channel("undici:request:create").subscribe(message => {
    const counts = current.getStore();
    if (!counts) return;
    const request = (message as { request?: { origin?: string; path?: string } })?.request;
    if (typeof request?.origin !== "string" || typeof request.path !== "string") return;
    let label = services[request.origin];
    const path = request.path.split("?", 1)[0];
    if (request.origin === "https://api.ebay.com" || request.origin === "https://api.sandbox.ebay.com") {
        label = path.startsWith("/buy/browse/") ? "eBay Browse" : path.startsWith("/identity/") ? "eBay OAuth" : "eBay other";
    } else if (request.origin === "https://www.pokeprice.gg") {
        label = path.startsWith("/api/card-sales/") ? "PokéPrice · sold feed" : path.startsWith("/cards/") ? "PokéPrice · card page" : "PokéPrice · discovery";
    } else if (request.origin === "https://www.pricecharting.com") {
        label = path.startsWith("/game/") ? "PriceCharting · product history" : "PriceCharting · discovery";
    } else if (request.origin === "https://api.pkmnprices.com") {
        const kind = path.includes("/listings/ebay") ? "eBay sales" : path.includes("/listings/tcgplayer") ? "TCGplayer offers" :
            path.includes("/listings/cardmarket") ? "Cardmarket offers" : path.includes("/prices/history") ? "price history" : "catalog and pricing";
        label = "PKMNPrices · " + kind;
    }
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
});

export const countFlipRequests = <T>(run: () => T) => current.run(new Map(), run);
export const flipRequestCounts = () => Object.fromEntries(current.getStore() ?? []);

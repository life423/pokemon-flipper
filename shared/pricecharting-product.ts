import { normalizeCardNumber } from "./card-number.ts";
import type { Identity } from "./types.ts";

export interface PriceChartingProduct { id: string; url: string }
const fields = ["name", "set", "cardNumber", "language", "printing", "finish"] as const;
type Mapping = PriceChartingProduct & Record<typeof fields[number], string>;
const aquapolis: Mapping[] = [
    ["Ampharos", "1/147", "NON_HOLO", "842530", "ampharos-1"],
    ["Ampharos", "1/147", "REVERSE_HOLO", "2293892", "ampharos-reverse-holo-1"],
    ["Ampharos", "H1/H32", "HOLO", "887937", "ampharos-h1"],
    ["Espeon", "11/147", "NON_HOLO", "842540", "espeon-11"],
    ["Espeon", "11/147", "REVERSE_HOLO", "2293902", "espeon-reverse-holo-11"],
    ["Espeon", "H9/H32", "HOLO", "887968", "espeon-h9"],
].map(([name, cardNumber, finish, id, slug]) => ({ name, cardNumber, finish, id, url: "https://www.pricecharting.com/game/pokemon-aquapolis/" + slug,
    set: "Aquapolis", language: "English", printing: "UNLIMITED" }));
const normalize = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";

export function matchedPriceChartingProduct(identity: Identity, additional?: string): PriceChartingProduct | null {
    if (identity.status !== "IDENTIFIED" || identity.notThisCard) return null;
    let products = aquapolis;
    if (additional) {
        try {
            const rows = JSON.parse(additional);
            if (!Array.isArray(rows)) return null;
            products = [...rows, ...products];
        } catch { return null; }
    }
    const matches = products.filter(row => row && fields.every(field => {
        const raw = normalize(identity[field]), mapped = normalize(row[field]);
        if (!raw || raw === "unknown" || !mapped) return false;
        if (raw === mapped) return true;
        if (field !== "cardNumber" || raw.split("/").length > 2 || mapped.split("/").length > 2) return false;
        const a = normalizeCardNumber(raw), b = normalizeCardNumber(mapped);
        return a?.number != null && b?.number === a.number && a.numberPrefix === b.numberPrefix && a.total === b.total && a.totalPrefix === b.totalPrefix;
    }));
    const product = matches[0];
    if (!product || typeof product.id !== "string" || typeof product.url !== "string" ||
        matches.some(other => other.id !== product.id || other.url !== product.url) || !/^\d+$/.test(product.id) ||
        !/^https:\/\/www\.pricecharting\.com\/game\/pokemon-[a-z0-9-]+\/[a-z0-9-]+$/.test(product.url)) return null;
    return { id: product.id, url: product.url };
}

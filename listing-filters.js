// Screens raw eBay search results before anything else runs.
// Each rule returns a plain-language reason, so exclusions can be
// explained and tested.

const LOT = /\b(lots?|bundles?|bulk)\b|\b\d+\s*cards\b/i;
const DIGITAL = /\btcg\s*pocket\b|\b(code cards?|online codes?|digital)\b/i;
const FAKE = /\b(proxy|proxies|custom|replica|fan[\s-]?(made|art)|orica|novelty)\b/i;
const PICK_OR_MYSTERY = /\b(mystery|repack|you pick|pick your|choose your|select your)\b/i;

// Lowercase and strip accents, so "Pokémon" matches "pokemon".
export function normalizeText(text) {
    return String(text ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}

// Words the title must contain. "pokemon" is dropped because
// every search already adds it.
export function searchTerms(search) {
    return normalizeText(search)
        .split(/\s+/)
        .filter((term) => term !== "" && term !== "pokemon");
}

// Returns why a listing should be dropped, or null to keep it.
export function exclusionReason(item, search = "") {
    const title = normalizeText(item.title);

    // Variation listings match on any option's name, and their
    // price belongs to whichever option is priciest. A plain
    // listing's ID ends in |0.
    if (item.itemGroupType || !String(item.itemId).endsWith("|0")) {
        return "Pick-your-card listing with several cards";
    }

    const missing = searchTerms(search).filter((term) => !title.includes(term));

    if (missing.length > 0) {
        return `Title doesn't mention ${missing.join(", ")}`;
    }

    if (LOT.test(title)) return "Lot or bundle";
    if (DIGITAL.test(title)) return "Digital item";
    if (FAKE.test(title)) return "Proxy, custom, or replica";
    if (PICK_OR_MYSTERY.test(title)) return "Mystery or pick-your-card listing";

    return null;
}

// Screens raw eBay search results before anything else runs.
// Each rule returns a plain-language reason, so exclusions can be
// explained and tested.

// "x2" and "3x" are several copies; "Mega Charizard X" and "X 2016" aren't.
const LOT = /\b(lots?|bundles?|bulk)\b|\b\d+\s*cards\b|\b[2-9]\s?x\b|\bx\s?[2-9]\b/i;
const DIGITAL = /\btcg\s*pocket\b|\b(code cards?|online codes?|digital)\b/i;
const FAKE = /\b(proxy|proxies|custom|replica|fan[\s-]?(made|art)|orica|novelty)\b/i;
// "Pokemon (1) Card Guaranteed Vintage": one random card.
const PICK_OR_MYSTERY = /\b(mystery|repack|grab bag|random|surprise|assorted|guaranteed|you pick|pick your|choose your|select your)\b|\(1\) card/i;
const SEALED = /\b(booster (packs?|box(es)?)|elite trainer box(es)?|etb|sealed (packs?|box(es)?|product))\b/i;
// Not "sleeve" or "toploader": real single-card listings ship in them.
const MERCH = /\b(plush(ie)?|stickers?|decals?|figures?|figurines?|funko|keychains?|posters?|art prints?|binders?|playmats?|deck box(es)?|coins?|pins?|burger king|topps)\b/i;
const NOT_A_CARD = /\b(empty (slab|case|box)|(slab|case|label|flip) only|no card)\b/i;

// These phrases describe a seller assurance or an accompanying holder. Remove
// only their ambiguous trigger words; every other junk rule still runs. A
// second "custom" describing the card itself must continue to reject it.
const AUTHENTICITY_ASSURANCE = /\b(?:(?:authenticity|authentic|genuine)[\s-]+guaranteed|guaranteed[\s-]+(?:authentic|genuine))\b/gi;
const GENERIC_SINGLE_CARD = /\(\s*1\s*\)[ -]+(?:pokemon[ -]+)?card\b|\b(?:one|1)[ -]+pokemon[ -]+card\b/i;
const CUSTOM_HOLDER = "custom[ -]+(?:(?:protective|protection|magnetic|acrylic|hard|fitted|display)[ -]+)*(?:card[ -]+)?(?:cases?|holders?|sleeves?|top[ -]?loaders?)";
const ACCOMPANYING_CUSTOM_HOLDER = new RegExp(`\\b(?:with|in|inside|includes?|including)[ -]+(?:(?:a|an|the)[ -]+)?${CUSTOM_HOLDER}\\b`, "gi");
const INCLUDED_CUSTOM_HOLDER = new RegExp(`\\b${CUSTOM_HOLDER}(?=[ -]+included\\b)`, "gi");

function exclusionText(title: string): string {
    const normalized = normalizeText(title).replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ");
    return normalized
        .replace(AUTHENTICITY_ASSURANCE, phrase => GENERIC_SINGLE_CARD.test(normalized) ? phrase : "authentic")
        .replace(ACCOMPANYING_CUSTOM_HOLDER, phrase => phrase.replace(/\bcustom\b/i, ""))
        .replace(INCLUDED_CUSTOM_HOLDER, phrase => phrase.replace(/\bcustom\b/i, ""));
}

// Lowercase and strip accents, so "Pokémon" matches "pokemon".
export function normalizeText(text: unknown): string {
    return String(text ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}

// Returns why a listing should be dropped, or null to keep it.
export function exclusionReason(item: { title: string; itemId: string; itemGroupType?: string }): string | null {
    const title = exclusionText(item.title);

    // Variation listings match on any option's name, and their
    // price belongs to whichever option is priciest. A plain
    // listing's ID ends in |0.
    if (item.itemGroupType || !String(item.itemId).endsWith("|0")) {
        return "Pick-your-card listing with several cards";
    }

    if (LOT.test(title)) return "Lot or bundle";
    if (DIGITAL.test(title)) return "Digital item";
    if (FAKE.test(title)) return "Proxy, custom, or replica";
    if (PICK_OR_MYSTERY.test(title)) return "Mystery or pick-your-card listing";
    // "Champions Path ETB promo" is the single card that came in the box.
    if (SEALED.test(title) && !/\bpromo\b/.test(title)) return "Sealed product";
    if (MERCH.test(title)) return "Merchandise, not a card";
    if (NOT_A_CARD.test(title)) return "Empty slab, case, or label";

    return null;
}

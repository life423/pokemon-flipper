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
const MERCH = /\b(plush(ie)?|stickers?|decals?|figures?|figurines?|funko|keychains?|posters?|art prints?|binders?|playmats?|deck box(es)?|coins?|pins?|burger king|topps|bicycle(?: mini)? playing cards?)\b/i;
const NOT_A_CARD = /\b(empty (slab|case|box)|(slab|case|label|flip) only|no card)\b/i;
const EXTENDED_ART_HOLDER = "extended[ -]+art(?:work)?[ -]+(?:display[ -]+)?(?:cases?|frames?|holders?)";
const HOLDER_PRODUCT = new RegExp(`\\b${EXTENDED_ART_HOLDER}\\b`, "i");
const HOLDER_WITH_CARD = new RegExp(`\\b(?:with|in|includes?|including)[ -]+(?:(?:a|an|the|magnetic|protective|acrylic)[ -]+)*${EXTENDED_ART_HOLDER}\\b|\\b${EXTENDED_ART_HOLDER}[ -]+included\\b`, "gi");

// These phrases describe a seller assurance or an accompanying holder. Remove
// only their ambiguous trigger words; every other junk rule still runs. A
// second "custom" describing the card itself must continue to reject it.
const AUTHENTICITY_ASSURANCE = /\b(?:(?:authenticity|authentic|genuine)[\s-]+guaranteed|guaranteed[\s-]+(?:authentic|genuine))\b/gi;
const GENERIC_SINGLE_CARD = /\(\s*1\s*\)[ -]+(?:pokemon[ -]+)?card\b|\b(?:one|1)[ -]+pokemon[ -]+card\b/i;
const CUSTOM_HOLDER = "custom[ -]+(?:(?:protective|protection|magnetic|acrylic|hard|fitted|display)[ -]+)*(?:card[ -]+)?(?:cases?|holders?|sleeves?|top[ -]?loaders?)";
const ACCOMPANYING_CUSTOM_HOLDER = new RegExp(`\\b(?:with|in|inside|includes?|including)[ -]+(?:(?:a|an|the)[ -]+)?${CUSTOM_HOLDER}\\b`, "gi");
const INCLUDED_CUSTOM_HOLDER = new RegExp(`\\b${CUSTOM_HOLDER}[ -]+included\\b`, "gi");

function replaceCustomHolder(title: string, replace: (phrase: string) => string): string {
    return normalizeText(title).replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ")
        .replace(ACCOMPANYING_CUSTOM_HOLDER, replace)
        .replace(INCLUDED_CUSTOM_HOLDER, replace);
}

export function withoutAccompanyingCustomHolder(title: string): string {
    // A holder-only listing does not describe an accessory to a card.
    return NOT_A_CARD.test(title) ? normalizeText(title) : replaceCustomHolder(title, () => " ");
}

function exclusionText(title: string): string {
    const normalized = replaceCustomHolder(title, phrase => phrase.replace(/\bcustom\b/i, ""));
    return normalized.replace(AUTHENTICITY_ASSURANCE, phrase => GENERIC_SINGLE_CARD.test(normalized) ? phrase : "authentic");
}

// Lowercase and strip accents, so "Pokémon" matches "pokemon".
export function normalizeText(text: unknown): string {
    return String(text ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}

const SPORTS_CARD_SINGLES = "261328";
const SPORTS_LEAGUE = /\b(?:nhl|nfl|nba|wnba|mlb|mls|ufc)\b/;
const UPPER_DECK = /\bupper[ -]+deck\b/;
const SPORTS_CONTEXT = /\b(?:hof|hall of fame|hockey|baseball|basketball|football|golf|soccer|rookie)\b/;
const PANINI = /\bpanini\b/;
const PANINI_SPORTS_RELEASE = /\b(?:donruss|optic|prizm)\b/;

export function isSportsTradingCardListing({ title, categoryId }: { title: string; categoryId?: string }): boolean {
    const text = normalizeText(title);
    // Preserve explicit Pokémon listings even when a seller used the wrong category.
    if (/\bpokemon\b/.test(text)) return false;
    return SPORTS_LEAGUE.test(text) || (categoryId === SPORTS_CARD_SINGLES || UPPER_DECK.test(text)) && SPORTS_CONTEXT.test(text) ||
        PANINI.test(text) && PANINI_SPORTS_RELEASE.test(text);
}

const EXCLUSION_TEXT = {
    VARIATION: "Pick-your-card listing with several cards",
    LOT: "Lot or bundle",
    DIGITAL: "Digital item",
    PROXY_OR_REPLICA: "Proxy, custom, or replica",
    MYSTERY: "Mystery or pick-your-card listing",
    SEALED: "Sealed product",
    MERCHANDISE: "Merchandise, not a card",
    EMPTY_HOLDER: "Empty slab, case, or label",
} as const;

export function listingExclusion(item: { title: string; itemId: string; itemGroupType?: string }): keyof typeof EXCLUSION_TEXT | null {
    const title = exclusionText(item.title);

    // Variation listings match on any option's name, and their
    // price belongs to whichever option is priciest. A plain
    // listing's ID ends in |0.
    if (item.itemGroupType || !String(item.itemId).endsWith("|0")) {
        return "VARIATION";
    }

    if (LOT.test(title)) return "LOT";
    if (DIGITAL.test(title)) return "DIGITAL";
    if (FAKE.test(title)) return "PROXY_OR_REPLICA";
    if (PICK_OR_MYSTERY.test(title)) return "MYSTERY";
    // "Champions Path ETB promo" is the single card that came in the box.
    if (SEALED.test(title) && !/\bpromo\b/.test(title)) return "SEALED";
    if (MERCH.test(title)) return "MERCHANDISE";
    if (NOT_A_CARD.test(title) || HOLDER_PRODUCT.test(title.replace(HOLDER_WITH_CARD, ""))) return "EMPTY_HOLDER";

    return null;
}

export function exclusionReason(item: Parameters<typeof listingExclusion>[0]): string | null {
    const code = listingExclusion(item);
    return code === null ? null : EXCLUSION_TEXT[code];
}

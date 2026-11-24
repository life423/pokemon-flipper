import { normalizeText, withoutAccompanyingCustomHolder } from "../ebay/filters.ts";
import { PRINTINGS, isPrinting, readyForPricing } from "../../shared/identity.ts";
import { finishClaim, type FinishClaim } from "../../shared/finish.ts";
import { compareCardNumbers, normalizeCardNumber, sameCardNumber } from "../../shared/card-number.ts";
import { canonicalCatalogName, sameCatalogName } from "./catalog-name.ts";
import { cardLanguageStatus } from "../../shared/card-language.ts";
import { confirmedPhotoCard, conflictsWithPhotoFinish } from "../../shared/photo-evidence.ts";
import { BASE_SET_2_TITLE, hasBaseSetFourthPrint, PRISMATIC_EVOLUTIONS_TITLE, withoutReprintRelease, XY_EVOLUTIONS_TITLE } from "../../shared/reprint-release.ts";
import { canonicalBaseSet2 } from "../../shared/sets.ts";
import { checkSlab } from "./slab-check.ts";
import type { readTitleByRules } from "../ai/title-reader.ts";

export { PRINTINGS, isPrinting, normalizeCardNumber, readyForPricing, sameCardNumber };
import type { Identity, PhotoCheck, Printing, PrintingMarks } from "../../shared/types.ts";
import type { LookupCards, PricedCard, CardRecord, PrintingOrUnknown } from "../pricing/types.ts";

// A printing claim in seller text or on a label.
export type PrintingClaim = Printing | "NOT_STATED" | "CONFLICTING";

export type { PrintingOrUnknown };

// What identity reads from a listing: its title and item specifics.
export interface IdentityListing {
    title: string;
    aspects?: Record<string, string>;
}

// What identity reads from the photo check.
export type IdentityPhotos = Pick<PhotoCheck, "printedName" | "printedNumber" | "printingMarks" | "cardMatch" | "slab"> &
    Partial<Pick<PhotoCheck, "cardIdentity" | "cardCount" | "images" | "holder" | "problems">>;

export interface PhotoConfirmation {
    name: string;
    set: string;
    cardNumber: string;
    finish?: "HOLO" | "NON_HOLO" | "REVERSE_HOLO";
    printing?: Printing;
}

// The identity as it's built: the public fields plus a few the pricing
// code reads.
export interface IdentityDraft extends Identity {
    listedCardNumber: string | null;
    hasEditions: boolean | null;
    recordId: CardRecord["id"] | null;
}

interface PrintingDecision {
    status: "ACCEPTED" | "NEEDS_REVIEW";
    printing: PrintingOrUnknown;
    reason: string | null;
}


// Identify first, price second. A listing gets its canonical identity
// here, and no price source is allowed to change it.

const PRINTING_NAMES: Record<string, string> = {
    FIRST_EDITION: "1st Edition",
    SHADOWLESS: "Shadowless",
    UNLIMITED: "Unlimited",
};

// WOTC-era sets printed in both 1st Edition and Unlimited. Cards from
// these always need printing evidence, whatever a database says.
const EDITION_SETS = new Set([
    "base set",
    "base set shadowless",
    "jungle",
    "fossil",
    "team rocket",
    "gym heroes",
    "gym challenge",
    "neo genesis",
    "neo discovery",
    "neo revelation",
    "neo destiny",
]);

// Base Set is the only set with a Shadowless printing.
const SHADOWLESS_SETS = new Set(["base set", "base set shadowless"]);

// Sets a price database splits into several records. A "Base Set"
// listing can be any of them; the printing evidence decides which.
const SET_FAMILIES: Record<string, string[]> = {
    "base set": ["base set", "base set shadowless"],
    "base set shadowless": ["base set", "base set shadowless"],
    "crown zenith": ["crown zenith", "crown zenith galarian gallery"],
};

const SET_FAMILY_SEARCH: Record<string, string> = {
    "base set": "Base Set",
    "base set shadowless": "Base Set",
};

// How printings are labeled inside split sets. In "Base Set" an
// unlabeled price is Unlimited. In "Base Set (Shadowless)" the
// printing labeled "Unlimited" is the Shadowless one.
const SET_PRINTING_RULES: Record<string, { unlimited?: Printing; unlabeled?: Printing }> = {
    "base set": { unlabeled: "UNLIMITED" },
    "base set shadowless": { unlimited: "SHADOWLESS", unlabeled: "SHADOWLESS" },
};

export function printingName(printing: string): string {
    return PRINTING_NAMES[printing] ?? "an unknown printing";
}

// Base Set printings, named the way collectors say them.
const BASE_SET_PRINTING_NAMES: Record<string, string> = {
    FIRST_EDITION: "1st Edition Shadowless",
    SHADOWLESS: "Shadowless (no 1st Edition)",
    UNLIMITED: "Unlimited",
};

export function printingLabel(printing: string, setName: unknown): string {
    if (SHADOWLESS_SETS.has(normalizeSetName(setName))) {
        return BASE_SET_PRINTING_NAMES[printing] ?? "an unknown printing";
    }

    return printingName(printing);
}

// In "Base Set (Shadowless)" the sold comps' printing labels are known
// to be wrong (Shadowless sales filed as 1st Edition). There, the sale
// title decides between 1st Edition Shadowless and Shadowless without
// 1st Edition.
const TITLE_DECIDES_SETS = new Set(["base set shadowless"]);

export function titleDecidesPrinting(setName: unknown): boolean {
    return TITLE_DECIDES_SETS.has(normalizeSetName(setName));
}

// Card numbers

// Literal collector-number forms shared by title reading and metadata cleanup.
// Never fill a missing number from the search or infer one from an ordinary year.
export function cardNumberIn(title: string): string | null {
    return title.match(/\b(?:[a-z]{0,5}\d{1,4}[a-z]?)\s*\/\s*(?:[a-z]{0,5}\d{1,4}[a-z]?)\b/i)?.[0].replace(/\s/g, "")
        ?? title.match(/\b(?:swsh|sm|svp|sv|xy|bw|dp|hgss|gg|tg|h)\d{1,4}[a-z]?\b/i)?.[0]
        ?? title.match(/(?:#|\b(?:card\s*(?:no\.?|number)?|no\.))\s*(\d{1,3}[a-z]?)\b/i)?.[1] ?? null;
}

// Set and card names

export function normalizeWords(value: unknown): string {
    return normalizeText(value).replace(/[^a-z0-9]+/g, " ").trim();
}

// Set names from grading labels: PSA calls Base Set "Pokemon Game" and
// Team Rocket "Rocket".
const SET_ALIASES: Record<string, string> = {
    game: "base set",
    "game shadowless": "base set shadowless",
    rocket: "team rocket",
};

// Known releases whose Sword & Shield era may be written out on the label or
// in seller metadata. Keep the standalone base release and promos separate.
export const SWORD_SHIELD_RELEASE_CODES = {
    "evolving skies": "swsh07",
    "fusion strike": "swsh08",
    "brilliant stars": "swsh09",
    "lost origin": "swsh11",
    "crown zenith": "swsh12.5",
    "crown zenith galarian gallery": "swsh12.5",
};

// "SWSH: Crown Zenith", "Crown Zenith", and "2023 Pokemon Crown Zenith"
// are the same set.
export function normalizeSetName(value: unknown): string {
    const words = normalizeWords(normalizeText(value).replace(/^[a-z0-9&]+\s*:\s*/, ""))
        .replace(/^(19|20)\d{2} /, "")
        .replace(/\bpokemon\b/g, " ")
        // Graded listings often put the printing in the set name
        // ("Neo Genesis 1st Edition"). The printing is judged on its own.
        .replace(/\b(1st|first) edition\b/g, " ")
        .replace(/\bunlimited\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const release = words.replace(/^(?:sword (?:and )?shield|swsh) /, "");
    return SET_ALIASES[words] ?? (Object.hasOwn(SWORD_SHIELD_RELEASE_CODES, release) ? release : canonicalBaseSet2(words));
}

// The normalized names of every set a listing's set may be filed under.
export function setFamily(setName: unknown): string[] {
    const key = normalizeSetName(setName);
    return SET_FAMILIES[key] ?? [key];
}

// The text to search a database's sets with: the family's name, or the
// set's most distinctive word.
export function setSearchTerm(setName: unknown): string {
    const key = normalizeSetName(setName);

    if (SET_FAMILY_SEARCH[key]) return SET_FAMILY_SEARCH[key];

    const longest = key.split(" ").reduce((a, b) => (b.length > a.length ? b : a), "");
    return longest.charAt(0).toUpperCase() + longest.slice(1);
}

// Series names a database may put in front of a set ("XY - Evolutions",
// "SV: Scarlet & Violet 151"). Never for Base Set: XY has its own.
const SERIES_PREFIXES = [
    "xy", "sm", "swsh", "sv", "me", "bw", "dp", "hgss",
    "scarlet violet", "scarlet and violet", "sword shield", "sun moon", "black white", "diamond pearl", "mega evolution",
];

export function sameSetFamily(candidateSet: unknown, listedSet: unknown): boolean {
    const candidate = normalizeSetName(candidateSet);
    const listed = normalizeSetName(listedSet);

    if (candidate === "" || listed === "") return false;

    if (setFamily(listedSet).includes(candidate)) return true;

    // Accept known series prefixes on either side. An arbitrary suffix
    // can be a different release (Prismatic Evolutions vs XY Evolutions).
    return (
        !candidate.startsWith("base set") &&
        !listed.startsWith("base set") &&
        SERIES_PREFIXES.some((prefix) => candidate === `${prefix} ${listed}` || listed === `${prefix} ${candidate}`)
    );
}

function sameName(a: unknown, b: unknown): boolean {
    const x = normalizeWords(a);
    const y = normalizeWords(b);
    return x !== "" && y !== "" && (x.includes(y) || y.includes(x));
}

// Printing claims in seller text

const FIRST_EDITION_TEXT = /\b(1st|first)[\s-]*ed(ition|it)?\b/;
const NOT_FIRST_EDITION_TEXT = /\b(non|not|no|without)[\s-]*(1st|first)\b/;
const SHADOWLESS_TEXT = /\bshadowless\b/;
const UNLIMITED_TEXT = /\bunlimited\b/;

// Returns a printing, NOT_STATED, or CONFLICTING.
export function printingClaimFromText(text: unknown): PrintingClaim {
    const value = normalizeText(text);
    const denied = NOT_FIRST_EDITION_TEXT.test(value);
    const firstEdition = !denied && FIRST_EDITION_TEXT.test(value);
    const shadowless = SHADOWLESS_TEXT.test(value);
    const unlimited = denied || UNLIMITED_TEXT.test(value);

    if (firstEdition && unlimited) return "CONFLICTING";
    if (firstEdition) return "FIRST_EDITION";
    // "Unlimited Shadowless" is a common name for the Shadowless printing.
    if (shadowless) return "SHADOWLESS";
    if (unlimited) return "UNLIMITED";

    return "NOT_STATED";
}

export function finishClaimFromText(text: unknown): FinishClaim {
    return finishClaim(text);
}

function resolveFinish(fromItemDetails: FinishClaim, fromTitle: FinishClaim): FinishClaim {
    if (fromItemDetails !== "NOT_STATED" && fromTitle !== "NOT_STATED" && fromItemDetails !== fromTitle) {
        return "CONFLICTING";
    }

    return fromItemDetails !== "NOT_STATED" ? fromItemDetails : fromTitle;
}

// Printing labels in price databases

// Maps a database's printing labels ("1st Edition Holofoil",
// "Unlimited Holofoil", "Holofoil") to our printings, set by set.
// A label without an edition only counts where the set rules, or a
// card printed once, make its meaning certain. Otherwise UNKNOWN.
export function mapVariantPrintings(variantNames: string[], setName: unknown): Record<string, PrintingOrUnknown> {
    const setKey = normalizeSetName(setName);
    const rule = SET_PRINTING_RULES[setKey] ?? {};

    const labeled = variantNames.map((name): [string, Printing | null] => {
        const value = normalizeText(name);

        if (/\b1st edition\b/.test(value)) return [name, "FIRST_EDITION"];
        if (/\bshadowless\b/.test(value)) return [name, "SHADOWLESS"];
        if (/\bunlimited\b/.test(value)) return [name, rule.unlimited ?? "UNLIMITED"];

        return [name, null];
    });

    const cardHasEditions =
        EDITION_SETS.has(setKey) ||
        labeled.some(([, printing]) => printing === "FIRST_EDITION" || printing === "SHADOWLESS");

    return Object.fromEntries(
        labeled.map(([name, printing]) => [
            name,
            printing ?? rule.unlabeled ?? (cardHasEditions ? "UNKNOWN" : "UNLIMITED"),
        ])
    );
}

export function finishOfVariant(name: string): string {
    const claim = finishClaim(name);
    return claim === "NOT_STATED" ? "NON_HOLO" : claim;
}

// Printing evidence in the photos

// Maps what the model saw on the card to a printing. Anything unclear
// stays UNKNOWN; the shadow only matters for Base Set.
export function photoPrinting(
    marks: PrintingMarks | null | undefined,
    { shadowMatters }: { shadowMatters: boolean }
): PrintingOrUnknown {
    if (!marks || marks.conflicts?.includes("firstEditionStamp")) return "UNKNOWN";
    if (marks.firstEditionStamp === "VISIBLE") return "FIRST_EDITION";
    if (marks.firstEditionStamp !== "NOT_PRESENT") return "UNKNOWN";
    if (!shadowMatters) return "UNLIMITED";
    if (marks.conflicts?.includes("artBoxShadow")) return "UNKNOWN";
    if (marks.artBoxShadow === "ABSENT") return "SHADOWLESS";
    if (marks.artBoxShadow === "PRESENT") return "UNLIMITED";

    return "UNKNOWN";
}

function accepted(printing: PrintingOrUnknown): PrintingDecision {
    return { status: "ACCEPTED", printing, reason: null };
}

function review(reason: string): PrintingDecision {
    return { status: "NEEDS_REVIEW", printing: "UNKNOWN", reason };
}

// Cheapest to priciest, for settling a seller's claim against the photos.
const PRINTING_RANK: Record<Printing, number> = { UNLIMITED: 0, SHADOWLESS: 1, FIRST_EDITION: 2 };

export function resolvePrinting(
    {
        title,
        itemSpecifics,
        label = "NOT_STATED",
        photo,
        corroboratedPhoto,
    }: { title: PrintingClaim; itemSpecifics: PrintingClaim; label?: PrintingClaim; photo: PrintingOrUnknown; corroboratedPhoto?: Printing },
    { hasEditions, setName = null }: { hasEditions: boolean | null; setName?: string | null }
): PrintingDecision {
    const printingName = (printing: string) => printingLabel(printing, setName);
    const stated = [title, itemSpecifics, label].filter((claim) => claim !== "NOT_STATED");

    if (stated.includes("CONFLICTING")) {
        return review("The seller's text contradicts itself about the printing.");
    }
    if (new Set(stated).size > 1) {
        // An explicitly named, lower-value printing backed by the photos can
        // correct an overstated seller field. A slab label is separate evidence.
        if (hasEditions && label === "NOT_STATED" && isPrinting(title) && isPrinting(itemSpecifics) &&
            photo === title && PRINTING_RANK[title] < PRINTING_RANK[itemSpecifics]) {
            return {
                status: "ACCEPTED", printing: title,
                reason: `The title and photos show ${printingName(title)}. The conflicting item detail was not used for pricing.`,
            };
        }
        return review("The title, item details, or slab label disagree about the printing.");
    }

    const [claim] = stated;

    if (!hasEditions) {
        // Printed only once, so a 1st Edition or Shadowless claim is wrong.
        const pricier = [claim, photo].find(
            (value) => value === "FIRST_EDITION" || value === "SHADOWLESS"
        );

        if (pricier) {
            return review(`${printingName(pricier)} is claimed, but this card was only printed once.`);
        }

        return accepted("UNLIMITED");
    }

    if (photo === "UNKNOWN") {
        return review("The photos don't clearly show which printing this is.");
    }
    if (corroboratedPhoto === photo && label === "NOT_STATED") {
        return { status: "ACCEPTED", printing: photo, reason: claim !== photo
            ? "Two independent photo readings confirm this printing despite the seller's omitted or incorrect claim."
            : null };
    }
    if (claim && claim !== photo) {
        // A pricier claim the photos clearly don't support: priced as what the
        // photos show. That can only lower the max price. A pricier printing
        // than claimed still needs both the seller and the photos (below).
        if (isPrinting(claim) && PRINTING_RANK[photo] < PRINTING_RANK[claim]) {
            return {
                status: "ACCEPTED",
                printing: photo,
                reason: `The seller says ${printingName(claim)}, but the photos show ${printingName(photo)}, so it's priced as ${printingName(photo)}.`,
            };
        }

        return review(
            `The seller says ${printingName(claim)}, but the photos show ${printingName(photo)}.`
        );
    }
    // The pricier printings need both the seller's word and the photos.
    if (!claim && photo !== "UNLIMITED") {
        return review(
            `The photos suggest ${printingName(photo)}, but the seller doesn't say so. Possible sleeper: check it yourself.`
        );
    }

    return accepted(photo);
}

function aspectText(aspects: Record<string, string>, namePattern: RegExp): string {
    return Object.entries(aspects)
        .filter(([name]) => namePattern.test(name))
        .map(([, value]) => value)
        .join(" ");
}

export function printingClaimFromAspects(aspects: Record<string, string>): PrintingClaim {
    return printingClaimFromText(aspectText(aspects, /edition|feature|print/i));
}

// PSA's readable English 1999 Base Set label names premium printings. A
// complete ordinary label must not be upgraded by an uncertain artwork-shadow
// reading, even when another model repeats the same visual mistake.
export function psaBaseLabelPrinting(slab: PhotoCheck["slab"], card: { name: string | null; set: string | null; cardNumber: string | null }): Printing | null {
    if (!slab?.present || normalizeWords(slab.grader) !== "psa" || !sameSetFamily(card.set, "Base Set") || !slab.labelText || !card.name || !card.cardNumber) return null;
    const label = normalizeWords(slab.labelText);
    const printedNumber = slab.labelText.match(/#\s*([a-z]?\d+[a-z]?)/i)?.[1];
    if (!/1999\s+pokemon\s+game/.test(label) || !label.includes(normalizeWords(card.name)) ||
        !printedNumber || !sameCardNumber(printedNumber, card.cardNumber)) return null;
    const claim = printingClaimFromText(slab.labelText);
    return claim === "NOT_STATED" ? "UNLIMITED" : isPrinting(claim) ? claim : null;
}

// Error and special versions ("Charizard (Black Dot Error)") share a
// number with the regular card, so when both match, a version only
// counts if the listing names it.
function versionTag(name: unknown): string | null {
    const match = String(name ?? "").match(/\(([^)]+)\)/);
    return match ? normalizeWords(match[1]) : null;
}

function pickNamedVersions(cards: CardRecord[], title: string): CardRecord[] {
    if (cards.length <= 1) return cards;

    const text = normalizeWords(title);
    const named = cards.filter((card) => {
        const tag = versionTag(card.name);
        return tag !== null && text.includes(tag);
    });

    if (named.length > 0) return named;

    const plain = cards.filter((card) => !versionTag(card.name));
    return plain.length > 0 ? plain : cards;
}

// One card as it appears across a family of database records, with every
// printing tagged by the record it came from.
function mergeFamily(records: CardRecord[]): PricedCard {
    const [first] = records;

    return {
        source: first.source,
        name: first.name,
        cardNumber: first.cardNumber,
        records: records.map(({ variants, ...record }) => record),
        variants: records.flatMap((record) =>
            record.variants.map((variant) => ({
                ...variant,
                recordId: record.id,
                setName: record.setName,
            }))
        ),
    };
}

// Look-alike reprints. The 2021 Celebrations Classic Collection and the
// 2026 30th Celebration Classic Collection both reprint 1999 Base Set
// cards with the original numbers, and sellers mix up the set names.
// Years and anniversaries in the text tell them apart.
type Product = "ORIGINAL" | "CELEBRATIONS" | "THIRTIETH";

const PRODUCT_NAMES: Record<Product, string> = {
    ORIGINAL: "the 1999 original",
    CELEBRATIONS: "the 2021 Celebrations reprint",
    THIRTIETH: "the 2026 30th Celebration reprint",
};

const PRODUCT_MARKERS: [Product, RegExp][] = [
    ["THIRTIETH", /\b30th\b|\b2026\b/],
    ["CELEBRATIONS", /\b25th\b|\b2021\b/],
    ["ORIGINAL", /\b1999\b|\bpokemon game\b/],
];

function productOfSet(setName: unknown): Product | null {
    const words = normalizeWords(setName);

    if (/\b30th\b/.test(words)) return "THIRTIETH";
    if (/\bcelebrations?\b/.test(words)) return "CELEBRATIONS";

    return null;
}

// Why a text (a listing, or a sale's title) can't be this set's product,
// or null. With requireMarker, a Classic Collection text that names no
// product at all fails too, since either reprint could be meant.
export function lookAlikeProblem(
    text: unknown,
    setName: unknown,
    { requireMarker = false }: { requireMarker?: boolean } = {}
): string | null {
    const product = productOfSet(setName);

    if (!product) return null;

    const value = normalizeText(text);
    const named = PRODUCT_MARKERS.filter(([, pattern]) => pattern.test(value)).map(([found]) => found);
    const other = named.find((found) => found !== product);

    if (other) {
        return `names ${PRODUCT_NAMES[other]}, not ${PRODUCT_NAMES[product]}`;
    }

    const twins = /\bclassic collection\b|\b30th\b/.test(normalizeWords(setName));

    if (requireMarker && twins && !named.includes(product)) {
        return `doesn't say which reprint it is: ${PRODUCT_NAMES.CELEBRATIONS} and ${PRODUCT_NAMES.THIRTIETH} share card numbers`;
    }

    return null;
}

// Marks on the artwork that make a card a reprint or a special printing,
// and the sets they belong to. Anywhere else, the mark means the listing
// isn't the card its title says.
const REPRINT_MARKS = {
    CELEBRATIONS_25TH: { name: "the 2021 Celebrations reprint", sets: ["celebration"] },
    ANNIVERSARY_30TH: { name: "the 2026 30th Celebration reprint", sets: ["30th"] },
    BASE_SET_2: { name: "Base Set 2", sets: ["base set 2"] },
    WORLD_CHAMPIONSHIPS: { name: "a World Championships deck", sets: ["world championship"] },
    OTHER_STAMP: { name: "a stamped special printing", sets: ["promo"] },
};

type ReprintMark = keyof typeof REPRINT_MARKS;
const affirmativeReprintNotes = ([
    ["BASE_SET_2", "base set (?:2|ii) (?:set symbol|symbol|mark|logo|stamp)"],
    ["CELEBRATIONS_25TH", "(?:celebrations (?:pikachu )?|pikachu 25th anniversary |25th anniversary (?:pikachu )?)(?:logo|stamp|mark|symbol|face)"],
    ["ANNIVERSARY_30TH", "(?:pikachu 30th anniversary |30th (?:anniversary|celebration) (?:pikachu )?)(?:logo|stamp|mark|symbol|face)"],
    ["WORLD_CHAMPIONSHIPS", "world championships (?:logo|stamp|mark|symbol)"],
] satisfies [ReprintMark, string][]).map(([code, mark]) => {
    const subject = `(?:(?:a|an|the) )?(?:${mark})`;
    const location = "(?: (?:below|under|beside|above) the artwork(?: frame)?| at the lower right of the artwork| in (?:the front photo|photo \\d+))?";
    return [code, new RegExp(`^(?:${subject} (?:is )?(?:clearly )?(?:visible|present|seen)|(?:the )?(?:card|front photo|photo \\d+) (?:clearly )?shows ${subject})${location}$`)] as const;
});

export function reprintMarkCode(mark: string | null | undefined): ReprintMark | null {
    if (!mark) return null;
    if (Object.hasOwn(REPRINT_MARKS, mark)) return mark as ReprintMark;
    // A complete, affirmative photo observation can survive legacy prose.
    // Keep qualifiers, questions and unrelated claims outside this grammar.
    const note = normalizeText(mark).trim().replace(/\s+/g, " ").replace(/\.$/, "").replace(/lower[-–]right/g, "lower right");
    return affirmativeReprintNotes.find(([, pattern]) => pattern.test(note))?.[0] ?? null;
}

// The reprint a photographed mark shows, or null when there is none or the
// listed set is that reprint.
export function reprintShown(mark: string | null | undefined, setName: unknown): string | null {
    const code = reprintMarkCode(mark);
    if (!code) return null;
    const known = REPRINT_MARKS[code];

    const set = normalizeWords(setName);

    return (code === "BASE_SET_2" ? normalizeSetName(setName) === "base set 2" : known.sets.some((word) => set.includes(word))) ? null : known.name;
}

export function photoReprintIssue(marks: PrintingMarks | undefined, set: string, catalogSet = set): { reason: string; notThisCard?: string } | null {
    if (marks?.conflicts?.includes("reprintMark")) return { reason: "Photo readings disagree about which reprint mark is visible." };
    const reprint = reprintShown(marks?.reprintMark, catalogSet);
    return reprint ? {
        reason: `The photos show a mark from ${reprint}, so this isn't the ${set} card.`,
        notThisCard: `it shows a mark from ${reprint}`,
    } : null;
}

const baseSet2Mark = "base set 2 (?:mark|symbol)";
const anniversaryMark = "(?:pikachu anniversary|anniversary pikachu|anniversary/pikachu reprint|anniversary/reprint) (?:mark|logo|stamp|symbol)";
const reprintMarks = [
    `base set 2(?: (?:mark|symbol))? or (?:visible )?${anniversaryMark}`,
    `${anniversaryMark} or (?:visible )?${baseSet2Mark}`,
    `${baseSet2Mark}, ${anniversaryMark},? or other reprint (?:mark|logo|stamp|symbol)`,
    "(?:anniversary or other )?reprint (?:mark|logo|stamp|symbol)s?",
].join("|");
const noVisibleReprint = new RegExp(
    `^(?:no (?:${reprintMarks}) (?:(?:is |are )?(?:visible|seen|present)|is visibly present)|no visible (?:${reprintMarks}))` +
    "(?: in (?:the )?(?:supplied )?(?:front )?(?:views?|images?|photos?))?$"
);

export function reprintMarksRuledOut(mark: string | undefined, set: string): boolean {
    if (mark === "NONE_SEEN") return true;
    // Bounded assessments also report this field in prose. Accept a complete
    // negative finding, with an optional explicit statement about applicability.
    const [observation, ...qualifiers] = (mark ?? "").toLowerCase().trim().split(";").map(text => text.trim().replace(/\.$/, ""));
    if (!noVisibleReprint.test(observation)) return false;
    if (qualifiers.length === 0) return true;
    return qualifiers.length === 1 && (
        (set === "base set" && /^artwork shadow is visible along the (?:lower\/right|right|lower) artwork frame$/.test(qualifiers[0]!)) ||
        (set === "neo discovery" && qualifiers[0] === "base set 2 mark not applicable/seen") ||
        (set === "team rocket" && qualifiers[0] === "those marks are not applicable evidence for this team rocket card")
    );
}

// Not cards from a set at all: novelty metal cards (the Ultra Premium
// Collection's metal cards, which PSA labels "Ultra-Prem Coll"), Topps
// cards, reprints, and fakes.
const NOVELTY = /\b(reprint|replica|jumbo|oversized?|metal(?!\s+energy\b)|topps|custom|proxy|fan ?made|gold (foil|plated)|upc|ultra[\s-]*prem(ium)?)\b/;

export function noveltyIn(text: unknown): string | null {
    return withoutAccompanyingCustomHolder(String(text ?? "")).match(NOVELTY)?.[0] ?? null;
}

// Reprints of vintage cards (Celebrations, Classic Collection, Base Set
// 2) carry the original's number, and sellers often fill in the
// original's set too. The title gives them away. Each marker is fine
// only when the listed set is one it belongs to; null means never.
const REPRINT_MARKERS: [RegExp, string[] | null][] = [
    [/\bcelebrations?\b/, ["celebration"]],
    [/\bclassic collection\b/, ["classic collection", "celebration"]],
    [/\b\d+(st|nd|rd|th) anniversary\b/, ["celebration", "classic collection", "anniversary"]],
    [BASE_SET_2_TITLE, REPRINT_MARKS.BASE_SET_2.sets],
    [/\blegendary collection\b/, ["legendary collection"]],
    [/\bmcdonald'?s\b/, ["mcdonald"]],
    [NOVELTY, null],
];

// "4/102" style numbers in a title. Over 10 only, so "9/10 condition"
// isn't read as a card number.
const TITLE_NUMBERS = /\b(\d{1,3})\s*\/\s*(\d{1,3})\b/g;

// The title contradicting the item details: a reprint marker for
// another set, or a card number that isn't the listed one.
export function titleContradiction(title: string, setName: string | null, cardNumber: string | null): string | null {
    const text = withoutAccompanyingCustomHolder(title);
    // The whole set name: normalizeSetName drops prefixes like "Celebrations:".
    const setKey = normalizeWords(setName);

    for (const pattern of [PRISMATIC_EVOLUTIONS_TITLE, XY_EVOLUTIONS_TITLE]) {
        const release = text.match(pattern)?.[0];
        if (release && !sameSetFamily(release, setName)) {
            return `The title says "${release}", but the item details say ${setName}.`;
        }
    }

    for (const [pattern, allowedIn] of REPRINT_MARKERS) {
        const match = text.match(pattern);

        if (match && !(pattern === BASE_SET_2_TITLE ? normalizeSetName(setName) === "base set 2" : (allowedIn ?? []).some((word) => setKey.includes(word)))) {
            return `The title says "${match[0]}", but the item details say ${setName}.`;
        }
    }

    const numbers = [...withoutReprintRelease(text).matchAll(TITLE_NUMBERS)]
        .filter((match) => Number(match[2]) > 10)
        .map((match) => `${match[1]}/${match[2]}`);

    if (numbers.length > 0 && !numbers.some((number) => sameCardNumber(number, cardNumber))) {
        return `The title says #${numbers[0]}, but the item details say #${cardNumber}.`;
    }

    return null;
}

const collectorFraction = /^#?[a-z]{0,5}\d{1,4}[a-z]?\s*\/\s*[a-z]{0,5}\d{1,4}[a-z]?$/i;
const fractionsInText = /\b[a-z]{0,5}\d{1,4}[a-z]?\s*\/\s*[a-z]{0,5}\d{1,4}[a-z]?\b/gi;

function literalCollectorNumbers(title: string): string[] {
    return [
        ...[...title.matchAll(fractionsInText)].map(match => match[0]),
        ...[...title.matchAll(/#\s*([a-z]{0,5}\d{1,4}[a-z]?(?:\s*\/\s*[a-z]{0,5}\d{1,4}[a-z]?)?)(?![\w/])/gi)].map(match => match[1]),
    ];
}

// A clear photo can identify a different card even when its condition is obscured.
// Require agreement within both the visual reading and the seller's claims.
export function frontShowsDifferentNumber(listing: IdentityListing, photos: PhotoCheck): boolean {
    const number = listing.aspects?.["Card Number"]?.trim();
    const card = confirmedPhotoCard(photos);
    if (photos.cardMatch?.verdict !== "MISMATCH" || !photos.cardMatch.problems.length ||
        photos.images.length !== 1 || photos.images[0].view !== "FRONT" || photos.slab?.present ||
        !["NONE", "SLEEVE", "TOPLOADER"].includes(photos.holder) || !card?.set || !card.evidence.length ||
        !sameCatalogName(card.name, photos.printedName) || !collectorFraction.test(card.cardNumber?.trim() ?? "") ||
        !collectorFraction.test(photos.printedNumber?.trim() ?? "") || !sameCardNumber(card.cardNumber, photos.printedNumber) ||
        !number || !collectorFraction.test(number) || sameCardNumber(card.cardNumber, number)) return false;
    const claims = literalCollectorNumbers(listing.title);
    return claims.some(claim => collectorFraction.test(claim)) && claims.every(claim => sameCardNumber(claim, number));
}

// Some seller spreadsheets turn a collector fraction into a month/year. Only
// an agreeing explicit title number and a clear photographed fraction can
// correct that local claim; the date-shaped text alone establishes nothing.
function corroboratedDateNumber(listing: IdentityListing, photos: IdentityPhotos): string | null {
    const date = listing.aspects?.["Card Number"]?.match(/^\s*#?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*[-–—]\s*(\d{2,4})\s*$/i);
    const card = photos.cardIdentity;
    const fraction = card?.cardNumber?.match(/^\s*#?(\d{1,3})\s*\/\s*(\d{1,4})\s*$/);
    if (!date || !fraction || card?.confidence !== "HIGH" || !card.evidence.length || photos.cardCount !== "ONE" ||
        photos.cardMatch?.verdict !== "MATCH" || !sameName(card.name, photos.printedName) ||
        !photos.images?.some(photo => photo.view === "FRONT" && photo.usable && !photo.isStockImage) ||
        !/^\s*#?\d{1,3}\s*\/\s*\d{1,4}\s*$/.test(photos.printedNumber ?? "") || !sameCardNumber(photos.printedNumber, card.cardNumber)) return null;
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(date[1].toLowerCase()) + 1;
    if (Number(fraction[1]) !== month || Number(fraction[2]) !== Number(date[2]) || Number(fraction[2]) <= 10) return null;
    const titleNumbers = literalCollectorNumbers(listing.title)
        .filter(number => { const total = normalizeCardNumber(number)?.total; return total == null || total > 10; });
    return titleNumbers.length && titleNumbers.every(number => sameCardNumber(number, card.cardNumber)) ? card.cardNumber! : null;
}

function describesSellerSetConflict(problem: string, observed: string, claimed: string): boolean {
    const text = normalizeWords(problem);
    const visible = text.match(/^(?:the )?(?:visible|photographed) (?:card )?set (?:is|reads) (.+?) not (?:the )?(?:seller(?: s)? (?:item )?(?:aspects|details|specifics|metadata|set)|item (?:details|specifics)) (.+)$/);
    const seller = text.match(/^(?:the )?(?:seller(?: s)? (?:item )?(?:aspects|details|specifics|metadata|set)|item (?:details|specifics)) (?:say|says|list|lists) (.+?) but (?:the )?(?:visible|photographed) (?:card )?set (?:is|reads) (.+)$/);
    return normalizeSetName(visible?.[1] ?? seller?.[2]) === normalizeSetName(observed) &&
        normalizeSetName(visible?.[2] ?? seller?.[1]) === normalizeSetName(claimed);
}

type SellerFieldCorrections = Partial<Record<"Set" | "Card Number" | "Finish", string>>;

function corroboratedSellerClaims(listing: IdentityListing, photos: IdentityPhotos, readTitle?: typeof readTitleByRules): SellerFieldCorrections | null {
    const card = photos.cardIdentity, aspects = listing.aspects ?? {};
    if (!card?.name || !card.set || !aspects.Set || !card.cardNumber || !collectorFraction.test(card.cardNumber.trim()) || card.confidence !== "HIGH" || !card.evidence.length ||
        photos.cardCount !== "ONE" || !["NONE", "SLEEVE", "TOPLOADER"].includes(photos.holder ?? "") || photos.slab?.present ||
        !photos.images?.some(photo => photo.view === "FRONT" && photo.usable && !photo.isStockImage) ||
        !sameCatalogName(card.name, photos.printedName) || !sameCatalogName(card.name, aspects["Card Name"] ?? aspects.Character) ||
        !collectorFraction.test(photos.printedNumber?.trim() ?? "") || !sameCardNumber(card.cardNumber, photos.printedNumber) ||
        cardLanguageStatus("", [card.language]) !== "ENGLISH" || cardLanguageStatus(listing.title, [aspects.Language, card.language]) !== "ENGLISH" ||
        !["HOLO", "NON_HOLO", "REVERSE_HOLO"].includes(card.finish) || finishClaim(listing.title) !== card.finish ||
        titleContradiction(listing.title, card.set, card.cardNumber)) return null;
    const setConflict = !sameSetFamily(card.set, aspects.Set);
    const title = setConflict ? withoutReprintRelease(listing.title) : listing.title;
    const numbers = [...title.matchAll(fractionsInText)].map(match => match[0]);
    if (!numbers.length || numbers.some(number => !sameCardNumber(number, card.cardNumber))) return null;
    const changes: SellerFieldCorrections = {};
    if (setConflict) {
        const literal = readTitle?.(listing.title, [card.set, aspects.Set]);
        const mark = photos.printingMarks?.reprintMark;
        const reprintSettled = reprintMarksRuledOut(mark, normalizeSetName(card.set)) ||
            Boolean(mark && Object.hasOwn(REPRINT_MARKS, mark) && !reprintShown(mark, card.set));
        if (!literal || !sameCatalogName(literal.cardName, card.name) || !sameSetFamily(literal.set, card.set) ||
            !sameCardNumber(literal.cardNumber, card.cardNumber) || !reprintSettled) return null;
        changes.Set = card.set;
    } else {
        let words = ` ${normalizeWords(title.replace(fractionsInText, " "))} `;
        for (const claim of [card.name, card.set]) {
            const explicit = ` ${normalizeWords(claim)} `;
            if (!words.includes(explicit)) return null;
            words = words.replace(explicit, " ");
        }
        words = words.replace(/\bwizards of the coast\b|\bthe pokemon company\b/g, " ")
            .replace(/\b(?:pokemon|tcg|cards?|holo(?:graphic|foil)?|foil|non|reverse|rare|english|eng|en|raw|ungraded|unlimited|wotc|vintage|first|1st|edition|\d+)\b/g, " ").trim();
        if (words) return null;
    }
    if (aspects["Card Number"] && !sameCardNumber(aspects["Card Number"], card.cardNumber)) changes["Card Number"] = card.cardNumber;
    if (aspects.Finish && finishClaim(aspects.Finish) !== card.finish) changes.Finish = card.finish;
    if (!Object.keys(changes).length) return null;
    const risk = /\b(?:authenticity|counterfeit|fake|forged|tamper(?:ed|ing)?|reprint|replica|stock|multiple|slab|holder|case|cert(?:ificate|ification)?|edition|shadowless|stamp)\b|\b(?:different|wrong|another)\s+(?:card(?!\s+number)|set|printing|language)\b/i;
    if ([...(photos.problems ?? []), ...(photos.cardMatch?.problems ?? [])].some(problem => risk.test(problem))) return null;
    if (photos.cardMatch?.verdict === "MISMATCH") {
        if (!photos.cardMatch.problems.length || photos.cardMatch.problems.some(problem => {
            if (changes.Set && describesSellerSetConflict(problem, changes.Set, aspects.Set)) return false;
            if (!/\b(?:seller|aspects?|specifics?|details?|metadata)\b/i.test(problem) || /\b(?:name|set|language|printing|grade|unclear|uncertain|unknown|unreadable|unresolved)\b/i.test(problem)) return true;
            const mentioned = [...problem.matchAll(fractionsInText)].map(match => match[0]);
            const numberIssue = changes["Card Number"] && mentioned.some(number => sameCardNumber(number, card.cardNumber)) &&
                mentioned.some(number => sameCardNumber(number, aspects["Card Number"])) && mentioned.every(number => sameCardNumber(number, card.cardNumber) || sameCardNumber(number, aspects["Card Number"]));
            const finishIssue = changes.Finish && /\bfinish\b/i.test(problem) && normalizeWords(problem).includes(normalizeWords(aspects.Finish)) &&
                /\b(?:holo(?:graphic|foil)?|foil|reverse|non[ -]?holo)\b/i.test(problem);
            return !numberIssue && !finishIssue;
        })) return null;
    } else if (photos.cardMatch?.verdict !== "MATCH") return null;
    return changes;
}

function slabSellerNameConflict(listing: IdentityListing, photos: IdentityPhotos): boolean {
    const listedName = listing.aspects?.["Card Name"];
    const card = photos.cardIdentity;
    return Boolean(listedName && photos.holder === "GRADED_SLAB" && photos.slab?.present &&
        card?.confidence === "HIGH" && card.name && !sameCatalogName(listedName, card.name));
}

export function corroboratedSlabName(listing: IdentityListing, photos: IdentityPhotos, readTitle: typeof readTitleByRules): string | null {
    if (!slabSellerNameConflict(listing, photos)) return null;
    const card = photos.cardIdentity!, aspects = listing.aspects ?? {}, labelText = photos.slab?.labelText;
    if (!card.name || !card.set || !card.cardNumber || !card.evidence.length || !labelText || !photos.images ||
        photos.cardCount !== "ONE" || photos.cardMatch?.verdict !== "MATCH" || photos.cardMatch.problems.length || photos.problems?.length ||
        !sameCatalogName(card.name, photos.printedName) || !sameCardNumber(card.cardNumber, photos.printedNumber) ||
        cardLanguageStatus("", [card.language]) !== "ENGLISH" || cardLanguageStatus(listing.title, [aspects.Language, card.language]) !== "ENGLISH" ||
        card.finish === "UNKNOWN") return null;

    const agreesWithSet = (set: string) => sameSetFamily(set, card.set) || sameSetFamily(card.set, set);
    if (aspects.Set && !agreesWithSet(aspects.Set) || aspects["Card Number"] && !sameCardNumber(aspects["Card Number"], card.cardNumber)) return null;
    const slab = checkSlab({ ...photos, images: photos.images }, aspects);
    const sets = aspects.Set ? [card.set, aspects.Set] : [card.set];
    const title = readTitle(listing.title, sets);
    if (slab.status !== "OK" || !sameCatalogName(title.cardName, card.name) || !sameCardNumber(title.cardNumber, card.cardNumber) ||
        title.grader !== slab.grader || title.grade !== slab.grade || (title.set ? !agreesWithSet(title.set) : !title.cardNumber?.includes("/"))) return null;

    const labelWords = ` ${canonicalCatalogName(labelText)} `;
    const label = readTitle(labelText, sets);
    if (!labelWords.includes(` ${canonicalCatalogName(card.name)} `) || !sameCardNumber(label.cardNumber, card.cardNumber) ||
        label.set && !agreesWithSet(label.set) || label.grader && label.grader !== slab.grader || label.grade && label.grade !== slab.grade) return null;
    return card.name;
}

export function ordinaryBaseSetPokemonNumber(value: string | null | undefined): boolean {
    const collector = Number(value?.match(/^0*([1-9][0-9]?)\s*\/\s*102$/)?.[1]);
    // Base Set Pokémon are numbered 1–69. Machamp's stamped deck copies
    // are an exception to the ordinary artwork-shadow and stamp rules.
    return collector <= 69 && collector !== 8;
}

function shadowConfirmsUnlimited(photos: IdentityPhotos, card: PricedCard): boolean {
    const observed = photos.cardIdentity, marks = photos.printingMarks;
    // A reflection can hide wear while leaving the printed frame readable.
    return Boolean(marks?.artBoxShadow === "PRESENT" && marks.firstEditionStamp === "CANT_TELL" && marks.evidence?.length &&
        reprintMarksRuledOut(marks.reprintMark, "base set") && observed?.confidence === "HIGH" && observed.evidence.length &&
        normalizeSetName(observed.set) === "base set" && cardLanguageStatus("", [observed.language]) === "ENGLISH" &&
        ordinaryBaseSetPokemonNumber(observed.cardNumber) &&
        sameCatalogName(observed.name, photos.printedName) && sameCatalogName(observed.name, card.name) &&
        sameCardNumber(observed.cardNumber, photos.printedNumber) && sameCardNumber(observed.cardNumber, card.cardNumber) &&
        photos.cardCount === "ONE" && ["NONE", "SLEEVE", "TOPLOADER"].includes(photos.holder ?? "") &&
        photos.cardMatch?.verdict === "MATCH" && !photos.cardMatch.problems.length &&
        photos.images?.some(image => image.view === "FRONT" && image.usable && !image.isStockImage) &&
        card.variants.some(variant => variant.printing === "UNLIMITED" && variant.finish === observed.finish));
}

export function structuredPhotoIdentityConflict(photos: IdentityPhotos | null, claims: Partial<Pick<Identity, "name" | "set" | "cardNumber">>): string | null {
    const card = confirmedPhotoCard(photos);
    if (!card?.name || !card.set || !card.cardNumber || !card.evidence?.length) return null;
    const nameDiffers = claims.name && !sameCatalogName(card.name, claims.name);
    const setDiffers = claims.set && !sameSetFamily(card.set, claims.set) && !sameSetFamily(claims.set, card.set);
    const numberDiffers = compareCardNumbers(card.cardNumber, claims.cardNumber) === false;
    return nameDiffers || setDiffers || numberDiffers
        ? `the photos show ${card.name} #${card.cardNumber} from ${card.set}` : null;
}

// Builds the canonical identity for a listing. lookupCards returns
// candidate card records from a price database; it's passed in so tests
// can supply their own.
export async function identifyCard(
    listing: IdentityListing,
    photoCheck: IdentityPhotos,
    { lookupCards, photoIdentity, readTitle }: { lookupCards: LookupCards; photoIdentity?: PhotoConfirmation; readTitle?: typeof readTitleByRules }
): Promise<{ identity: IdentityDraft; card: PricedCard | null; lookupFailed?: boolean; sellerClaimsCorrected?: boolean }> {
    const sellerListing = listing;
    if (photoIdentity) {
        listing = {
            ...listing,
            title: `${photoIdentity.name} ${photoIdentity.set} ${photoIdentity.cardNumber}`,
            aspects: { ...listing.aspects, "Card Name": photoIdentity.name, Set: photoIdentity.set, "Card Number": photoIdentity.cardNumber, Language: "English" },
        };
    }
    const correctedNumber = corroboratedDateNumber(listing, photoCheck);
    const correctedClaims = photoIdentity ? null : corroboratedSellerClaims(listing, photoCheck, readTitle);
    const correctedSlabName = readTitle && !photoIdentity ? corroboratedSlabName(listing, photoCheck, readTitle) : null;
    const aspects = correctedNumber || correctedClaims || correctedSlabName ? { ...listing.aspects,
        ...(correctedNumber ? { "Card Number": correctedNumber } : {}), ...correctedClaims,
        ...(correctedSlabName ? { "Card Name": correctedSlabName } : {}) } : listing.aspects ?? {};
    const listedName = aspects["Card Name"] ?? aspects.Character ?? photoCheck.printedName ?? null;
    const language = aspects.Language ?? (/\b(japanese|jpn|japan)\b/i.test(listing.title) ? "Japanese" : "English");

    const identity: IdentityDraft = {
        status: "NEEDS_REVIEW",
        name: null,
        set: aspects.Set ?? null,
        cardNumber: null,
        listedCardNumber: aspects["Card Number"] ?? photoCheck.printedNumber ?? null,
        language: cardLanguageStatus("", [language]) === "ENGLISH" ? "English" : language,
        printing: "UNKNOWN",
        printingLabel: null,
        finish: "NOT_STATED",
        hasEditions: null,
        recordId: null,
        evidence: null,
        reasons: correctedNumber ? [`The seller-entered card number #${listing.aspects!["Card Number"]} is date-formatted; the title and photographed fraction establish #${correctedNumber}.`] : [],
    };

    const needsReview = (reason: string, card: PricedCard | null = null) => {
        identity.reasons.push(reason);
        return { identity, card };
    };

    if (identity.language !== "English") {
        return needsReview("Only English cards are supported so far.");
    }
    if (readTitle && !photoIdentity && !correctedSlabName && slabSellerNameConflict(listing, photoCheck)) {
        return needsReview("The seller's card name disagrees with the photos, and the label and listing title do not settle the identity.");
    }
    if (!identity.set || !identity.listedCardNumber || !listedName) {
        return needsReview("The listing doesn't give the set, card number, and card name.");
    }
    const photoConflict = photoCheck.cardMatch?.verdict !== "MISMATCH" && structuredPhotoIdentityConflict(photoCheck, {
        name: listedName, set: identity.set, cardNumber: identity.listedCardNumber,
    });
    if (photoConflict) {
        identity.notThisCard = photoConflict;
        return needsReview(`The card doesn't match the listing: ${photoConflict}.`);
    }

    const contradiction = titleContradiction(listing.title, identity.set, identity.listedCardNumber);

    if (contradiction) {
        return needsReview(contradiction);
    }
    if (
        aspects["Card Number"] &&
        photoCheck.printedNumber &&
        !sameCardNumber(aspects["Card Number"], photoCheck.printedNumber)
    ) {
        return needsReview(
            `The item details say #${aspects["Card Number"]}, but the card in the photos reads #${photoCheck.printedNumber}.`
        );
    }

    let candidates: CardRecord[];

    try {
        candidates = await lookupCards({
            set: identity.set,
            name: listedName,
            cardNumber: identity.listedCardNumber,
        });
    } catch (error) {
        return { ...needsReview(`The card lookup failed: ${(error as Error).message}`), lookupFailed: true };
    }

    // The database never decides what the card is: every record has to
    // match the listing's set (or its family), number, and name.
    const matches = pickNamedVersions(
        candidates.filter(
            (card) =>
                sameSetFamily(card.setName, identity.set) &&
                sameCardNumber(card.cardNumber, identity.listedCardNumber) &&
                (!correctedClaims?.Set || normalizeCardNumber(card.cardNumber)?.total != null) &&
                (correctedSlabName ? sameCatalogName(card.name, listedName) : sameName(card.name, listedName)) &&
                (!correctedClaims || sameCatalogName(card.name, photoCheck.cardIdentity?.name))
        ),
        listing.title
    );

    if (matches.length === 0) {
        // Independently corroborated physical identity does not disappear just
        // because a pricing catalog lacks this card. Alternative price sources
        // still have to match that identity; no nearby record is substituted.
        if (photoIdentity?.printing && photoIdentity.finish) {
            identity.status = "IDENTIFIED";
            identity.name = photoIdentity.name;
            identity.set = photoIdentity.set;
            identity.cardNumber = photoIdentity.cardNumber;
            identity.printing = photoIdentity.printing;
            identity.printingLabel = printingLabel(photoIdentity.printing, photoIdentity.set);
            identity.finish = photoIdentity.finish;
            identity.evidence = { title: printingClaimFromText(sellerListing.title), itemSpecifics: "NOT_STATED", photo: photoIdentity.printing,
                photoSource: "Independent agreeing photo readings", photoNotes: photoCheck.printingMarks?.evidence ?? [] };
            identity.reasons.push("Photos establish the identity; this exact card has no matching price-catalog record.");
            return { identity, card: null };
        }
        return needsReview(
            `No card in the price database matches ${identity.set} #${identity.listedCardNumber}.`
        );
    }

    // A family holds at most one record per set. Two in one set is ambiguous.
    const setKeys = matches.map((card) => normalizeSetName(card.setName));

    if (new Set(setKeys).size !== setKeys.length) {
        return needsReview(
            `Several cards in the price database match ${identity.set} #${identity.listedCardNumber}.`
        );
    }

    const card = mergeFamily(matches);

    // The listing has to name the same look-alike reprint as the record:
    // its title, its set, or its year.
    const listingText = [listing.title, aspects.Set, aspects["Year Manufactured"]].filter(Boolean).join(" ");
    const lookAlike = lookAlikeProblem(listingText, card.records[0]?.setName, { requireMarker: true });

    if (lookAlike) {
        return needsReview(`The listing ${lookAlike}.`, card);
    }
    const setKey = normalizeSetName(identity.set);
    const pricier = (v: { printing: PrintingOrUnknown }) => v.printing === "FIRST_EDITION" || v.printing === "SHADOWLESS";

    identity.name = card.name;
    identity.cardNumber = card.cardNumber;
    identity.hasEditions = EDITION_SETS.has(setKey) || card.variants.some(pricier);

    const shadowMatters =
        SHADOWLESS_SETS.has(setKey) || card.variants.some((v) => v.printing === "SHADOWLESS");

    const slab = photoCheck.slab?.present ? photoCheck.slab : null;
    // A complete PSA Base Set label identifies its printing independently of
    // glare or model mistakes about the artwork border.
    const labelNamesNone =
        Boolean(slab?.labelText && printingClaimFromText(slab.labelText) === "NOT_STATED");
    let label: PrintingClaim = slab?.labelText ? printingClaimFromText(slab.labelText) : "NOT_STATED";

    if (labelNamesNone && !shadowMatters) {
        label = "UNLIMITED";
    }

    const titlePrinting = printingClaimFromText(sellerListing.title);
    const itemPrinting = printingClaimFromAspects(aspects);
    let photo: PrintingOrUnknown = photoPrinting(photoCheck.printingMarks, { shadowMatters });
    let photoSource = "photos";
    if (!slab && photo === "UNKNOWN" && setKey === "base set" && !photoCheck.printingMarks?.conflicts?.length &&
        [titlePrinting, itemPrinting].every(claim => claim === "UNLIMITED" || claim === "NOT_STATED") &&
        !hasBaseSetFourthPrint(setKey, sellerListing.title, aspectText(aspects, /edition|feature|print|copyright|year/i),
            ...(photoCheck.printingMarks?.evidence ?? [])) &&
        cardLanguageStatus(sellerListing.title, [aspects.Language, photoCheck.cardIdentity?.language]) === "ENGLISH" &&
        shadowConfirmsUnlimited(photoCheck, card)) {
        photo = "UNLIMITED";
        photoSource = "Artwork frame shadow";
    }
    const psaLabel = psaBaseLabelPrinting(slab ? { ...slab, grader: slab.grader ?? (/\bpsa\b/i.test(sellerListing.title) ? "PSA" : null) } : null,
        { name: card.name, set: identity.set, cardNumber: card.cardNumber });
    if (psaLabel === "UNLIMITED" && photo !== "FIRST_EDITION") {
        label = "UNLIMITED";
        photo = "UNLIMITED";
        photoSource = "PSA slab label";
    }
    if (slab && normalizeWords(slab.grader) === "psa" && shadowMatters && photo === "SHADOWLESS" && label !== "SHADOWLESS") {
        return needsReview("The PSA label does not identify Shadowless. An artwork-shadow guess cannot authorize premium printing prices.", card);
    }

    // Inside a slab the stamp and shadow can be hard to see, but graders
    // print 1st Edition and Shadowless on the label. A legible label that
    // names neither marks the Unlimited printing.
    if (photo === "UNKNOWN" && slab?.labelText && label !== "CONFLICTING") {
        photo = label === "NOT_STATED" ? "UNLIMITED" : label;
        photoSource = "slab label";
    }

    const evidence = {
        title: titlePrinting,
        itemSpecifics: itemPrinting,
        label,
        photo,
        photoSource,
        photoNotes: photoSource === "PSA slab label" ? ["The readable PSA Base Set label names no premium printing. A conflicting artwork-shadow interpretation was not used."] : photoCheck.printingMarks?.evidence ?? [],
    };
    identity.evidence = evidence;

    identity.finish = photoIdentity?.finish ?? resolveFinish(
        finishClaimFromText(aspectText(aspects, /finish|feature/i)),
        finishClaimFromText(listing.title)
    );
    // A legible slab label can supply a finish the seller omitted. Its grade,
    // authenticity and case still pass the independent slab checks below.
    const labelFinish = slab?.labelText ? finishClaim(slab.labelText) : "NOT_STATED";
    if (labelFinish !== "NOT_STATED") identity.finish = resolveFinish(identity.finish as FinishClaim, labelFinish);

    // A reprint's mark on the artwork outranks anything the seller wrote.
    const reprint = photoReprintIssue(photoCheck.printingMarks, identity.set, card.records[0]?.setName ?? identity.set);
    if (reprint) {
        if (reprint.notThisCard) identity.notThisCard = reprint.notThisCard;
        return needsReview(reprint.reason, card);
    }

    // Anything else on the card that shows it isn't what the listing claims.
    if (photoCheck.cardMatch?.verdict === "MISMATCH" && !photoIdentity && !correctedClaims) {
        const problems = photoCheck.cardMatch.problems.join("; ") || "the card differs from the listing";

        identity.notThisCard = problems;
        return needsReview(`The photos don't match the listing: ${problems}.`, card);
    }
    if (conflictsWithPhotoFinish(photoCheck, identity.finish)) {
        identity.finish = "CONFLICTING";
        return needsReview("The photographed finish disagrees with the listing or slab label.", card);
    }
    const marks = photoCheck.printingMarks;
    if (identity.hasEditions && marks?.conflicts?.includes("firstEditionStamp")) {
        return needsReview("Photo readings disagree about whether the First Edition stamp is present.", card);
    }
    if (shadowMatters && !psaLabel && marks?.firstEditionStamp !== "VISIBLE" && marks?.conflicts?.includes("artBoxShadow")) {
        return needsReview("Photo readings disagree about whether the artwork border has a shadow.", card);
    }

    const printing = resolvePrinting({ ...evidence, corroboratedPhoto: photoIdentity?.printing }, {
        hasEditions: identity.hasEditions,
        setName: identity.set,
    });

    if (printing.status !== "ACCEPTED") {
        return needsReview(printing.reason ?? "The printing couldn't be settled.", card);
    }

    // Priced as a cheaper printing than the seller claims: say so.
    if (printing.reason) identity.reasons.push(printing.reason);
    if (photoIdentity && (sellerListing.title !== listing.title)) identity.reasons.push("Card identity is corroborated by independent photo readings; printing follows the label and visible evidence.");

    if (labelNamesNone && printing.printing === "FIRST_EDITION") {
        return needsReview("The listing says 1st Edition, but the slab label doesn't.", card);
    }

    identity.printing = printing.printing;

    // Name the database record that holds this printing, when exactly one does.
    const holders = [
        ...new Set(
            card.variants
                .filter((variant) => variant.printing === identity.printing)
                .map((variant) => variant.recordId)
        ),
    ];

    if (holders.length === 1) {
        const record = card.records.find((r) => r.id === holders[0]);

        if (record) {
            identity.set = record.setName;
            identity.recordId = record.id;
        }
    }

    identity.printingLabel = printingLabel(identity.printing, identity.set);
    if ((correctedClaims || correctedSlabName) && !card.variants.some(variant => variant.printing === identity.printing && variant.finish === photoCheck.cardIdentity?.finish)) {
        return needsReview("The catalog does not corroborate the title and photographed finish for this printing.", card);
    }
    if (correctedSlabName && identity.finish !== photoCheck.cardIdentity?.finish) {
        return needsReview("The listing and photographed finish disagree.", card);
    }
    identity.status = "IDENTIFIED";
    if (correctedClaims) {
        const fields = Object.keys(correctedClaims).map(field => field.toLowerCase()).join(", ");
        identity.reasons.push(`The explicit title, readable photos and exact catalog agree. Pricing uses the corrected ${fields}.`);
    }
    if (correctedSlabName) identity.reasons.push("The title, readable slab label and matching catalog agree on the card name. The seller's card name was corrected for pricing.");
    return { identity, card, ...(correctedClaims ? { sellerClaimsCorrected: true } : {}) };
}

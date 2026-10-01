import { normalizeText } from "../ebay/filters.ts";
import type { Identity, PhotoCheck, Printing } from "../../shared/types.ts";
import type { LookupCards, PricedCard, CardRecord, PrintingOrUnknown } from "../pricing/types.ts";

// A printing claim in seller text or on a label.
export type PrintingClaim = Printing | "NOT_STATED" | "CONFLICTING";
type FinishClaim = "HOLO" | "REVERSE_HOLO" | "NON_HOLO" | "NOT_STATED" | "CONFLICTING";

export type { PrintingOrUnknown };

// What identity reads from a listing: its title and item specifics.
export interface IdentityListing {
    title: string;
    aspects?: Record<string, string>;
}

// What identity reads from the photo check.
export type IdentityPhotos = Pick<PhotoCheck, "printedName" | "printedNumber" | "printingMarks" | "slab">;

// The identity as it's built: the public fields plus a few the pricing
// code reads.
export interface IdentityDraft extends Identity {
    listedCardNumber: string | null;
    hasEditions: boolean | null;
    recordId: CardRecord["id"] | null;
    tcgPlayerId: number | null;
}

interface PrintingDecision {
    status: "ACCEPTED" | "NEEDS_REVIEW";
    printing: PrintingOrUnknown;
    reason: string | null;
}


// Identify first, price second. A listing gets its canonical identity
// here, and no price source is allowed to change it.

export const PRINTINGS: Printing[] = ["FIRST_EDITION", "SHADOWLESS", "UNLIMITED"];

export function isPrinting(value: unknown): value is Printing {
    return PRINTINGS.includes(value as Printing);
}

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

function parseNumberPart(part: string | undefined) {
    if (part === undefined || part === "") return null;

    const match = part.match(/^([A-Z-]*?)0*(\d+)$/);

    return match
        ? { prefix: match[1], value: Number(match[2]) }
        : { prefix: part, value: null };
}

// "009/111" and "9/111" are the same card: compare the numbers, not
// the text. Letters in promo-style numbers (SWSH075, TG01/TG30) stay.
export function normalizeCardNumber(value: unknown) {
    const text = String(value ?? "")
        .toUpperCase()
        .replace(/\s+/g, "")
        .replace(/^#/, "");

    if (text === "") return null;

    const [numberText, totalText] = text.split("/");
    const number = parseNumberPart(numberText);
    const total = parseNumberPart(totalText);

    return {
        number: number?.value ?? null,
        numberPrefix: number?.prefix ?? "",
        total: total?.value ?? null,
        totalPrefix: total?.prefix ?? "",
    };
}

export function sameCardNumber(a: unknown, b: unknown): boolean {
    const x = normalizeCardNumber(a);
    const y = normalizeCardNumber(b);

    if (!x || !y || x.number === null || y.number === null) return false;
    if (x.number !== y.number || x.numberPrefix !== y.numberPrefix) return false;

    // Some listings give only "4" instead of "4/102"; the set still has to match.
    if (x.total !== null && y.total !== null) {
        return x.total === y.total && x.totalPrefix === y.totalPrefix;
    }

    return true;
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

    return SET_ALIASES[words] ?? words;
}

export function sameSet(a: unknown, b: unknown): boolean {
    const x = normalizeSetName(a);
    return x !== "" && x === normalizeSetName(b);
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
    "scarlet violet", "sword shield", "sun moon", "black white", "diamond pearl", "mega evolution",
];

export function sameSetFamily(candidateSet: unknown, listedSet: unknown): boolean {
    const candidate = normalizeSetName(candidateSet);
    const listed = normalizeSetName(listedSet);

    if (candidate === "" || listed === "") return false;

    // A listing may put a series name in front ("Sword & Shield Crown
    // Zenith"), never the other way around.
    if (setFamily(listedSet).includes(candidate) || listed.endsWith(` ${candidate}`)) return true;

    // The database may put a series name in front.
    return (
        !listed.startsWith("base set") &&
        SERIES_PREFIXES.some((prefix) => candidate === `${prefix} ${listed}`)
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
    const value = normalizeText(text);

    if (/\breverse[\s-]*holo/.test(value)) return "REVERSE_HOLO";
    if (/\bnon[\s-]*holo/.test(value)) return "NON_HOLO";
    if (/\bholo/.test(value)) return "HOLO";

    return "NOT_STATED";
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
    const value = normalizeText(name);

    if (/\breverse/.test(value)) return "REVERSE_HOLO";
    if (/\bholo/.test(value)) return "HOLO";

    return "NON_HOLO";
}

// Printing evidence in the photos

// Maps what the model saw on the card to a printing. Anything unclear
// stays UNKNOWN; the shadow only matters for Base Set.
export function photoPrinting(
    marks: { firstEditionStamp: string; artBoxShadow: string } | null | undefined,
    { shadowMatters }: { shadowMatters: boolean }
): PrintingOrUnknown {
    if (!marks) return "UNKNOWN";
    if (marks.firstEditionStamp === "VISIBLE") return "FIRST_EDITION";
    if (marks.firstEditionStamp !== "NOT_PRESENT") return "UNKNOWN";
    if (!shadowMatters) return "UNLIMITED";
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

// The title, the item details, and the photos have to agree. There is
// no majority vote: any disagreement goes to review.
export function resolvePrinting(
    {
        title,
        itemSpecifics,
        label = "NOT_STATED",
        photo,
    }: { title: PrintingClaim; itemSpecifics: PrintingClaim; label?: PrintingClaim; photo: PrintingOrUnknown },
    { hasEditions, setName = null }: { hasEditions: boolean | null; setName?: string | null }
): PrintingDecision {
    const printingName = (printing: string) => printingLabel(printing, setName);
    const stated = [title, itemSpecifics, label].filter((claim) => claim !== "NOT_STATED");

    if (stated.includes("CONFLICTING")) {
        return review("The seller's text contradicts itself about the printing.");
    }
    if (new Set(stated).size > 1) {
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
    if (claim && claim !== photo) {
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

// Pricing never starts on a partly known card.
export function readyForPricing(
    identity: Pick<Identity, "status" | "set" | "cardNumber" | "printing"> | null | undefined
): boolean {
    return (
        identity?.status === "IDENTIFIED" &&
        Boolean(identity.set) &&
        Boolean(identity.cardNumber) &&
        isPrinting(identity.printing)
    );
}

function aspectText(aspects: Record<string, string>, namePattern: RegExp): string {
    return Object.entries(aspects)
        .filter(([name]) => namePattern.test(name))
        .map(([, value]) => value)
        .join(" ");
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

// Reprints of vintage cards (Celebrations, Classic Collection, Base Set
// 2) carry the original's number, and sellers often fill in the
// original's set too. The title gives them away. Each marker is fine
// only when the listed set is one it belongs to; null means never.
const REPRINT_MARKERS: [RegExp, string[] | null][] = [
    [/\bcelebrations?\b/, ["celebration"]],
    [/\bclassic collection\b/, ["classic collection", "celebration"]],
    [/\b\d+(st|nd|rd|th) anniversary\b/, ["celebration", "classic collection", "anniversary"]],
    [/\bevolutions\b/, ["evolutions"]],
    [/\bbase set 2\b/, ["base set 2"]],
    [/\blegendary collection\b/, ["legendary collection"]],
    [/\bmcdonald'?s\b/, ["mcdonald"]],
    // Not cards from a set at all: novelty metal cards, Topps cards.
    [/\b(reprint|replica|jumbo|oversized?|metal|topps|custom|proxy|fan ?made|gold (foil|plated))\b/, null],
];

// "4/102" style numbers in a title. Over 10 only, so "9/10 condition"
// isn't read as a card number.
const TITLE_NUMBERS = /\b(\d{1,3})\s*\/\s*(\d{1,3})\b/g;

// The title contradicting the item details: a reprint marker for
// another set, or a card number that isn't the listed one.
export function titleContradiction(title: string, setName: string | null, cardNumber: string | null): string | null {
    const text = normalizeText(title);
    // The whole set name: normalizeSetName drops prefixes like "Celebrations:".
    const setKey = normalizeWords(setName);

    for (const [pattern, allowedIn] of REPRINT_MARKERS) {
        const match = text.match(pattern);

        if (match && !(allowedIn ?? []).some((word) => setKey.includes(word))) {
            return `The title says "${match[0]}", but the item details say ${setName}.`;
        }
    }

    const numbers = [...text.matchAll(TITLE_NUMBERS)]
        .filter((match) => Number(match[2]) > 10)
        .map((match) => `${match[1]}/${match[2]}`);

    if (numbers.length > 0 && !numbers.some((number) => sameCardNumber(number, cardNumber))) {
        return `The title says #${numbers[0]}, but the item details say #${cardNumber}.`;
    }

    return null;
}

// Builds the canonical identity for a listing. lookupCards returns
// candidate card records from a price database; it's passed in so tests
// can supply their own.
export async function identifyCard(
    listing: IdentityListing,
    photoCheck: IdentityPhotos,
    { lookupCards }: { lookupCards: LookupCards }
): Promise<{ identity: IdentityDraft; card: PricedCard | null }> {
    const aspects = listing.aspects ?? {};
    const listedName = aspects["Card Name"] ?? aspects.Character ?? photoCheck.printedName ?? null;

    const identity: IdentityDraft = {
        status: "NEEDS_REVIEW",
        name: null,
        set: aspects.Set ?? null,
        cardNumber: null,
        listedCardNumber: aspects["Card Number"] ?? photoCheck.printedNumber ?? null,
        language:
            aspects.Language ??
            (/\b(japanese|jpn|japan)\b/i.test(listing.title) ? "Japanese" : "English"),
        printing: "UNKNOWN",
        printingLabel: null,
        finish: "NOT_STATED",
        hasEditions: null,
        recordId: null,
        tcgPlayerId: null,
        evidence: null,
        reasons: [],
    };

    const needsReview = (reason: string, card: PricedCard | null = null) => {
        identity.reasons.push(reason);
        return { identity, card };
    };

    if (identity.language !== "English") {
        return needsReview("Only English cards are supported so far.");
    }
    if (!identity.set || !identity.listedCardNumber || !listedName) {
        return needsReview("The listing doesn't give the set, card number, and card name.");
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
        return needsReview(`The card lookup failed: ${(error as Error).message}`);
    }

    // The database never decides what the card is: every record has to
    // match the listing's set (or its family), number, and name.
    const matches = pickNamedVersions(
        candidates.filter(
            (card) =>
                sameSetFamily(card.setName, identity.set) &&
                sameCardNumber(card.cardNumber, identity.listedCardNumber) &&
                sameName(card.name, listedName)
        ),
        listing.title
    );

    if (matches.length === 0) {
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
    const setKey = normalizeSetName(identity.set);
    const pricier = (v: { printing: PrintingOrUnknown }) => v.printing === "FIRST_EDITION" || v.printing === "SHADOWLESS";

    identity.name = card.name;
    identity.cardNumber = card.cardNumber;
    identity.hasEditions = EDITION_SETS.has(setKey) || card.variants.some(pricier);

    const shadowMatters =
        SHADOWLESS_SETS.has(setKey) || card.variants.some((v) => v.printing === "SHADOWLESS");

    const slab = photoCheck.slab?.present ? photoCheck.slab : null;
    // Graders print 1ST EDITION on 1st Edition cards, so a legible label
    // that names no printing rules 1st Edition out. In a set with no
    // Shadowless printing, that makes the card Unlimited. In Base Set it
    // doesn't settle Unlimited versus Shadowless.
    const labelNamesNone =
        Boolean(slab?.labelText && printingClaimFromText(slab.labelText) === "NOT_STATED");
    let label: PrintingClaim = slab?.labelText ? printingClaimFromText(slab.labelText) : "NOT_STATED";

    if (labelNamesNone && !shadowMatters) {
        label = "UNLIMITED";
    }

    let photo: PrintingOrUnknown = photoPrinting(photoCheck.printingMarks, { shadowMatters });
    let photoSource = "photos";

    // Inside a slab the stamp and shadow can be hard to see, but graders
    // print 1st Edition and Shadowless on the label. A legible label that
    // names neither marks the Unlimited printing.
    if (photo === "UNKNOWN" && slab?.labelText && label !== "CONFLICTING") {
        photo = label === "NOT_STATED" ? "UNLIMITED" : label;
        photoSource = "slab label";
    }

    const evidence = {
        title: printingClaimFromText(listing.title),
        itemSpecifics: printingClaimFromText(aspectText(aspects, /edition|feature|print/i)),
        label,
        photo,
        photoSource,
        photoNotes: photoCheck.printingMarks?.evidence ?? [],
    };
    identity.evidence = evidence;

    identity.finish = resolveFinish(
        finishClaimFromText(aspectText(aspects, /finish|feature/i)),
        finishClaimFromText(listing.title)
    );

    const printing = resolvePrinting(evidence, {
        hasEditions: identity.hasEditions,
        setName: identity.set,
    });

    if (printing.status !== "ACCEPTED") {
        return needsReview(printing.reason ?? "The printing couldn't be settled.", card);
    }

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
            identity.tcgPlayerId = record.tcgPlayerId ?? null;
        }
    }

    identity.printingLabel = printingLabel(identity.printing, identity.set);
    identity.status = "IDENTIFIED";

    return { identity, card };
}

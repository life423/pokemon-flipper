import type { Printing, RawPrice } from "../../shared/types.ts";

export type PrintingOrUnknown = Printing | "UNKNOWN";

// One printing of a card in a price database, with its raw prices.
export interface CardVariant {
    // The database's own label, like "1st Edition Holofoil".
    name: string;
    printing: PrintingOrUnknown;
    finish: string;
    prices: RawPrice[];
}

// A card as one price database files it.
export interface CardRecord {
    source: "pkmnprices" | "pokemonPriceTracker";
    id: number | string;
    name: string;
    setName: string | null;
    cardNumber: string;
    tcgPlayerId: number | null;
    variants: CardVariant[];
}

// A card merged across the records of its set family (Base Set and
// Base Set Shadowless), each printing tagged with the record it's from.
export interface PricedCard {
    source: CardRecord["source"];
    name: string;
    cardNumber: string;
    records: Omit<CardRecord, "variants">[];
    variants: (CardVariant & { recordId: CardRecord["id"]; setName: string | null })[];
}

export type PricedVariant = PricedCard["variants"][number];

// One eBay sale, as pkmnprices returns it.
export interface Comp {
    id?: string | number;
    price: number;
    sold_at: string;
    variant: string | null;
    title: string;
    grader: string;
    grade: string;
    grade_qualifier: string | null;
    attribution: "exact" | "shared" | "unknown";
    listing_url: string | null;
}

export type LookupCards = (query: { set: string; name: string; cardNumber: string }) => Promise<CardRecord[]>;

export type FetchComps = (
    recordId: CardRecord["id"],
    options: { grader: string; grade: number | string; variant?: string }
) => Promise<Comp[]>;

// The card a set of comps is priced for, as the comp checker reads it.
export interface CompTarget {
    cardName: string;
    setName: string;
    cardNumber: string;
    printingLabel: string;
    grader: string;
    grade: string;
}

export const COMP_DROP_REASONS = [
    "ANOTHER_CARD",
    "ANOTHER_PRINTING",
    "ANOTHER_GRADE",
    "QUALIFIED_OR_SPECIAL",
    "NOT_ONE_CARD",
    "SIGNED_OR_ALTERED",
    "ERROR_OR_VARIANT",
    "OTHER",
] as const;

export type CompDropReason = (typeof COMP_DROP_REASONS)[number];

export interface CompVerdict {
    keep: boolean;
    reason: CompDropReason | null;
    note: string;
}

// A second look at sales that passed the rules: keep or drop each, with a
// reason. Sales without a verdict stay on the rules' word.
export type CheckComps = (comps: Comp[], target: CompTarget) => Promise<Map<Comp, CompVerdict>>;

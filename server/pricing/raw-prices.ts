import { normalizeText } from "../ebay/filters.ts";
import { CONDITION_NAMES, RAW_CONDITIONS, type RawCondition } from "../../shared/conditions.ts";
import type { Identity, RawPricing } from "../../shared/types.ts";
import type { PricedCard, PricedVariant } from "./types.ts";
import { isPrinting, printingLabel, readyForPricing } from "../identity/card-identity.ts";

// What each price source can actually tell apart. A source is only
// asked questions it can answer.
type Capability = "cardIdentity" | "printing" | "condition" | "grade";

export const SOURCE_CAPABILITIES: Record<string, Record<Capability, boolean>> = {
    // TCGplayer prices by printing and condition.
    pkmnpricesRaw: { cardIdentity: true, printing: true, condition: true, grade: false },
    // Individual eBay sales labeled by printing. Each one is also
    // checked against its own title before it counts.
    pkmnpricesComps: { cardIdentity: true, printing: true, condition: false, grade: true },
    // TCGplayer prices by printing; one condition per printing.
    pokemonPriceTrackerRaw: { cardIdentity: true, printing: true, condition: true, grade: false },
    // eBay graded sales per card only: 1st Edition and Unlimited mixed.
    pokemonPriceTrackerGraded: { cardIdentity: true, printing: false, condition: false, grade: true },
};

export function canPrice(source: string, needs: Capability[]): boolean {
    const capabilities = SOURCE_CAPABILITIES[source];
    return Boolean(capabilities) && needs.every((need) => capabilities[need] === true);
}


const FINISHES = ["HOLO", "REVERSE_HOLO", "NON_HOLO"];

// A price source's condition label ("Near Mint", "Lightly Played Holofoil") as a condition.
export function conditionOf(label: unknown): RawCondition | "UNKNOWN" {
    const value = normalizeText(label);
    const found = RAW_CONDITIONS.find((condition) => value.startsWith(CONDITION_NAMES[condition].toLowerCase()));
    return found ?? "UNKNOWN";
}

function unavailable(reason: string): RawPricing {
    return { status: "PRICE_UNAVAILABLE", reason };
}

// The one database printing that matches the identity, or a reason
// there isn't exactly one. Never a nearby printing.
export function variantFor(
    card: PricedCard | null,
    identity: Identity
): { variant: PricedVariant; reason?: undefined } | { variant?: undefined; reason: string } {
    const name = printingLabel(identity.printing, identity.set);
    let matches = (card?.variants ?? []).filter((variant) => variant.printing === identity.printing);

    if (FINISHES.includes(identity.finish)) {
        matches = matches.filter((variant) => variant.finish === identity.finish);
    }

    if (matches.length === 0) {
        return { reason: `There's no price record for the ${name} printing.` };
    }
    if (matches.length > 1) {
        return { reason: "More than one finish matches this printing, so the price would be a guess." };
    }

    const [variant] = matches;

    // The invariant: the printing is known on both sides, and the same.
    if (!isPrinting(variant.printing) || variant.printing !== identity.printing) {
        return { reason: "The price source can't prove it's the same printing." };
    }

    return { variant };
}

// Raw prices for exactly this card's printing, by condition.
export function rawPricesFor(card: PricedCard | null, identity: Identity): RawPricing {
    if (!readyForPricing(identity)) {
        return unavailable("The card isn't fully identified, so it can't be priced.");
    }
    if (!canPrice(`${card?.source}Raw`, ["cardIdentity", "printing", "condition"])) {
        return unavailable("This price source can't tell printings and conditions apart.");
    }

    const { variant, reason } = variantFor(card, identity);

    if (!variant || !card) return unavailable(reason ?? "There is no card to price.");

    const label = printingLabel(variant.printing, identity.set);
    const prices = variant.prices.filter((entry) => typeof entry.price === "number");

    if (prices.length === 0) {
        return unavailable(`The ${label} printing has no current raw prices.`);
    }

    return {
        status: "PRICED",
        source: card.source,
        printing: variant.printing,
        printingLabel: label,
        finish: variant.finish,
        variant: variant.name,
        prices,
    };
}

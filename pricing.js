import { normalizeText } from "./listing-filters.js";
import { PRINTINGS, printingLabel, readyForPricing } from "./card-identity.js";

// What each price source can actually tell apart. A source is only
// asked questions it can answer.
export const SOURCE_CAPABILITIES = {
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

export function canPrice(source, needs) {
    const capabilities = SOURCE_CAPABILITIES[source];
    return Boolean(capabilities) && needs.every((need) => capabilities[need] === true);
}

const CONDITIONS = [
    ["near mint", "NEAR_MINT"],
    ["lightly played", "LIGHTLY_PLAYED"],
    ["moderately played", "MODERATELY_PLAYED"],
    ["heavily played", "HEAVILY_PLAYED"],
    ["damaged", "DAMAGED"],
];

const FINISHES = ["HOLO", "REVERSE_HOLO", "NON_HOLO"];

export function conditionOf(label) {
    const value = normalizeText(label);
    const found = CONDITIONS.find(([text]) => value.startsWith(text));
    return found ? found[1] : "UNKNOWN";
}

function unavailable(reason) {
    return { status: "PRICE_UNAVAILABLE", reason };
}

// The one database printing that matches the identity, or a reason
// there isn't exactly one. Never a nearby printing.
export function variantFor(card, identity) {
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
    if (!PRINTINGS.includes(variant.printing) || variant.printing !== identity.printing) {
        return { reason: "The price source can't prove it's the same printing." };
    }

    return { variant };
}

// Raw prices for exactly this card's printing, by condition.
export function rawPricesFor(card, identity) {
    if (!readyForPricing(identity)) {
        return unavailable("The card isn't fully identified, so it can't be priced.");
    }
    if (!canPrice(`${card?.source}Raw`, ["cardIdentity", "printing", "condition"])) {
        return unavailable("This price source can't tell printings and conditions apart.");
    }

    const { variant, reason } = variantFor(card, identity);

    if (!variant) return unavailable(reason);

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

import type { Identity } from "../../shared/types.ts";
import type { PricedCard, PricedVariant } from "./types.ts";
import { isPrinting, printingLabel } from "../identity/card-identity.ts";

const FINISHES = ["HOLO", "REVERSE_HOLO", "NON_HOLO"];

// The one database printing that matches the identity, or a reason
// there isn't exactly one. Never a nearby printing.
export function variantFor(
    card: PricedCard | null,
    identity: Identity
): { variant: PricedVariant; reason?: undefined } | { variant?: undefined; reason: string } {
    if (identity.finish === "CONFLICTING") return { reason: "The finish evidence conflicts; it cannot safely select a price variant." };
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

import { finishOfVariant, mapVariantPrintings } from "../identity/card-identity.ts";
import type { RawPrice } from "../../shared/types.ts";
import type { CardVariant } from "./types.ts";

// A card's printings from a price database's labels: each label mapped
// to a printing and a finish, with that label's raw prices. Both price
// sources build their cards this way.
export function cardVariants(
    labels: string[],
    setName: string | null | undefined,
    pricesFor: (label: string) => RawPrice[]
): CardVariant[] {
    const printings = mapVariantPrintings(labels, setName);

    return labels.map((label) => ({
        name: label,
        printing: printings[label],
        finish: finishOfVariant(label),
        prices: pricesFor(label),
    }));
}

// "4/102" from a database's number and set total, or just the number.
export function cardNumberOf(item: { number: string; total_set_number?: string | null }): string {
    return item.total_set_number ? `${item.number}/${item.total_set_number}` : item.number;
}

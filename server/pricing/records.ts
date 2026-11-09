import { finishOfVariant, mapVariantPrintings } from "../identity/card-identity.ts";
import type { CardVariant } from "./types.ts";

// Map each catalog label to the printing and finish used for sold research.
export function cardVariants(
    labels: string[],
    setName: string | null | undefined
): CardVariant[] {
    const printings = mapVariantPrintings(labels, setName);

    return labels.map((label) => ({
        name: label,
        printing: printings[label],
        finish: finishOfVariant(label),
    }));
}

// "4/102" from a database's number and set total, or just the number.
export function cardNumberOf(item: { number: string; total_set_number?: string | null }): string {
    return item.total_set_number ? `${item.number}/${item.total_set_number}` : item.number;
}

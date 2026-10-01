import type { Identity, Printing } from "./types.ts";

export const PRINTINGS: Printing[] = ["FIRST_EDITION", "SHADOWLESS", "UNLIMITED"];

export function isPrinting(value: unknown): value is Printing {
    return PRINTINGS.includes(value as Printing);
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

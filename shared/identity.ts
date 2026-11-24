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

const PRINTING_NAMES: Record<string, string> = {
    FIRST_EDITION: "1st Edition",
    SHADOWLESS: "Shadowless",
    UNLIMITED: "Unlimited",
};

export function printingName(printing: string): string {
    return PRINTING_NAMES[printing] ?? "an unknown printing";
}

export type PrintingClaim = Printing | "NOT_STATED" | "CONFLICTING";

const FIRST_EDITION_TEXT = /\b(1st|first)[\s-]*ed(ition|it)?\b/;
const NOT_FIRST_EDITION_TEXT = /\b(non|not|no|without)[\s-]*(1st|first)\b/;
const SHADOWLESS_TEXT = /\bshadowless\b/;
const UNLIMITED_TEXT = /\bunlimited\b/;

// Returns a printing, NOT_STATED, or CONFLICTING.
export function printingClaimFromText(text: unknown): PrintingClaim {
    const value = String(text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
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

export function printingClaimFromAspects(aspects: Record<string, string>): PrintingClaim {
    const values = Object.entries(aspects).filter(([key]) => /edition|feature|print/i.test(key)).map(([, value]) => value);
    return printingClaimFromText(values.join(" "));
}

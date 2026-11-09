import { setKey } from "./sets.ts";
import type { PhotoCheck } from "./types.ts";

export interface JungleVariantContext {
    listing?: { title?: string };
    identity?: { set: string | null } | null;
    slab?: { labelText?: string | null } | null;
    photoCheck?: Pick<PhotoCheck, "cardIdentity" | "slab" | "printingMarks"> | null;
}

function noSymbol(value: string | null | undefined): boolean {
    const text = value?.normalize("NFKC").replace(/\p{Dash_Punctuation}/gu, "-") ?? "";
    for (const match of text.matchAll(/\bno[\s-]*symbol\b/gi)) {
        const before = text.slice(Math.max(0, match.index - 24), match.index), after = text.slice(match.index + match[0].length);
        if (/\b(?:not|without|isn't)\s+(?:a\s+)?$/i.test(before) || /^\s*(?:(?:variant|printing|error)\s+)?(?:is\s+)?(?:absent|not present|not seen)\b/i.test(after)) continue;
        return true;
    }
    return false;
}

// No Symbol is a separate Jungle market that the current printing/price
// contract cannot represent. An explicit claim or accepted observation is a
// price-scope gap, not proof of fraud or an invitation to price ordinary Jungle.
// Missing edition stamps and Base Set's normal lack of a set symbol do not
// establish this variant. Keep the original label and photo evidence intact.
export function jungleNoSymbolReason(input: JungleVariantContext): string | null {
    const labels = [input.slab?.labelText, input.photoCheck?.slab?.labelText];
    const set = input.identity?.set ?? input.photoCheck?.cardIdentity?.set;
    if (set ? setKey(set) !== "jungle" : !/\bjungle\b/i.test(`${input.listing?.title ?? ""} ${labels.join(" ")}`)) return null;
    const marks = input.photoCheck?.printingMarks;
    if (![input.listing?.title, ...labels, marks?.reprintMark, ...(marks?.evidence ?? [])].some(noSymbol)) return null;
    return "Jungle No Symbol is a separate market variant. Matching No Symbol prices are not supported yet; ordinary Jungle sold prices are not used.";
}

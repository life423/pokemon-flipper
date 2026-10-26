import type { Evaluation, ListingSummary, SellerMistake } from "./types.ts";

// A quick photo lead must not keep boosting a card after full analysis
// contradicts it. Unknown full evidence remains explicitly provisional.
export function currentSellerMistakes(listing: ListingSummary, evaluation?: Evaluation | null): SellerMistake[] {
    const identity = evaluation?.identity;
    const photo = identity?.evidence?.photo;
    const finish = identity?.finish;
    return (listing.mistakes ?? []).filter((mistake) => {
        if (mistake.kind === "FIRST_EDITION") return !photo || photo === "UNKNOWN" || photo === "FIRST_EDITION";
        if (mistake.kind === "SHADOWLESS") return !photo || photo === "UNKNOWN" || photo === "SHADOWLESS";
        if (mistake.kind === "HOLO") return !finish || finish === "NOT_STATED" || finish === "CONFLICTING" || finish === "HOLO";
        if (mistake.kind === "SET" && evaluation?.photoCheck?.cardMatch?.verdict === "MATCH") return false;
        return true;
    }).map((mistake) => {
        if (identity?.status !== "IDENTIFIED") return mistake;
        if (mistake.kind === "FIRST_EDITION" && identity.printing === "FIRST_EDITION") return { ...mistake, detail: "Full photo analysis confirms a 1st Edition stamp omitted or misidentified by the seller." };
        if (mistake.kind === "SHADOWLESS" && identity.printing === "SHADOWLESS") return { ...mistake, detail: "Full photo analysis confirms Shadowless Base Set despite the seller's wording." };
        return mistake;
    });
}

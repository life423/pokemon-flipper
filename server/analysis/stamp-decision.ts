import { cardLanguageStatus } from "../../shared/card-language.ts";
import { withTargets } from "../../shared/money/targets.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import type { Evaluation, Identity, PhotoCheck, Printing, Targets, Underwriting } from "../../shared/types.ts";
import { normalizeSetName, readyForPricing, sameCardNumber, sameSetFamily, type identifyCard } from "../identity/card-identity.ts";
import { sameCatalogName } from "../identity/catalog-name.ts";
import type { PricedCard } from "../pricing/types.ts";

export const STAMP_TERMS_MAX_AGE_MS = 2 * 60_000;
const validAmount = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0;

export function hasFreshStampTerms(listing: Evaluation["listing"], now: number): boolean {
    const age = now - Date.parse(listing.termsCheckedAt ?? "");
    return listing.availability === "ACTIVE" && listing.buyingOption === "FIXED_PRICE" &&
        age >= 0 && age < STAMP_TERMS_MAX_AGE_MS && (!listing.endTime || Date.parse(listing.endTime) > now) &&
        validAmount(listing.price) && validAmount(listing.shipping);
}

type ScenarioPrices = Pick<Evaluation, "rawPricing" | "gradedPricing">;
export interface StampScenario extends ScenarioPrices {
    check: PhotoCheck;
    identity: Identity;
    underwriting: Underwriting;
}

interface DecisionOptions {
    targets: Targets;
    now: number;
    identify: (check: PhotoCheck) => ReturnType<typeof identifyCard>;
    price: (identity: Identity, card: PricedCard) => Promise<ScenarioPrices>;
    signal: AbortSignal;
}

function hasScopedPrices(prices: ScenarioPrices, identity: Identity): boolean {
    const raw = prices.rawPricing;
    if (raw?.status === "PRICED" && (raw.printing !== identity.printing || raw.finish !== identity.finish || raw.conditionEvidence !== "AI_PHOTOS")) return false;
    return Object.values(prices.gradedPricing ?? {}).every(graded => graded.status !== "PRICED" || graded.printing === identity.printing);
}

const baseSet2Mark = "base set 2 (?:mark|symbol)";
const anniversaryMark = "(?:pikachu anniversary|anniversary pikachu|anniversary/pikachu reprint) (?:mark|logo|stamp|symbol)";
const reprintMarks = [
    `${baseSet2Mark} or (?:visible )?${anniversaryMark}`,
    `${anniversaryMark} or (?:visible )?${baseSet2Mark}`,
    "(?:anniversary or other )?reprint (?:mark|logo|stamp|symbol)s?",
].join("|");
const noVisibleReprint = new RegExp(
    `^(?:no (?:${reprintMarks}) (?:is |are )?(?:visible|seen|present)|no visible (?:${reprintMarks}))` +
    "(?: in (?:the )?(?:supplied )?(?:front )?(?:views?|images?|photos?))?$"
);

function reprintMarksRuledOut(mark: string | undefined, set: string): boolean {
    if (mark === "NONE_SEEN") return true;
    // Bounded assessments also report this field in prose. Accept a complete
    // negative finding, with an optional explicit statement about applicability.
    const [observation, ...qualifiers] = (mark ?? "").toLowerCase().trim().split(";").map(text => text.trim().replace(/\.$/, ""));
    if (!noVisibleReprint.test(observation)) return false;
    if (qualifiers.length === 0) return true;
    return qualifiers.length === 1 && (
        (set === "neo discovery" && qualifiers[0] === "base set 2 mark not applicable/seen") ||
        (set === "team rocket" && qualifiers[0] === "those marks are not applicable evidence for this team rocket card")
    );
}

export function stampCandidate(evaluation: Evaluation) {
    const { photoCheck, identity, condition } = evaluation;
    const card = photoCheck?.cardIdentity;
    const marks = photoCheck?.printingMarks;
    const set = normalizeSetName(card?.set);
    const number = card?.cardNumber?.match(/^0*([1-9][0-9]?)\s*\/\s*(102|82|75)$/);
    const collector = Number(number?.[1]);
    // Base Set Pokémon are numbers 1–69. Machamp's starter-deck printings
    // need separate rules. The other sets are limited to their ordinary
    // Pokémon holos, which share the same artwork/stamp layout.
    const base = (set === "base set" || set === "base set shadowless") && number?.[2] === "102" &&
        collector <= 69 && collector !== 8 && marks?.artBoxShadow === "ABSENT";
    const rocket = set === "team rocket" && number?.[2] === "82" && collector <= 14 && card?.finish === "HOLO";
    const neo = set === "neo discovery" && number?.[2] === "75" && collector <= 17 && card?.finish === "HOLO";
    if ((!base && !rocket && !neo) || !photoCheck || photoCheck.cardCount !== "ONE" ||
        !["NONE", "SLEEVE", "TOPLOADER"].includes(photoCheck.holder) || photoCheck.slab?.present || evaluation.slab ||
        photoCheck.cardMatch?.verdict === "MISMATCH" || marks?.firstEditionStamp !== "CANT_TELL" ||
        !reprintMarksRuledOut(marks.reprintMark, set) || card?.confidence !== "HIGH" || !card.name || !card.evidence.length ||
        cardLanguageStatus("", [card.language]) !== "ENGLISH" || !["HOLO", "NON_HOLO"].includes(card.finish)) return null;

    if (!identity || identity.status !== "NEEDS_REVIEW" || identity.notThisCard || identity.evidence?.photo !== "UNKNOWN" ||
        !sameCatalogName(identity.name, card.name) || !sameSetFamily(identity.set, card.set) ||
        !sameCardNumber(identity.cardNumber, card.cardNumber) || identity.finish !== card.finish ||
        !condition || condition.authenticity.concern !== "NONE_SEEN" || condition.creases === "SUSPECTED" ||
        condition.rawCondition === "UNKNOWN" && !condition.gradeRange || evaluation.pricingDeferred) return null;

    const absentPrinting: Printing = base ? "SHADOWLESS" : "UNLIMITED";
    return { photoCheck, marks, card, absentPrinting };
}

// Price both readings before spending on the crop. These are private
// counterfactuals and only the observed stamp result can select one.
export async function findStampDecision(evaluation: Evaluation, { targets, now, identify, price, signal }: DecisionOptions):
    Promise<Record<"VISIBLE" | "NOT_PRESENT", StampScenario> | null> {
    signal.throwIfAborted();
    const candidate = stampCandidate(evaluation);
    if (!candidate || !hasFreshStampTerms(evaluation.listing, now)) return null;
    const { photoCheck, marks, card, absentPrinting } = candidate;
    const config = withTargets(targets);
    const scenario = async (stamp: "VISIBLE" | "NOT_PRESENT", expected: Printing): Promise<StampScenario | null> => {
        signal.throwIfAborted();
        const check: PhotoCheck = { ...photoCheck, printingMarks: { ...marks, firstEditionStamp: stamp } };
        const resolved = await identify(check);
        signal.throwIfAborted();
        const candidate = resolved.identity;
        if (!resolved.card || resolved.card.source !== "pkmnprices" || !readyForPricing(candidate) || candidate.notThisCard ||
            candidate.printing !== expected || candidate.finish !== card.finish ||
            !sameCatalogName(candidate.name, card.name) || !sameSetFamily(candidate.set, card.set) ||
            !sameCardNumber(candidate.cardNumber, card.cardNumber)) return null;
        const prices = await price(candidate, resolved.card);
        signal.throwIfAborted();
        if (!hasScopedPrices(prices, candidate)) return null;
        const underwriting = underwrite({ ...evaluation, ...prices, identity: candidate, photoCheck: check }, config);
        return underwriting.best ? { ...prices, check, identity: candidate, underwriting } : null;
    };
    const visible = await scenario("VISIBLE", "FIRST_EDITION");
    if (!visible || !["BUY_RAW", "BUY_AND_GRADE", "PASS"].includes(visible.underwriting.verdict)) return null;
    const absent = await scenario("NOT_PRESENT", absentPrinting);
    if (!absent) return null;
    const visibleBuys = visible.underwriting.verdict.startsWith("BUY");
    const absentBuys = absent.underwriting.verdict.startsWith("BUY");
    const changesDecision = visibleBuys && absent.underwriting.verdict === "PASS" || absentBuys && visible.underwriting.verdict === "PASS";
    return changesDecision ? { VISIBLE: visible, NOT_PRESENT: absent } : null;
}

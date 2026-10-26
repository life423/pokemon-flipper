import { test } from "node:test";
import assert from "node:assert/strict";
import { sellerMistakes } from "../../server/deals/seller-mistakes.ts";
import { confirmPhotoIdentity } from "../../server/identity/photo-confirmation.ts";
import { photoFitsSearch } from "../../server/ai/photo-find.ts";

const card = { name: "Charizard", set: "Base Set", cardNumber: "4/102", language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["Printed Charizard, 4/102, Base artwork and copyright"] };
const marks = { firstEditionStamp: "VISIBLE", artBoxShadow: "ABSENT", reprintMark: "NONE_SEEN" };
const scan = { cardCount: 1, isStockImage: false, card, printingMarks: marks, shows: "Charizard 4/102" };
const full = { cardCount: "ONE", holder: "NONE", cardIdentity: card, printingMarks: marks, images: [{ view: "FRONT", usable: true, isStockImage: false }], problems: [] };
const kinds = (title, photo = scan, claims = {}) => sellerMistakes({ title }, photo, claims).map((entry) => entry.kind);

test("seller mistakes cover spelling, omitted stamps, Shadowless, holo, wrong sets and generic names", () => {
    for (const [wrong, name] of [["Charzard", "Charizard"], ["Blastiose", "Blastoise"], ["Venusuar", "Venusaur"]]) {
        assert.ok(kinds(`${wrong} Unlimited non-holo`, { ...scan, card: { ...card, name } }).includes("NAME"));
    }
    const found = kinds("Old Pokemon Card 1999 Unlimited Non-Holo", scan, { Set: "Team Rocket" });
    for (const kind of ["FIRST_EDITION", "HOLO", "SET", "GENERIC_TITLE"]) assert.ok(found.includes(kind), kind);
    assert.ok(kinds("Charizard Unlimited", { ...scan, printingMarks: { ...marks, firstEditionStamp: "NOT_PRESENT" } }).includes("SHADOWLESS"));
    assert.ok(!kinds("Charizard 1st Edition Holo Base Set 4/102").includes("FIRST_EDITION"));
});

test("stock images, uncertain readings, reverse foil and incomplete printing marks do not invent seller mistakes", () => {
    assert.deepEqual(kinds("Charzard", { ...scan, isStockImage: true }), []);
    assert.deepEqual(kinds("Charzard", { ...scan, card: { ...card, confidence: "LOW" } }), []);
    const ambiguous = { ...scan, card: { ...card, finish: "UNKNOWN" }, printingMarks: { firstEditionStamp: "CANT_TELL", artBoxShadow: "CANT_TELL" } };
    assert.deepEqual(kinds("Charizard Base Set non-holo", ambiguous), []);
    assert.ok(!kinds("Charizard non-holo", { ...scan, card: { ...card, finish: "REVERSE_HOLO" } }).includes("HOLO"));
});

test("photo discovery honors exact search identity and rejects generic uncertain or non-English cards", () => {
    const intent = { cardName: "Charizard", sets: ["Base Set"], cardNumber: "4/102", printing: "FIRST_EDITION" };
    assert.equal(photoFitsSearch(scan, intent), true);
    assert.equal(photoFitsSearch(scan, { ...intent, sets: ["Team Rocket"] }), false);
    assert.equal(photoFitsSearch(scan, { ...intent, cardNumber: "6/102" }), false);
    assert.equal(photoFitsSearch({ ...scan, card: { ...card, language: "Japanese" } }, intent), false);
    assert.equal(photoFitsSearch({ ...scan, cardCount: 2 }, intent), false);
    assert.equal(photoFitsSearch({ ...scan, isStockImage: true }, intent), false);
});

test("raising a valuation requires two matching independent identity/printing/finish readings", () => {
    assert.deepEqual(confirmPhotoIdentity(scan, full), { name: "Charizard", set: "Base Set", cardNumber: "4/102", finish: "HOLO", printing: "FIRST_EDITION" });
    assert.equal(confirmPhotoIdentity(null, full), undefined);
    assert.equal(confirmPhotoIdentity(scan, { ...full, cardIdentity: { ...card, confidence: "MEDIUM" } }), undefined);
    assert.equal(confirmPhotoIdentity(scan, { ...full, cardIdentity: { ...card, set: "Celebrations" } }), undefined);
    assert.equal(confirmPhotoIdentity(scan, { ...full, images: [{ view: "BACK", usable: true }] }), undefined);
    assert.equal(confirmPhotoIdentity(scan, { ...full, problems: ["Possible counterfeit print"] }), undefined);
    assert.equal(confirmPhotoIdentity(scan, { ...full, printingMarks: { ...marks, reprintMark: "CELEBRATIONS_25TH" } }), undefined);
    assert.equal(confirmPhotoIdentity(scan, { ...full, printingMarks: { ...marks, firstEditionStamp: "CANT_TELL" } })?.printing, undefined);
    assert.equal(confirmPhotoIdentity(scan, { ...full, cardIdentity: { ...card, finish: "UNKNOWN" } })?.finish, undefined);
});

test("a Mew search cannot silently become Mewtwo through substring matching", () => {
    const mewtwo = { ...scan, card: { ...card, name: "Mewtwo", cardNumber: "10/102" } };
    const mew = { cardName: "Mew", sets: [], cardNumber: null, printing: null };
    assert.equal(photoFitsSearch(mewtwo, mew), false);
    assert.equal(confirmPhotoIdentity(mewtwo, { ...full, cardIdentity: { ...card, name: "Mew", cardNumber: "10/102" } }), undefined);
});

test("set-symbol explanations are separated from canonical price lookup names", async () => {
    const { cleanPhotoCard } = await import("../../server/ai/photo-card-schema.ts");
    assert.equal(cleanPhotoCard({ ...card, set: "Base Set (no set symbol)" }).set, "Base Set");
    assert.equal(cleanPhotoCard({ ...card, set: "Base Set (set symbol: none; original Base Set printing)" }).set, "Base Set");
    assert.equal(cleanPhotoCard({ ...card, set: "Base Set (Shadowless)" }).set, "Base Set (Shadowless)");
    assert.equal(cleanPhotoCard({ ...card, set: "Base Set 2" }).set, "Base Set 2");
});

test("a full assessment removes a disproved Shadowless lead and its bargain boost", async () => {
    const { currentSellerMistakes } = await import("../../shared/seller-mistakes.ts");
    const { bargainSignals } = await import("../../shared/signals.ts");
    const listing = { title: "Mewtwo Base Set holo 10/102", buyingOption: "FIXED_PRICE", mistakes: [{ kind: "SHADOWLESS", detail: "Possible Shadowless" }], found: { how: "PHOTO_SHOWS_IT", note: "A quick photo lead" } };
    const evaluation = { identity: { status: "IDENTIFIED", name: "Mewtwo", set: "Base Set", printing: "UNLIMITED", finish: "HOLO", evidence: { photo: "UNLIMITED" } } };
    assert.deepEqual(currentSellerMistakes(listing, evaluation), []);
    assert.ok(!bargainSignals(listing, evaluation).some((signal) => signal.id === "FOUND" || signal.id === "SELLER_SHADOWLESS"));
    assert.ok(!kinds("Charizard Shadowless 1st Edition", { ...scan, printingMarks: { ...marks, firstEditionStamp: "NOT_PRESENT" } }).includes("SHADOWLESS"));
});

test("a missing art shadow alone cannot corroborate a Shadowless premium", async () => {
    const { supportsShadowless } = await import("../../server/ai/shadowless-check.ts");
    const finding = { cardType: "POKEMON", hpFont: "THIN_EARLY_BASE_SET", artworkShadow: "ABSENT", confidence: "HIGH", evidence: ["Legible thin HP type and absent artwork border shadow"] };
    assert.equal(supportsShadowless(finding), true);
    assert.equal(supportsShadowless({ ...finding, hpFont: "CANT_TELL" }), false);
    assert.equal(supportsShadowless({ ...finding, hpFont: "THICK_UNLIMITED" }), false);
    assert.equal(supportsShadowless({ ...finding, cardType: "TRAINER" }), false);
    assert.equal(supportsShadowless({ ...finding, confidence: "LOW" }), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { cropStampFromImage, selectStampCrop } from "../../server/analysis/stamp-crop.ts";

const width = 640, height = 800;
const yellow = [230, 185, 35], blue = [68, 140, 181];

async function front(complete: boolean) {
    const pixels = Buffer.alloc(width * height * 3, 42);
    for (let y = 100; y < 700; y++) {
        for (let x = 100; x < 530; x++) {
            const edge = x < 119 || x >= 511 || y < 119 || y >= 681;
            pixels.set(edge && (complete || x < 511) ? yellow : blue, (y * width + x) * 3);
        }
    }
    return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

test("stamp crop locates a card in the scene and extracts its native pixels", async () => {
    const source = await front(true);
    const result = await cropStampFromImage(source);
    assert.ok(result);
    const { left, top, width, height } = result.box;
    assert.ok(left <= 150 && top <= 425 && left + width > 150 && top + height > 425,
        "the expected stamp area is inside the crop");
    const crop = Buffer.from(result.dataUrl.split(",")[1], "base64");
    const pixels = await sharp(crop).raw().toBuffer();
    assert.deepEqual(pixels, await sharp(source).extract(result.box).raw().toBuffer());
});

test("stamp crop abstains when an edge is missing or the photo has no card geometry", async () => {
    assert.equal(await cropStampFromImage(await front(false)), null);
    const plain = await sharp({ create: { width, height, channels: 3, background: "#e6b923" } }).png().toBuffer();
    assert.equal(await cropStampFromImage(plain), null);
});

test("stamp crop uses assessed front photos and retains the original photo number", async t => {
    const source = await front(true);
    const fetch = t.mock.method(globalThis, "fetch", async () => new Response(source, { headers: { "content-type": "image/png" } }));
    const url = (id: string) => `https://i.ebayimg.com/images/g/${id}/s-l500.jpg`;
    const photos = ["back", "stock", "obscured", "good"].map(url);
    const usable = { usable: true, isStockImage: false, issues: [] };
    const result = await selectStampCrop(photos, [
        { ...usable, view: "BACK", number: 1 },
        { ...usable, view: "FRONT", number: 2, isStockImage: true },
        { ...usable, view: "FRONT", number: 3, obscuresCondition: true },
        { ...usable, view: "FRONT", number: 4 },
    ]);
    assert.equal(result?.photoNumber, 4);
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(fetch.mock.calls[0].arguments[0], "https://i.ebayimg.com/images/g/good/s-l1600.jpg");
});

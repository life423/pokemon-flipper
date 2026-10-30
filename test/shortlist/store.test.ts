import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanSavedListing, createShortlistStore } from "../../server/shortlist/store.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

export function savedListing(id = "v1|111|0") {
    const e = cardEvaluation();
    return { id, title: e.listing.title, url: "https://www.ebay.com/itm/111", currentPrice: 10, shipping: 0, bids: 1, isGraded: false, buyingOption: "AUCTION" as const, endTime: e.listing.endTime, images: ["https://i.ebayimg.com/images/g/front/s-l500.jpg"], seller: e.listing.seller };
}
test("saving, editing and removing are durable and concurrent saves do not lose entries", async (t) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-shortlist-"));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    const file = path.join(folder, "shortlist.json"); const store = createShortlistStore(file);
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.save(savedListing(`v1|${i}|0`), null)));
    await store.update("v1|1|0", (entry) => ({ ...entry, notes: "Check back corner", ceiling: 21.5 }));
    await store.save(savedListing("v1|1|0"), null);
    const reopened = createShortlistStore(file); const entries = await reopened.list();
    assert.equal(entries.length, 20); assert.equal(entries.find((entry) => entry.id === "v1|1|0")?.notes, "Check back corner");
    await reopened.remove("v1|1|0"); assert.equal((await store.list()).length, 19);
    assert.equal(await store.update("removed", (entry) => entry), null);
});
test("a corrupt saved file is preserved rather than silently replaced", async (t) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-corrupt-"));t.after(() => fs.rm(folder, { recursive: true, force: true }));
    const file = path.join(folder, "shortlist.json");await fs.writeFile(file, "broken user data");const store=createShortlistStore(file);
    await assert.rejects(store.list(), /existing file was kept/);await assert.rejects(store.save(savedListing(),null), /existing file was kept/);assert.equal(await fs.readFile(file,"utf8"),"broken user data");
});
test("saved snapshots reject invalid URLs and amounts and strip client financial advice", () => {
    for (const listing of [{...savedListing(),url:"javascript:alert(1)"},{...savedListing(),currentPrice:Infinity},{...savedListing(),id:"../escape"}]) assert.throws(()=>cleanSavedListing(listing), /valid listing snapshot/);
    const clean=cleanSavedListing({...savedListing(),evaluation:{underwriting:{verdict:"BUY_RAW"}},screen:{status:"CANDIDATE"}});
    assert.equal(clean.screen,undefined);assert.equal("evaluation" in clean,false);
});

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createShortlistStore } from "../../server/shortlist/store.ts";
import { createShortlistService } from "../../server/shortlist/service.ts";
import { ANALYSIS_VERSION } from "../../server/ai/openai.ts";
import { EbayError } from "../../server/ebay/api.ts";
import type { ListingDetails } from "../../server/ebay/listings.ts";
import type { SavedRecord } from "../../server/analysis/types.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import { listingEvidenceKey } from "../../shared/listing-evidence.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
const listing = () => ({ id:"v1|111|0",title:"Venusaur Base Set 15/102",url:"https://www.ebay.com/itm/111",currentPrice:10,shipping:0,bids:1,isGraded:false,buyingOption:"AUCTION" as const,endTime:new Date(Date.now()+86400000).toISOString(),images:["https://i.ebayimg.com/images/g/front/s-l500.jpg"],seller:null });
const details = (): ListingDetails => ({ id:"v1|111|0",title:listing().title,url:listing().url,price:20,shipping:null,bids:2,buyingOption:"AUCTION",endTime:listing().endTime,images:["https://i.ebayimg.com/images/g/front/s-l1600.jpg"],seller:null,condition:"Ungraded",cardCondition:null,conditionNotes:[],aspects:{},availability:"ACTIVE" });
async function fixture(t: TestContext) {
    const folder=await fs.mkdtemp(path.join(os.tmpdir(),"pokemon-refresh-"));t.after(()=>fs.rm(folder,{recursive:true,force:true}));return createShortlistStore(path.join(folder,"saved.json"));
}
function snapshot(): SavedRecord {
    const e=cardEvaluation();Object.assign(e.listing,{id:listing().id,title:listing().title,photos:details().images,shipping:0,price:10});
    return {itemId:listing().id,version:ANALYSIS_VERSION,photoFingerprint:"fixture",answeredAt:e.answeredAt,photoCheck:null,assessment:null,latestEvaluation:{evidenceKey:listingEvidenceKey(listing()),evaluation:e}};
}
test("save uses the local assessment; refresh reuses it, honors a fresh unknown shipping quote and has a durable cooldown",async t=>{
    const store=await fixture(t);let requests=0;let clock=Date.now();
    const service=createShortlistService({store,load:async()=>snapshot(),details:async(_id,options)=>{assert.equal(options?.maxAgeHours,0);assert.equal(options?.keepReserve,true);requests++;return details();},now:()=>clock});
    const saved=await service.save(listing());assert.ok(saved.evaluation);assert.equal(requests,0);
    await store.update(saved.id,e=>({...e,notes:"Keep this note",ceiling:25}));
    const result=await service.refresh([saved.id,saved.id]);assert.equal(requests,1);assert.equal(result.errors.length,0);const entry=result.entries[0];
    assert.equal(entry.listing.currentPrice,20);assert.equal(entry.evaluation?.listing.shipping,null);assert.equal(entry.needsAnalysis,false);assert.equal(entry.notes,"Keep this note");assert.equal(entry.ceiling,25);
    const repriced=retargetEvaluation(snapshot().latestEvaluation!.evaluation,{minProfit:0,minRoi:0},entry.listing);assert.equal(repriced.listing.shipping,null);assert.ok(repriced.underwriting?.assumptions.some(note=>note.includes("$7.00")));
    await service.refresh([saved.id]);assert.equal(requests,1);
    const restarted=createShortlistService({store,details:async()=>{throw Error("cooldown must prevent request");},now:()=>clock});assert.equal((await restarted.refresh([saved.id])).errors.length,0);
    clock+=61_000;await service.refresh([saved.id]);assert.equal(requests,2);
});
test("changed photos clear financial advice without invoking an assessment",async t=>{
    const store=await fixture(t);const service=createShortlistService({store,load:async()=>snapshot(),details:async()=>({...details(),images:["https://i.ebayimg.com/new.jpg"]})});await service.save(listing());const entry=(await service.refresh([listing().id])).entries[0];
    assert.equal(entry.evaluation,null);assert.equal(entry.needsAnalysis,true);assert.deepEqual(entry.listing.images,["https://i.ebayimg.com/new.jpg"]);
});
test("resaving after known photo changes cannot resurrect an older assessment", async t => {
    const store=await fixture(t);const service=createShortlistService({store,load:async()=>snapshot(),cached:async()=>({...details(),images:[]})});
    assert.equal((await service.save(listing())).evaluation,null);
});
test("unavailable listings lose buy and bid advice; failures preserve snapshots and back off",async t=>{
    const store=await fixture(t);let calls=0;let clock=Date.now();let status=503;
    const service=createShortlistService({store,load:async()=>snapshot(),details:async()=>{calls++;throw new EbayError("offline provider failure",status);},now:()=>clock});await service.save(listing());
    const failure=await service.refresh([listing().id]);assert.equal(failure.errors.length,1);assert.equal(failure.entries[0].checkedAt,null);await service.refresh([listing().id]);assert.equal(calls,1);
    clock+=31_000;status=404;const ended=await service.refresh([listing().id]);assert.equal(ended.errors.length,0);assert.equal(ended.entries[0].listing.availability,"UNAVAILABLE");assert.equal(ended.entries[0].evaluation?.underwriting?.verdict,"PASS");assert.equal(ended.entries[0].evaluation?.underwriting?.best,null);
});
test("edits during refresh survive and removing a listing cannot be undone by a late refresh",async t=>{
    const store=await fixture(t);let release:()=>void=()=>{};let started:()=>void=()=>{};const ready=new Promise<void>(resolve=>started=resolve);const wait=new Promise<void>(resolve=>release=resolve);
    const service=createShortlistService({store,details:async()=>{started();await wait;return details();},load:async()=>snapshot()});await service.save(listing());const refreshing=service.refresh([listing().id]);await ready;
    await store.update(listing().id,e=>({...e,notes:"Edited during request"}));release();assert.equal((await refreshing).entries[0].notes,"Edited during request");
    let releaseAgain:()=>void=()=>{};let startedAgain:()=>void=()=>{};const readyAgain=new Promise<void>(resolve=>startedAgain=resolve);const waitAgain=new Promise<void>(resolve=>releaseAgain=resolve);
    const later=createShortlistService({store,details:async()=>{startedAgain();await waitAgain;return details();},now:()=>Date.now()+120_000});const pending=later.refresh([listing().id]);await readyAgain;await store.remove(listing().id);releaseAgain();assert.deepEqual((await pending).entries,[]);
});
test("refresh globally bounds concurrency to two and ignores IDs outside the shortlist",async t=>{
    const store=await fixture(t);let active=0;let maximum=0;let calls=0;
    for(let i=0;i<8;i++)await store.save({...listing(),id:`v1|${i}|0`},null);
    const service=createShortlistService({store,details:async id=>{calls++;active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,5));active--;return {...details(),id};}});
    await service.refresh(["not-saved",...Array.from({length:8},(_,i)=>`v1|${i}|0`)]);assert.equal(calls,8);assert.equal(maximum,2);
});

test("fresh evaluations update saved terms and photos without losing notes; later refresh evidence wins", async t => {
    const store = await fixture(t);
    const service = createShortlistService({ store, load: async () => snapshot() });
    await service.save(listing());
    await store.update(listing().id, entry => ({ ...entry, notes: "Keep my note", ceiling: 30 }));
    const e = snapshot().latestEvaluation!.evaluation;
    Object.assign(e.listing, { price: 22, shipping: null, title: "Corrected title", photos: ["https://i.ebayimg.com/changed.jpg"], termsCheckedAt: "2026-10-30T12:00:00Z" });
    const key = listingEvidenceKey({ title: e.listing.title, images: e.listing.photos! });
    await service.remember(e, key);
    let saved = (await store.list())[0];
    assert.equal(saved.listing.currentPrice, 22); assert.equal(saved.listing.shipping, null); assert.equal(saved.notes, "Keep my note"); assert.equal(saved.ceiling, 30); assert.equal(saved.needsAnalysis, false);
    await store.update(saved.id, entry => ({ ...entry, listing: { ...entry.listing, title: "Newer photo revision", images: [], termsCheckedAt: "2026-10-30T12:01:00Z" }, evaluation: null, needsAnalysis: true }));
    await service.remember(e, key);
    saved = (await store.list())[0]; assert.equal(saved.evaluation, null); assert.equal(saved.needsAnalysis, true);
});

test("saving an old browser snapshot keeps newer locally verified terms", async t => {
    const store = await fixture(t);
    const record = snapshot();
    Object.assign(record.latestEvaluation!.evaluation.listing, { price: 28, termsCheckedAt: "2026-10-30T12:00:00Z" });
    const service = createShortlistService({ store, load: async () => record });
    const saved = await service.save({ ...listing(), currentPrice: 1 });
    assert.equal(saved.listing.currentPrice, 28); assert.equal(saved.evaluation?.listing.price, 28);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPricingRetries } from "../../server/deals/pricing-retries.ts";
import { PricingProviderError, pricingIssue, retryAfterMs } from "../../server/pricing/errors.ts";
import { applyPricingRetry, canRetryPricing, pricingSnapshotKey } from "../../shared/pricing-retries.ts";
import { prescreen } from "../../server/deals/prescreen.ts";
import { screenListing } from "../../server/deals/find-deals.ts";
import { cardDetails } from "../../shared/card-details.ts";
import { withFreshListing } from "../../shared/fresh-listing.ts";

const TIME = Date.parse("2026-10-30T12:00:00Z");
const targets = { minProfit: 50, minRoi: .25 };
const issue = (time = TIME, kind = "RATE_LIMIT") => ({ kind, retryAt: new Date(time + 30_000).toISOString() });
const pending = (time = TIME) => ({ status: "UNSCREENED", reason: "provider cooling down", pricingIssue: issue(time), card: null, bestCase: null, assumed: null });
const priced = () => ({ status: "DROPPED", reason: "Above limit", card: { name: "Nidoking", set: "Aquapolis" }, bestCase: null, assumed: "PSA 9, as listed" });
const input = () => ({ title: "Aquapolis Nidoking Holo PSA 9", aspects: { Set: "Aquapolis", "Card Name": "Nidoking", "Card Number": "H18/H32", "Professional Grader": "PSA", Grade: "9" }, price: 200, shipping: 5, isGraded: true, cardCondition: null, buyingOption: "FIXED_PRICE" });
const listing = (id = "one") => ({ id, title: input().title, images: ["https://i.ebayimg.com/images/g/test/s-l500.jpg"], isGraded: true, listedAttributes: { grader: "PSA", grade: 9, finish: "HOLO" }, currentPrice: 200, shipping: 5, bids: 0, endTime: null, buyingOption: "FIXED_PRICE", url: "https://www.ebay.com/itm/267743966894", seller: null, screen: pending() });

test("an unknown finish does not suppress temporary pricing recovery or become an assumed match", async () => {
    let time = TIME;
    const queue = createPricingRetries({ now: () => time, cooldown: () => null, price: async () => priced() });
    const row = { ...listing(), match: "UNCONFIRMED_CRITERIA", listedAttributes: { grader: "PSA", grade: 9, finish: null } };
    const intent = { cardName: null, sets: ["Aquapolis"], cardNumber: null, printing: null, graded: true, titleWords: [], grader: "PSA", minGrade: 9, maxGrade: 9, finish: "HOLO", source: "rules" };
    const ticket = queue.register(row, input(), intent);
    assert.ok(ticket);
    assert.equal(canRetryPricing({ ...row, screen: { ...row.screen, pricingRetry: ticket } }, time), true);
    assert.equal(canRetryPricing({ ...row, match: "OTHER_FINISH", screen: { ...row.screen, pricingRetry: ticket } }, time), false);
    time += 31000;
    const recovered = (await queue.retry([ticket.ticket], targets, false)).results[0];
    assert.equal(recovered.match, "UNCONFIRMED_CRITERIA");
    assert.equal(recovered.screen.needsAnalysis, "FINISH");
    assert.equal(recovered.screen.pricingIssue, undefined);
});

test("only typed temporary pricing failures are retryable, not identity/no-comp problems", async () => {
    const deps = { lookupCards: async () => { throw new PricingProviderError("rate limited", "RATE_LIMIT", TIME + 30_000); }, fetchComps: async () => [] };
    const screen = await prescreen(input(), deps);
    assert.equal(screen.pricingIssue.kind, "RATE_LIMIT");
    const unknown = await prescreen(input(), { ...deps, lookupCards: async () => [] });
    assert.equal(unknown.pricingIssue, undefined);
    const queue = createPricingRetries({ now: () => TIME, cooldown: () => null });
    assert.equal(queue.register({ ...listing(), screen: unknown }, input(), null), undefined);
    for (const kind of ["CONFIG", "CREDITS"]) assert.equal(queue.register({ ...listing(), screen: { ...pending(), pricingIssue: issue(TIME, kind) } }, input(), null), undefined);
    assert.equal(pricingIssue(new Error("missing identity")), undefined);
});

test("cooldown and Retry-After are honored without running any pricing work", async () => {
    let time = TIME; let calls = 0;
    const queue = createPricingRetries({ now: () => time, cooldown: () => null, price: async () => { calls++; return priced(); } });
    const ticket = queue.register(listing(), input(), null);
    const early = await queue.retry([ticket.ticket], targets, false);
    assert.equal(calls, 0); assert.equal(early.results[0].screen.pricingRetry.attemptsLeft, 3);
    time += 30_000;
    await queue.retry([ticket.ticket], targets, false); assert.equal(calls, 1);
    assert.equal(retryAfterMs("120", TIME, 5000), 120_000);
    assert.equal(retryAfterMs(new Date(TIME + 60_000).toUTCString(), TIME, 5000), 60_000);
    assert.equal(retryAfterMs("invalid", TIME, 5000), 5000);
});

test("provider-wide cooldown defers ready tickets without consuming attempts", async () => {
    let time = TIME; let calls = 0;
    const queue = createPricingRetries({ now: () => time, cooldown: () => issue(time), price: async () => { calls++; return priced(); } });
    const ticket = queue.register(listing(), input(), null); time += 40_000;
    const result = await queue.retry([ticket.ticket], targets, false);
    assert.equal(calls, 0); assert.equal(result.results[0].screen.pricingRetry.attemptsLeft, 3);
    assert.ok(Date.parse(result.results[0].screen.pricingRetry.retryAt) > time);
});

test("repeated snapshots share a ticket and successful duplicate requests reuse their result", async () => {
    let time = TIME; let calls = 0;
    const queue = createPricingRetries({ now: () => time, cooldown: () => null, price: async (value, requestedTargets, offers) => { calls++; assert.equal(value.price, 200); assert.equal(requestedTargets.minProfit, 50); assert.equal(offers, true); return priced(); } });
    const original = { ...listing(), screen: { ...pending(), evidence: { photos: 2, mainPhoto: "MATCH" }, filledFromTitle: ["Set"] } };
    const ticket = queue.register(original, input(), null);
    assert.equal(queue.register(original, input(), null).ticket, ticket.ticket);
    time += 31_000; const result = await queue.retry([ticket.ticket, ticket.ticket], targets, true);
    assert.deepEqual(result.results[0].screen.evidence, original.screen.evidence);
    assert.deepEqual(result.results[0].screen.filledFromTitle, ["Set"]);
    await queue.retry([ticket.ticket], targets, true); assert.equal(calls, 1);
});

test("a new throttle stops the rest of the batch and keeps existing results", async () => {
    let time = TIME; let calls = 0;
    const queue = createPricingRetries({ now: () => time, cooldown: () => null, price: async () => { calls++; return pending(time); } });
    const tickets = ["one", "two", "three"].map(id => queue.register(listing(id), input(), null).ticket); time += 31_000;
    const result = await queue.retry(tickets, targets, false);
    assert.equal(calls, 1); assert.equal(result.results.length, 3);
    assert.equal(result.results[0].screen.pricingRetry.attemptsLeft, 2);
    assert.equal(result.results[1].screen.pricingRetry.attemptsLeft, 3);
    assert.match(result.note, /deferred/);
});

test("repeated failures exhaust three attempts and do not reset when registered again", async () => {
    let time = TIME; let calls = 0;
    const queue = createPricingRetries({ now: () => time, cooldown: () => null, price: async () => { calls++; return pending(time); } });
    const ticket = queue.register(listing(), input(), null);
    for (let i = 0; i < 4; i++){ time += 31_000; await queue.retry([ticket.ticket], targets, false); }
    assert.equal(calls, 3); assert.equal(queue.register(listing(), input(), null).attemptsLeft, 0);
});

test("batches are paced and concurrent submissions cannot duplicate pricing work", async () => {
    let time = TIME; let calls = 0; let finish;
    const waits = [];
    const queue = createPricingRetries({ now: () => time, cooldown: () => null, wait: async ms => { waits.push(ms); time += ms; }, price: async () => { calls++; if(calls===1) await new Promise(resolve => { finish=resolve; }); return priced(); } });
    const tickets = ["one", "two"].map(id=>queue.register(listing(id),input(),null).ticket); time+=31_000;
    const run=queue.retry(tickets,targets,false);await Promise.resolve();
    await assert.rejects(queue.retry(tickets,targets,false),/already running/); finish(); await run;
    assert.equal(calls,2); assert.deepEqual(waits,[1500]);
});

test("canceling a batch stops subsequent jobs; a completed first job remains reusable", async () => {
    let time=TIME;let calls=0;const controller=new AbortController();
    const queue=createPricingRetries({now:()=>time,cooldown:()=>null,price:async()=>{calls++;controller.abort();return priced();}});
    const tickets=["one","two"].map(id=>queue.register(listing(id),input(),null).ticket);time+=31_000;
    await assert.rejects(queue.retry(tickets,targets,false,controller.signal),/abort/i); assert.equal(calls,1);
    await queue.retry([tickets[0]],targets,false);assert.equal(calls,1);
});

test("forged, expired and oversized tickets stop before any provider work", async () => {
    let time=TIME;let calls=0;const queue=createPricingRetries({now:()=>time,cooldown:()=>null,price:async()=>{calls++;return priced();}});
    const ticket=queue.register(listing(),input(),null);
    await assert.rejects(queue.retry(["invented"],targets,false),/expired/);
    await assert.rejects(queue.retry(Array(6).fill(ticket.ticket),targets,false),/up to 5/);
    time+=31*60_000;await assert.rejects(queue.retry([ticket.ticket],targets,false),/expired/);assert.equal(calls,0);
});

test("ended listings and changed snapshots cannot be repriced using an old retry", async () => {
    let time=TIME;let calls=0;const queue=createPricingRetries({now:()=>time,cooldown:()=>null,price:async()=>{calls++;return priced();}});
    const original={...listing(),endTime:new Date(TIME+10_000).toISOString()};const hint=queue.register(original,input(),null);time+=31_000;
    await queue.retry([hint.ticket],targets,false);assert.equal(calls,0);
    const value=listing();const result={id:value.id,snapshotKey:pricingSnapshotKey(value),screen:priced()};
    for(const changed of [{...value,title:"Changed title"},{...value,currentPrice:250},{...value,images:["changed"]},{...value,listedAttributes:{grader:"PSA",grade:7,finish:"HOLO"}}])assert.equal(applyPricingRetry(changed,result),changed);
    assert.equal(applyPricingRetry(value,result).screen.status,"DROPPED");
    assert.equal(canRetryPricing({...original,screen:{...pending(),pricingRetry:hint}},time),false);
});

test("a recovered identity still has to match the original search", async () => {
    let time=TIME;const queue=createPricingRetries({now:()=>time,cooldown:()=>null,price:async()=>({...priced(),card:{set:"Skyridge"}})});
    const hint=queue.register(listing(),input(),{cardName:null,sets:["Aquapolis"],titleWords:[],printing:null,cardNumber:null,graded:true,source:"rules"});time+=31_000;
    assert.equal((await queue.retry([hint.ticket],targets,false)).results[0].match,"OTHER_SET");
});

test("normal screening captures only a failed pricing input and structured seller attributes", async()=>{
    let captured;
    const result=await screenListing(listing(),{readTitle:async()=>({aspects:input().aspects,filled:[]}),check:async()=>pending(),loadDetails:async()=>{throw Error("not needed");},matchPhoto:async()=>{throw Error("not needed");},deferPricing:(value,pricingInput)=>{captured={value,pricingInput};return {ticket:"ticket",retryAt:new Date(TIME).toISOString(),snapshotKey:pricingSnapshotKey(value),attemptsLeft:3};}});
    assert.equal(captured.pricingInput.aspects.Grade,"9");assert.equal(result.screen.pricingRetry.ticket,"ticket");assert.deepEqual(result.listedAttributes,{grader:"PSA",grade:9,finish:"HOLO"});
});

test("card headers distinguish listed, checked, raw, unknown and qualified grades",()=>{
    assert.deepEqual(cardDetails(listing(),null),{source:"Listed",grade:"PSA 9",finish:"Holo"});
    assert.deepEqual(cardDetails({...listing(),isGraded:false},null),{source:"Listed",grade:"Raw",finish:"Holo"});
    assert.equal(cardDetails({...listing(),listedAttributes:undefined,title:"1999 card 9/102"},null).grade,"Grade unknown");
    const evaluation={slab:{status:"OK",grader:"CGC",grade:"8.5"},identity:{finish:"REVERSE_HOLO"},photoCheck:{slab:{present:true,grader:"CGC",grade:"8.5"}}};
    assert.deepEqual(cardDetails(listing(),evaluation),{source:"Label checked",grade:"CGC 8.5",finish:"Reverse holo"});
    assert.deepEqual(cardDetails({...listing(),isGraded:false},{identity:{finish:"HOLO"},condition:{gradeRange:{high:10}}}),{source:"Photo assessed",grade:"Raw",finish:"Holo"});
    assert.equal(cardDetails(listing(),{photoCheck:{slab:{present:false}},identity:{finish:"UNKNOWN"}}).finish,"Finish unknown");
    assert.deepEqual(cardDetails(listing(),{photoCheck:{slab:{present:true,grader:"PSA",grade:"9",gradeQualifier:"OC"}}}),{source:"Review needed",grade:"PSA 9 (OC)",finish:"Finish unknown"});
});

test("fresh server snapshots replace old header attributes and discard old retry hints",()=>{
    const evaluation={listing:{title:"Changed card",url:"url",price:200,shipping:5,bids:0,endTime:null,buyingOption:"FIXED_PRICE",seller:null,availability:"ACTIVE",termsCheckedAt:new Date(TIME).toISOString(),aspects:{"Professional Grader":"CGC",Grade:"8.5",Finish:"Reverse Holo"}}};
    const fresh=withFreshListing(listing(),evaluation);assert.deepEqual(fresh.listedAttributes,{grader:"CGC",grade:8.5,finish:"REVERSE_HOLO"});assert.equal(fresh.screen,undefined);
});

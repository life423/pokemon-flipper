import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSearchHistory } from "../../server/search/history.ts";
import { createNewListingDiscovery } from "../../server/deals/new-listings.ts";
import { searchListings } from "../../server/ebay/listings.ts";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";

test("seen listings persist per query and minimum price; discovery skips them before screening",async t=>{
    const folder=await fs.mkdtemp(path.join(os.tmpdir(),"pokemon-new-"));t.after(()=>fs.rm(folder,{recursive:true,force:true}));const history=createSearchHistory(path.join(folder,"history.json"));
    await history.remember("Vénusaur",10,["old"]);assert.deepEqual(await createSearchHistory(path.join(folder,"history.json")).seen("  venusaur ",10),["old"]);assert.deepEqual(await history.seen("venusaur",0),[]);
    let calls=0;const discover=createNewListingDiscovery({history,usage:async()=>null,find:async(_query,options)=>{calls++;assert.equal(options?.newOnly?.limit,20);assert.ok(options?.newOnly?.excludeIds.includes("old"));assert.ok(options?.newOnly?.excludeIds.includes("client"));options?.onListing?.({id:"new"} as never);return [];}});
    await discover("venusaur",{minPrice:10},["client"]);assert.equal(calls,1);assert.deepEqual(await history.seen("venusaur",10),["old","new"]);
});
test("the reserve blocks discovery and overlapping scans cannot duplicate work",async()=>{
    let calls=0;const history={seen:async()=>[],remember:async()=>{}};const blocked=createNewListingDiscovery({history,usage:async()=>({braking:true} as never),find:async()=>{calls++;return [];}});await assert.rejects(blocked("query",{}),/preserve/);assert.equal(calls,0);
    let release:()=>void=()=>{};let started:()=>void=()=>{};const ready=new Promise<void>(resolve=>started=resolve);const wait=new Promise<void>(resolve=>release=resolve);
    const discover=createNewListingDiscovery({history,usage:async()=>null,find:async()=>{calls++;started();await wait;return [];}});const first=discover("query",{});await ready;await assert.rejects(discover("query",{}),/already running/);release();await first;assert.equal(calls,1);
});
test("newest searches use their own short-lived cache and one requested page",async t=>{
    offlineEbayCredentials(t);
    const query=`offline-new-${Date.now()}`;let pages=0;const sorts:(string|null)[]=[];const start=Date.now();let clock=start;t.mock.method(Date,"now",()=>clock);
    t.mock.method(globalThis,"fetch",async(url:unknown)=>{const address=String(url);if(address.includes("oauth2/token"))return Response.json({access_token:"offline",expires_in:3600});if(address.includes("rate_limit"))return Response.json({rateLimits:[{apiName:"Browse",resources:[{name:"buy.browse",rates:[{count:0,limit:5000,remaining:5000}]}]}]});
        const params=new URL(address).searchParams;assert.equal(params.get("offset"),"0");sorts.push(params.get("sort"));pages++;return Response.json({total:500,itemSummaries:[{itemId:"v1|123|0",title:"Venusaur card",itemWebUrl:"https://www.ebay.com/itm/123",buyingOptions:["FIXED_PRICE"],price:{value:"10",currency:"USD"}}]});});
    await searchListings(query,{maxResults:200});await searchListings(query,{maxResults:200,sort:"newlyListed"});await searchListings(query,{maxResults:200,sort:"newlyListed"});assert.equal(pages,2);assert.deepEqual(sorts,[null,"newlyListed"]);
    clock=start+65_000;await searchListings(query,{maxResults:200,sort:"newlyListed"});await searchListings(query,{maxResults:200});assert.equal(pages,3);
});

test("cancellation keeps emitted IDs and releases the discovery lock", async () => {
    let remembered: readonly string[] = [];
    let attempts = 0;
    const history = { seen: async () => [...remembered], remember: async (_query: string, _min: number, ids: readonly string[]) => { remembered = ids; } };
    const discover = createNewListingDiscovery({ history, usage: async () => null, find: async (_query, options) => {
        attempts++;
        if (attempts === 1) { options?.onListing?.({ id: "emitted-before-stop" } as never); throw new DOMException("Stopped", "AbortError"); }
        assert.ok(options?.newOnly?.excludeIds.includes("emitted-before-stop"));
        return [];
    } });
    await assert.rejects(discover("query", {}), /Stopped/);
    assert.deepEqual(remembered, ["emitted-before-stop"]);
    await discover("query", {});
    assert.equal(attempts, 2);
});

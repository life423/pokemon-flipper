import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ROOT } from "../../server/lib/paths.ts";

test("HTTP middleware carries a search's25-call cap despite an expired obsolete global ledger", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-http-search-cap-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const source = `
        import assert from 'node:assert/strict';
        import http from 'node:http';
        import fs from 'node:fs/promises';
        import path from 'node:path';
        const oldFile=path.join(process.env.POKEMON_FLIPPER_DATA_DIR,'ebay-development-budget.json');
        const oldLedger={version:1,limit:25,used:23,requireRenewal:true,expiresAt:'2020-01-01T00:00:00.000Z'};
        await fs.writeFile(oldFile,JSON.stringify(oldLedger));
        let browse=0,oauth=0,analytics=0;
        globalThis.fetch=async(input)=>{
            const url=new URL(String(input));
            assert.equal(url.hostname,'api.ebay.com','all provider traffic must stay in the mock');
            if(url.pathname.includes('oauth2/token')){oauth++;return Response.json({access_token:'offline',expires_in:3600});}
            if(url.pathname.includes('rate_limit')){analytics++;return Response.json({rateLimits:[{apiName:'Browse',resources:[{name:'buy.browse',rates:[{count:0,limit:5000,remaining:5000,reset:new Date(Date.now()+3600000).toISOString()}]}]}]});}
            assert.ok(url.pathname.startsWith('/buy/browse/'));browse++;
            const itemId=decodeURIComponent(url.pathname.split('/').at(-1));
            return Response.json({itemId,title:'Charizard Base Set Holo 4/102',itemWebUrl:'https://www.ebay.com/itm/123456780001',
                buyingOptions:['FIXED_PRICE'],price:{value:'100',currency:'USD'},shippingOptions:[{shippingCost:{value:'0',currency:'USD'}}],
                image:{imageUrl:'https://i.ebayimg.com/images/g/offline-http/s-l1600.jpg'}});
        };
        let server,readyResolve;const ready=new Promise(resolve=>readyResolve=resolve);
        const createServer=http.createServer;
        http.createServer=function(...args){server=createServer.apply(this,args);server.once('listening',readyResolve);return server;};
        await import('./server/app.ts');await ready;
        const port=server.address().port;
        const request=(method,url,searchId,body)=>new Promise((resolve,reject)=>{
            const payload=body===undefined?undefined:JSON.stringify(body);
            const req=http.request({hostname:'127.0.0.1',port,path:url,method,headers:{'X-Pokemon-Flipper':'1',
                ...(searchId?{'X-Pokemon-Flipper-Search-Id':searchId}:{}),
                ...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{})}},res=>{
                let data='';res.setEncoding('utf8');res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));
            });req.on('error',reject);req.end(payload);
        });
        try{
            const noId=await request('POST','/api/listings/resolve',undefined,{input:'123456780001'});
            assert.equal(noId.status,503);assert.match(noId.body.error,/valid search ID/);
            assert.equal(noId.body.retryable,false);assert.equal(oauth,0);assert.equal(browse,0);
            for(let n=0;n<25;n++){
                const result=await request('POST','/api/listings/resolve','http-search-one',{input:String(123456780001+n)});
                assert.equal(result.status,200,JSON.stringify(result.body));
            }
            const blocked=await request('POST','/api/listings/resolve','http-search-one',{input:'123456780099'});
            assert.equal(blocked.status,503);assert.match(blocked.body.error,/25-request.*cap/);
            assert.equal(blocked.body.retryable,false);assert.equal(blocked.body.code,'EBAY_BUDGET');assert.equal(browse,25);
            const first=await request('GET','/api/ebay-usage','http-search-one');
            assert.deepEqual(first.body.searchBudget,{searchId:'http-search-one',limit:25,used:25,remaining:0});
            const next=await request('POST','/api/listings/resolve','http-search-two',{input:'123456780100'});
            assert.equal(next.status,200);assert.equal(browse,26);
            const second=await request('GET','/api/ebay-usage','http-search-two');
            assert.deepEqual(second.body.searchBudget,{searchId:'http-search-two',limit:25,used:1,remaining:24});
            assert.equal(second.body.limit,5000);assert.equal(second.body.used,26);
            assert.deepEqual(JSON.parse(await fs.readFile(oldFile,'utf8')),oldLedger);
            assert.deepEqual({browse,oauth,analytics},{browse:26,oauth:1,analytics:1});
            console.log('HTTP_CAP_RESULT '+JSON.stringify({browse,oauth,analytics}));
        }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    `;
    const output = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
        cwd: ROOT, timeout: 20_000, env: { ...process.env, NODE_ENV: "production", PORT: "0", POKEMON_FLIPPER_DATA_DIR: directory,
            POKEMON_FLIPPER_STORAGE: "file", EBAY_CLIENT_ID: `offline-http-search-${path.basename(directory)}`, EBAY_CLIENT_SECRET: "offline-test-secret",
            OPENAI_API_KEY: "offline-do-not-send", PKMNPRICES_API_KEY: "offline-do-not-send" },
    });
    const marker = output.stdout.split("\n").find(line => line.startsWith("HTTP_CAP_RESULT "));
    assert.ok(marker, output.stdout);
    assert.deepEqual(JSON.parse(marker.slice("HTTP_CAP_RESULT ".length)), { browse: 26, oauth: 1, analytics: 1 });
});

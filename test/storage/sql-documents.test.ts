import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { buyerVault } from '../../server/ebay/buyer-vault.ts';
import { createDailyBrowseBudget } from '../../server/ebay/daily-budget.ts';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../../server/lib/paths.ts';
import { getSqlExecutor, closeDatabase } from '../../server/storage/client.ts';
import { digest, ensureDocumentSchema, writeDocument, readDocument, deleteDocument, withDocumentLock, documentPath } from '../../server/storage/documents.ts';
import { createShippingDestination, withShippingDestination, shippingDestination, configuredShippingZip } from '../../server/ebay/shipping-destination.ts';
import { createSniperScheduler } from '../../server/sniper/scheduler.ts';
import { jsonStore } from '../../server/lib/json-store.ts';
import { createSearchBrowseBudget } from '../../server/ebay/search-budget.ts';
import { createPriceResearchBudget } from '../../server/pricing/research-budget.ts';

// Opt-in integration test. A unique owner namespace cannot read or mutate user ledgers.
test('SQL documents deduplicate, serialize accounting, roll back, and preserve shipping snapshots', { skip: process.env.POKEMON_FLIPPER_SQL_TEST !== '1' }, async () => {
    const owner = 'storage-test-' + randomUUID();
    const previous = process.env.AZURE_SQL_OWNER_ID;
    process.env.AZURE_SQL_OWNER_ID = owner;
    process.env.POKEMON_FLIPPER_STORAGE = 'azure-sql';
    const file = path.join(DATA_DIR, 'sql-test.json'), second = path.join(DATA_DIR, 'sql-test-copy.json');
    const sharedName = "ebay-daily-budget/" + digest(owner) + ".json";
    const sharedFile = path.join(DATA_DIR, sharedName);
    const body = Buffer.from(JSON.stringify({ test: owner, count: 0 }));
    const db = await getSqlExecutor();
    const keyDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-sql-vault-test-"));
    try {
        await ensureDocumentSchema();
        assert.equal(documentPath(path.resolve(DATA_DIR, '..', 'outside.json')), null);
        await writeDocument(file, body); await writeDocument(file, body); await writeDocument(second, body);
        assert.deepEqual(await readDocument(file), body);
        const [counts] = await db.query(`SELECT (SELECT COUNT(*) FROM dbo.AppBlobs WHERE content_hash=CONVERT(char(64),@hash)) AS blobs,(SELECT COUNT(*) FROM dbo.AppDocuments WHERE owner_id=@owner) AS docs`, { hash: digest(body), owner });
        assert.deepEqual(counts, { blobs: 1, docs: 2 });
        await assert.rejects(withDocumentLock(file, async () => { await writeDocument(file, Buffer.from('rolled back')); throw Error('rollback'); }), /rollback/);
        assert.deepEqual(await readDocument(file), body);
        const store = jsonStore(file, () => ({ test: owner, count: 0 }), value => value?.test === owner && Number.isInteger(value.count));
        await Promise.all(Array.from({ length: 12 }, () => {
            const independent = jsonStore(file, () => ({ test: owner, count: 0 }), value => value?.test === owner && Number.isInteger(value.count));
            return withDocumentLock(file, () => independent.change(value => value.count++));
        }));
        assert.equal((await store.read()).count, 12);
        const aborted = new AbortController(); aborted.abort();
        await assert.rejects(withDocumentLock(file, async () => assert.fail('Aborted mutation ran'), aborted.signal));
        const browse = createSearchBrowseBudget({ directory: path.join(DATA_DIR, 'sql-browse-test') });
        let reservations = 0;
        await Promise.all(Array.from({ length: 8 }, () => browse.reserve('sql-fixture', async () => { reservations++; })));
        assert.equal((await browse.status('sql-fixture')).used, 8); assert.equal(reservations, 8);
        const quota = createDailyBrowseBudget({ file: path.join(DATA_DIR, 'sql-daily-test.json') });
        const otherQuota = createDailyBrowseBudget({ file: path.join(DATA_DIR, 'sql-daily-test.json') });
        const snapshot = { limit: 7, remaining: 7, used: 0, resetsAt: new Date(Date.now()+3600000).toISOString(), braking: false };
        const attempts = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => (i % 2 ? quota : otherQuota)(snapshot)));
        assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 6);
        assert.ok(attempts.filter(r => r.status === 'rejected').every(r => r.reason.code === 'EBAY_DAILY_BUDGET'));
        assert.equal((await quota(snapshot, { consume: false })).used, 6);
        await writeDocument(sharedFile, body);
        process.env.AZURE_SQL_OWNER_ID = owner + '-replica';
        assert.deepEqual(await readDocument(sharedFile), body);
        process.env.AZURE_SQL_OWNER_ID = owner;
        const vaultFile = path.join(DATA_DIR, 'sql-vault-test', 'sandbox.enc');
        const vault = buyerVault(path.dirname(vaultFile), path.join(keyDirectory, 'key'));
        const buyer = { id: owner, grant: { client: 'offline', scope: 'sandbox', refresh: 'offline-test-token', expiresAt: Date.now()+60000 } };
        await vault.update('sandbox', () => buyer);
        assert.deepEqual(await vault.read('sandbox'), buyer);
        assert.equal((await readDocument(vaultFile)).includes(Buffer.from('offline-test-token')), false);
        const pricing = createPriceResearchBudget({ directory: path.join(DATA_DIR, 'sql-price-test') });
        const searchId = randomUUID();
        const reserved = await pricing.reserve('/cards/1', { searchId });
        await reserved.unresolved();
        const summary = await pricing.summary(searchId);
        assert.equal(summary.used, 1); assert.equal(summary.unresolved, 1);
        let clock = Date.now(), submitted = 0;
        const end = clock + 300000;
        const quote = () => ({ itemId: 'v1|123456789012|0', url: 'https://www.sandbox.ebay.com/itm/123456789012', title: 'Offline SQL test auction',
            checkedAt: new Date(clock).toISOString(), endTime: new Date(end).toISOString(), currentBid: 10, minimumBid: 11, shipping: 0, highBidder: false, buyerConnectionId: owner });
        const services = { file: path.join(DATA_DIR, 'sql-sniper-test.json'), now: () => clock, sandboxBuyerId: async () => owner,
            readQuote: async () => quote(), submitSandbox: async () => { submitted++; return 'offline-receipt'; } };
        const sniper = createSniperScheduler(services), restarted = createSniperScheduler(services);
        const plan = { quote: quote(), maxBid: 12, leadSeconds: 60, mode: 'sandbox' as const };
        const job = await sniper.arm(plan);
        assert.equal((await restarted.arm(plan)).id, job.id);
        clock = end - 60000;
        await Promise.all([sniper.tick(), restarted.tick()]);
        assert.equal(submitted, 1, 'SQL queue claims must prevent duplicate sandbox submissions');
        assert.equal((await restarted.list())[0].status, 'SUBMITTED');
        const settings = createShippingDestination();
        await settings.save('60601');
        await withShippingDestination(async () => {
            assert.equal(configuredShippingZip(), '60601');
            await shippingDestination.save('90210');
            assert.equal(configuredShippingZip(), '60601');
        });
        assert.equal((await settings.read()).zip, '90210');
        await deleteDocument(second);
        await assert.rejects(readDocument(second), { code: 'ENOENT' });
        const [record] = await db.query('SELECT content_hash AS hash FROM dbo.AppDocuments WHERE owner_id=@owner AND document_path=@name', { owner, name: 'sql-test.json' });
        await db.query('UPDATE dbo.AppBlobs SET body=0x00 WHERE content_hash=CONVERT(char(64),@hash)', { hash: record.hash });
        await assert.rejects(readDocument(file), /integrity/);
    } finally {
        // Only garbage created under this test owner is eligible for cleanup.
        await db.transaction(async tx => {
            await tx.query(`DECLARE @hashes TABLE(hash char(64) PRIMARY KEY);
INSERT @hashes SELECT DISTINCT content_hash FROM dbo.AppDocuments WHERE owner_id=@owner OR (owner_id='provider-accounts' AND document_path=@sharedName);
DELETE dbo.AppDocuments WHERE owner_id=@owner OR (owner_id='provider-accounts' AND document_path=@sharedName);
DELETE b FROM dbo.AppBlobs b JOIN @hashes h ON b.content_hash=h.hash WHERE NOT EXISTS(SELECT 1 FROM dbo.AppDocuments d WHERE d.content_hash=b.content_hash);`, { owner, sharedName });
        });
        if (previous === undefined) delete process.env.AZURE_SQL_OWNER_ID; else process.env.AZURE_SQL_OWNER_ID = previous;
        await fs.rm(keyDirectory, { recursive: true, force: true });
        await closeDatabase();
    }
});

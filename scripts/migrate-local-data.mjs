import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../server/lib/paths.ts';
import { digest, ensureDocumentSchema, readDocument, writeDocument, assertDocumentsReady } from '../server/storage/documents.ts';
import { localOwner, storageBackend } from '../server/storage/config.ts';
import { getSqlExecutor, closeDatabase } from '../server/storage/client.ts';
import { withFileLease } from '../server/lib/file-lease.ts';
import { createSqlRepositories } from '../server/storage/repositories.ts';

// Stop all writers first. This command never invokes collectors or paid APIs.
// Byte-identical files share one blob; differing historical versions remain recoverable.
const prune = process.argv.includes('--prune');
const owner = localOwner(), root = path.resolve(DATA_DIR);
const files = [], bodies = new Map();
const statIfPresent = file => fs.stat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
const report = path.join(os.tmpdir(), 'pokemon-data-migration-receipt.json');
const safe = name => {
    const target = path.resolve(root, name);
    if (!target.startsWith(root + path.sep)) throw Error('Migration path escaped the data directory.');
    return target;
};
async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw Error('Resolve data-directory links before migrating.');
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile()) {
            if (/\.(lock|tmp)$/.test(entry.name)) throw Error('A pending data write or lease must be resolved before migration.');
            const body = await fs.readFile(file), hash = digest(body);
            const name = path.relative(root, file).split(path.sep).join('/');
            files.push({ id: digest(JSON.stringify([owner, name])), name, hash, bytes: body.length });
            if (!bodies.has(hash)) bodies.set(hash, { file, bytes: body.length });
        } else throw Error('Unsupported data entry.');
    }
}
async function migrateDailyQuota() {
    const key = process.env.EBAY_CLIENT_ID?.trim();
    if (!key) return 0;
    const account = digest(key);
    let imported = 0;
    for (const extension of ['.json', '.pace']) {
        const source = path.join(os.tmpdir(), 'pokemon-flipper-ebay-quota', account + extension);
        const target = path.join(root, 'ebay-daily-budget', account + extension);
        if (!await statIfPresent(source)) continue;
        await withFileLease(source, async () => {
            const body = await fs.readFile(source);
            const saved = await readDocument(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
            if (saved && !saved.equals(body)) throw Error('The daily SQL quota differs from the local quota; neither was replaced.');
            await writeDocument(target, body);
            if (!(await readDocument(target)).equals(body)) throw Error('Daily quota verification failed.');
            if (prune) await fs.unlink(source);
            imported++;
        }, { timeoutError: () => Error('The daily quota is still in use.') });
    }
    return imported;
}
const chunks = function* (rows, size) { for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size); };
try {
    if (storageBackend() !== 'azure-sql') throw Error('Select the configured Azure SQL database before migrating.');
    if (process.argv.includes('--daily-quota-only')) {
        await ensureDocumentSchema();
        console.log(JSON.stringify({ dailyQuota: await migrateDailyQuota() }));
    } else if (!await statIfPresent(root)) {
        await assertDocumentsReady();
        console.log(JSON.stringify({ alreadyMigrated: true, localFiles: 0 }));
    } else {
    // Consolidate SQLite WAL into the main database while there are no writers.
    for (const name of ['flip-runs.sqlite', 'market-data.sqlite']) {
        const file = safe(name);
        if (await statIfPresent(file)) {
            const sqlite = new DatabaseSync(file);
            try {
                const result = sqlite.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
                if (result.busy) throw Error('SQLite is still in use; stop its writer before migration.');
                const check = sqlite.prepare('PRAGMA quick_check').get();
                if (Object.values(check)[0] !== 'ok') throw Error('SQLite integrity check failed.');
            } finally { sqlite.close(); }
        }
    }
    await walk(root);
    if (!files.length) throw Error("No local files to migrate; the existing migration marker was kept.");
    console.log(JSON.stringify({ files: files.length, uniqueBodies: bodies.size, bytes: files.reduce((n,f)=>n+f.bytes,0), uniqueBytes: [...bodies.values()].reduce((n,b)=>n+b.bytes,0) }));
    await ensureDocumentSchema();
    const db = await getSqlExecutor(), repo = createSqlRepositories(db);
    // Existing cache identities win on equal/newer timestamps. Older observations
    // are preserved in the archive, rather than overwriting current provider data.
    const cacheEntries = [];
    for (const file of files.filter(f => /^price-cache\/[^/]+\.json$/.test(f.name))) {
        const entry = JSON.parse(await fs.readFile(safe(file.name), 'utf8'));
        if (typeof entry.key === 'string' && typeof entry.savedAt === 'string' && Object.hasOwn(entry, 'data')) cacheEntries.push(entry);
    }
    for (const batch of chunks(cacheEntries, 400)) await repo.importCacheEntries(batch);
    const marketFile = safe('market-data.sqlite');
    if (await statIfPresent(marketFile)) {
        const sqlite = new DatabaseSync(marketFile, { readOnly: true });
        try {
            for (const row of sqlite.prepare('SELECT key,fetched,body FROM responses').all()) {
                await repo.importCacheEntries([{ key: row.key, savedAt: new Date(row.fetched).toISOString(), data: JSON.parse(row.body) }]);
            }
        } finally { sqlite.close(); }
    }
    let done = 0;
    // Bound upload payloads as well as row counts, including large SQLite archives.
    let batch = [], bytes = 0;
    async function upload() {
        if (!batch.length) return;
        const hashes = JSON.stringify(batch.map(([hash]) => hash));
        const present = new Map((await db.query(`SELECT b.content_hash AS hash,LOWER(CONVERT(varchar(64),HASHBYTES('SHA2_256',b.body),2)) AS actual FROM dbo.AppBlobs b JOIN OPENJSON(@hashes) h ON b.content_hash=CONVERT(char(64),h.value)`, { hashes })).map(r=>[r.hash,r.actual]));
        const rows = [];
        for (const [hash, value] of batch) {
            if (present.has(hash)) { if (present.get(hash)!==hash) throw Error('Existing blob failed verification.'); continue; }
            const body = await fs.readFile(value.file);
            if (digest(body)!==hash) throw Error('Local data changed during migration.');
            rows.push({ hash, hex: body.toString('hex') });
        }
        if (rows.length) await db.transaction(tx=>tx.query(`INSERT dbo.AppBlobs(content_hash,body)
SELECT s.hash,CONVERT(varbinary(max),s.hex,2) FROM OPENJSON(@rows) WITH(hash char(64),hex varchar(max)) s
WHERE NOT EXISTS(SELECT 1 FROM dbo.AppBlobs b WITH(UPDLOCK,HOLDLOCK) WHERE b.content_hash=s.hash);`, { rows: JSON.stringify(rows) }));
        const verified = await db.query(`SELECT b.content_hash AS hash,LOWER(CONVERT(varchar(64),HASHBYTES('SHA2_256',b.body),2)) AS actual FROM dbo.AppBlobs b JOIN OPENJSON(@hashes) h ON b.content_hash=CONVERT(char(64),h.value)`, { hashes });
        if (verified.length!==batch.length || verified.some(r=>r.hash!==r.actual)) throw Error('Uploaded data failed verification.');
        done += batch.length;
        if (done % 1000 < batch.length || done === bodies.size) console.log(JSON.stringify({ verifiedBodies: done, total: bodies.size }));
        batch = []; bytes = 0;
    }
    for (const entry of bodies) {
        if (batch.length >= 250 || bytes + entry[1].bytes > 2_000_000) await upload();
        batch.push(entry); bytes += entry[1].bytes;
    }
    await upload();
    for (const batch of chunks(files, 400)) {
        const rows = JSON.stringify(batch);
        await db.transaction(async tx => {
            // Re-running an interrupted migration is idempotent. Never replace a
            // document changed by the application since the prior import.
            await tx.query(`IF EXISTS(SELECT 1 FROM dbo.AppDocuments d JOIN OPENJSON(@rows) WITH(id char(64),name nvarchar(2048),hash char(64)) s ON s.id=d.document_id WHERE d.owner_id<>@owner OR d.document_path<>s.name OR d.content_hash<>s.hash) THROW 51003,'Existing document differs; stop all writers.',1;
INSERT dbo.AppDocuments(document_id,owner_id,document_path,content_hash)
SELECT s.id,@owner,s.name,s.hash FROM OPENJSON(@rows) WITH(id char(64),name nvarchar(2048),hash char(64)) s
WHERE NOT EXISTS(SELECT 1 FROM dbo.AppDocuments d WITH(UPDLOCK,HOLDLOCK) WHERE d.document_id=s.id);`, { rows, owner });
        });
        const checked = await db.query(`SELECT d.document_id AS id,d.document_path AS name,d.content_hash AS hash FROM dbo.AppDocuments d JOIN OPENJSON(@rows) WITH(id char(64)) s ON d.document_id=s.id WHERE d.owner_id=@owner`, { rows, owner });
        const expected = new Map(batch.map(f=>[f.id,f]));
        if (checked.length!==batch.length || checked.some(r=>r.name!==expected.get(r.id)?.name || r.hash!==expected.get(r.id)?.hash)) throw Error('Document mapping verification failed.');
    }
    const dailyQuota = await migrateDailyQuota();
    // Verify every local file again immediately before allowing deletion.
    for (const file of files) if (digest(await fs.readFile(safe(file.name))) !== file.hash) throw Error('Local data changed before cleanup.');
    await db.query(`UPDATE dbo.AppDataImports SET completed_at=SYSUTCDATETIME(),file_count=@count WHERE owner_id=@owner;
IF @@ROWCOUNT=0 INSERT dbo.AppDataImports(owner_id,completed_at,file_count) VALUES(@owner,SYSUTCDATETIME(),@count);`, { owner, count: files.length });
    await fs.writeFile(report, JSON.stringify({ at: new Date().toISOString(), owner, root, verified: files.length, uniqueBodies: bodies.size, files }));
    let removed = 0;
    if (prune) {
        for (const file of files) {
            const target = safe(file.name);
            if (digest(await fs.readFile(target)) !== file.hash) throw Error('Local data changed during deletion; remaining files retained.');
            await fs.unlink(target); removed++;
        }
        async function empty(directory) {
            for (const item of await fs.readdir(directory, { withFileTypes: true })) if (item.isDirectory() && !item.isSymbolicLink()) await empty(path.join(directory,item.name));
            try { await fs.rmdir(directory); } catch (e) { if (e.code!=='ENOTEMPTY') throw e; }
        }
        await empty(root);
    }
    console.log(JSON.stringify({ migrated: files.length, uniqueBodies: bodies.size, removed, dailyQuota, receipt: report }));
    }
} finally { await closeDatabase(); }

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import path from "node:path";
import { DATA_DIR } from "../lib/paths.ts";
import { getSqlExecutor, type SqlExecutor } from "./client.ts";
import { localOwner, storageBackend, StorageUnavailableError } from "./config.ts";

export const digest = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");
const transaction = new AsyncLocalStorage<SqlExecutor>();
export function documentPath(file: string): string | null {
    const relative = path.relative(DATA_DIR, path.resolve(file));
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return null;
    return relative.split(path.sep).join("/");
}
export const sqlDocument = (file: string) => storageBackend() === "azure-sql" && documentPath(file) !== null;
const identity = (file: string) => {
    const name = documentPath(file);
    if (!name) throw new StorageUnavailableError("The data document is outside the configured directory.");
    // Daily provider quota is shared by account across installations/owners.
    const owner = name.startsWith("ebay-daily-budget/") ? "provider-accounts" : localOwner();
    return { name, owner, id: digest(JSON.stringify([owner, name])) };
};
const executor = () => transaction.getStore() ?? getSqlExecutor();
export async function withDocumentLock<T>(file: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const { id } = identity(file);
    let operationError: unknown;
    const locked = async (tx: SqlExecutor) => {
        signal?.throwIfAborted();
        await tx.query(`DECLARE @result int; EXEC @result=sys.sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=10000;
IF @result<0 THROW 51002,'Data document is busy.',1;`, { resource: "pokemon-document:" + id });
        signal?.throwIfAborted();
        try { return await transaction.run(tx, run); }
        catch (error) { operationError = error; throw error; }
    };
    const current = transaction.getStore();
    try { return await (current ? locked(current) : (await getSqlExecutor()).transaction(locked)); }
    catch (error) {
        if (operationError && error instanceof Error && error.cause === operationError) throw operationError;
        throw error;
    }
}
export async function readDocument(file: string): Promise<Buffer> {
    const { id, name, owner } = identity(file);
    const [row] = await (await executor()).query<{ name: string; owner: string; hash: string; body: Buffer }>(
        `SELECT d.document_path AS name,d.owner_id AS owner,d.content_hash AS hash,b.body FROM dbo.AppDocuments d JOIN dbo.AppBlobs b ON b.content_hash=d.content_hash WHERE d.document_id=CONVERT(char(64),@id)`, { id });
    if (!row) throw Object.assign(new Error("Data document not found."), { code: "ENOENT" });
    if (row.name !== name || row.owner !== owner || digest(row.body) !== row.hash) throw new StorageUnavailableError("Saved document integrity check failed.");
    return row.body;
}
export async function writeDocument(file: string, body: Buffer): Promise<void> {
    const { id, name, owner } = identity(file), hash = digest(body);
    await withDocumentLock(file, async () => {
        const tx = await executor();
        await tx.query(`IF NOT EXISTS(SELECT 1 FROM dbo.AppBlobs WITH(UPDLOCK,HOLDLOCK) WHERE content_hash=CONVERT(char(64),@hash))
INSERT dbo.AppBlobs(content_hash,body) VALUES(@hash,CONVERT(varbinary(max),@hex,2));
IF EXISTS(SELECT 1 FROM dbo.AppBlobs WHERE content_hash=CONVERT(char(64),@hash) AND HASHBYTES('SHA2_256',body)<>CONVERT(varbinary(32),@hash,2)) THROW 51004,'Stored document content failed verification.',1;
IF EXISTS(SELECT 1 FROM dbo.AppDocuments WHERE document_id=CONVERT(char(64),@id) AND (owner_id<>@owner OR document_path<>@name)) THROW 51003,'Document identity conflict.',1;
UPDATE dbo.AppDocuments SET content_hash=CONVERT(char(64),@hash),updated_at=SYSUTCDATETIME() WHERE document_id=CONVERT(char(64),@id);
IF @@ROWCOUNT=0 INSERT dbo.AppDocuments(document_id,owner_id,document_path,content_hash) VALUES(@id,@owner,@name,@hash);`, { id, name, owner, hash, hex: body.toString("hex") });
    });
}
export async function deleteDocument(file: string): Promise<void> {
    const { id } = identity(file);
    await withDocumentLock(file, async () => { await (await executor()).query("DELETE dbo.AppDocuments WHERE document_id=CONVERT(char(64),@id)", { id }); });
}
export async function ensureDocumentSchema(): Promise<void> {
    const db = await getSqlExecutor();
    await db.transaction(async tx => {
        await tx.query(`DECLARE @r int; EXEC @r=sys.sp_getapplock @Resource='pokemon-document-schema',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=10000;
IF @r<0 THROW 51002,'Schema is busy.',1;
IF OBJECT_ID('dbo.AppBlobs','U') IS NULL CREATE TABLE dbo.AppBlobs(content_hash char(64) NOT NULL PRIMARY KEY,body varbinary(max) NOT NULL);
IF OBJECT_ID('dbo.AppDocuments','U') IS NULL CREATE TABLE dbo.AppDocuments(document_id char(64) NOT NULL PRIMARY KEY,owner_id nvarchar(128) NOT NULL,document_path nvarchar(2048) NOT NULL,content_hash char(64) NOT NULL REFERENCES dbo.AppBlobs(content_hash),updated_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME());
IF OBJECT_ID('dbo.AppDataImports','U') IS NULL CREATE TABLE dbo.AppDataImports(owner_id nvarchar(128) NOT NULL PRIMARY KEY,completed_at datetime2(3) NOT NULL,file_count int NOT NULL);`);
    });
}
export async function assertDocumentsReady(): Promise<void> {
    const db = await getSqlExecutor();
    const [ready] = await db.query<{ ready: number }>("SELECT COUNT(*) AS ready FROM dbo.AppDataImports WHERE owner_id=@owner", { owner: localOwner() });
    if (!ready?.ready) throw new StorageUnavailableError("Migrate the local data before starting SQL document storage.");
}

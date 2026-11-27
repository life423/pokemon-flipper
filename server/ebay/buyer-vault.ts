import { readDataFile } from "../storage/data-file.ts";
import { sqlDocument, writeDocument, deleteDocument } from "../storage/documents.ts";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BuyerEnvironment } from "../../shared/ebay-connection.ts";
import { withFileLease } from "../lib/file-lease.ts";

export interface StoredBuyer {
    id: string;
    grant: { client: string; scope: string; refresh: string; expiresAt: number } | null;
}

const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

async function privateKey(file: string, create: boolean): Promise<Buffer> {
    if (create) {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        // Publish a complete key once, even if two environments connect simultaneously.
        try { await fs.access(file); }
        catch (error) {
            if (!absent(error)) throw error;
            const tmp = file + "." + randomUUID();
            try {
                await fs.writeFile(tmp, randomBytes(32), { mode: 0o600, flag: "wx" });
                await fs.link(tmp, file).catch(error => {
                    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                });
            } finally { await fs.rm(tmp, { force: true }); }
        }
    }
    const handle = await fs.open(file, "r");
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== 32 || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error("The buyer credential key needs private file permissions.");
        return await handle.readFile();
    } finally { await handle.close(); }
}

export function buyerVault(directory: string, keyFile: string) {
    const file = (env: BuyerEnvironment) => path.join(directory, env + ".enc");
    const aad = (env: BuyerEnvironment) => Buffer.from("pokemon-flipper/ebay-buyer/v1/" + env);

    async function read(env: BuyerEnvironment): Promise<StoredBuyer | null> {
        let data: Buffer;
        try { data = await readDataFile(file(env)); }
        catch (error) { if (absent(error)) return null; throw error; }
        const decipher = createDecipheriv("aes-256-gcm", await privateKey(keyFile, false), data.subarray(0, 12));
        decipher.setAAD(aad(env));
        decipher.setAuthTag(data.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8"));
    }

    async function update(env: BuyerEnvironment, change: (old: StoredBuyer | null) => StoredBuyer | null): Promise<StoredBuyer | null> {
        if (!sqlDocument(file(env))) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        return withFileLease(file(env), async () => {
            const old = await read(env);
            const next = change(old);
            if (next === old) return old;
            if (!next) { if (sqlDocument(file(env))) await deleteDocument(file(env)); else await fs.rm(file(env), { force: true }); return old; }
            const iv = randomBytes(12);
            const cipher = createCipheriv("aes-256-gcm", await privateKey(keyFile, true), iv);
            cipher.setAAD(aad(env));
            const body = Buffer.concat([cipher.update(JSON.stringify(next), "utf8"), cipher.final()]);
            if (sqlDocument(file(env))) {
                await writeDocument(file(env), Buffer.concat([iv, cipher.getAuthTag(), body]));
                return old;
            }
            const tmp = file(env) + "." + randomUUID();
            try {
                await fs.writeFile(tmp, Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600, flag: "wx" });
                await fs.rename(tmp, file(env));
            } finally { await fs.rm(tmp, { force: true }); }
            return old;
        }, { timeoutError: () => new Error("The eBay buyer connection is busy. Try again.") });
    }
    return { read, update };
}

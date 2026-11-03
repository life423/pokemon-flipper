import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// A suspended owner may still be alive: never steal an old accounting lease.
// Only local bookkeeping belongs inside this lease, never a provider request.
export async function withFileLease<T>(file: string, run: () => Promise<T>, options: {
    timeoutError: () => Error;
    signal?: AbortSignal;
}): Promise<T> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const lock = `${file}.lock`, nonce = randomUUID(), deadline = Date.now() + 10_000;
    for (;;) {
        options.signal?.throwIfAborted();
        try { await fs.writeFile(lock, nonce, { flag: "wx" }); break; }
        catch (error) {
            if (!["EEXIST", "EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
            if (Date.now() >= deadline) throw options.timeoutError();
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
    try { options.signal?.throwIfAborted(); return await run(); }
    finally { if (await fs.readFile(lock, "utf8").catch(() => "") === nonce) await fs.unlink(lock).catch(() => {}); }
}

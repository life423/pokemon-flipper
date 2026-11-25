import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Flush the directory entry after an atomic rename. Windows requires a
// write-capable handle for FlushFileBuffers; POSIX opens directories read-only.
export async function syncDirectory(directory: string): Promise<void> {
    const access = process.platform === "win32" ? constants.O_WRONLY : constants.O_RDONLY;
    const handle = await fs.open(directory, access);
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

// A Windows reader can briefly deny replacement. Retry the same complete
// file without removing the existing destination.
export async function replaceAtomic(temporary: string, file: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temporary, file); return; }
        catch (error) {
            if (attempt >= 8 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
            await new Promise(resolve => setTimeout(resolve, Math.min(250, 25 * 2 ** attempt)));
        }
    }
}

// Readers see the previous complete document or the replacement, never a
// truncated write. A failed replacement leaves the previous document intact.
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, serialized, "utf8");
        await replaceAtomic(temporary, file);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

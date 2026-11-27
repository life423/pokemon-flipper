import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { readDataFile } from "../storage/data-file.ts";
import { sqlDocument } from "../storage/documents.ts";
import path from "node:path";
import { validShippingZip } from "../../shared/shipping-zip.ts";
import { Router } from "express";
import { DATA_DIR } from "../lib/paths.ts";
import { writeJsonAtomic } from "../lib/atomic-json.ts";

const destinationContext = new AsyncLocalStorage<{ zip: string | null }>();
export { validShippingZip };


export function createShippingDestination(file = path.join(DATA_DIR, "shipping-destination.json")) {
    function parse(body: string): { zip: string | null } {
        const value = JSON.parse(body);
        if (value?.version !== 1 || !validShippingZip(value.zip)) throw new Error("Invalid shipping destination");
        return { zip: value.zip };
    }
    function missing(error: unknown): { zip: string | null } {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Your saved shipping destination could not be read. Check it in Settings before researching delivery costs.", { cause: error });
        const zip = process.env.EBAY_SHIP_TO_ZIP?.trim();
        return { zip: validShippingZip(zip) ? zip : null };
    }
    async function read(): Promise<{ zip: string | null }> {
        try { return parse(await readDataFile(file, "utf8")); }
        catch (error) { return missing(error); }
    }
    function readLocal(): { zip: string | null } {
        if (sqlDocument(file)) throw new Error("Shipping destination must be captured before SQL-backed provider work.");
        try { return parse(readFileSync(file, "utf8")); }
        catch (error) { return missing(error); }
    }
    return {
        read, readLocal,
        async save(zip: unknown) {
            if (!validShippingZip(zip)) throw new Error("Enter a US ZIP code, such as 12345 or 12345-6789.");
            await writeJsonAtomic(file, { version: 1, zip });
            return { zip };
        },
    };
}

export const shippingDestination = createShippingDestination();
export const configuredShippingZip = () => {
    const snapshot = destinationContext.getStore();
    return snapshot ? snapshot.zip : shippingDestination.readLocal().zip;
};
// Keep header, cache key and normalized quote on one destination even when
// another browser changes the installation preference during a request.
export async function withShippingDestination<T>(work: () => T): Promise<Awaited<T>> {
    const snapshot = destinationContext.getStore();
    return await destinationContext.run(snapshot ?? await shippingDestination.read(), work);
}

export function shippingDestinationRoutes(store = shippingDestination) {
    const api = Router();
    api.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
    api.get("/", async (_req, res) => {
        try { res.json(await store.read()); }
        catch { res.status(503).json({ error: "Your shipping destination could not be read. Save your ZIP code again." }); }
    });
    api.put("/", async (req, res) => {
        const zip = typeof req.body?.zip === "string" ? req.body.zip.trim() : null;
        if (!validShippingZip(zip)) { res.status(400).json({ error: "Enter a valid US ZIP code." }); return; }
        try { res.json(await store.save(zip)); }
        catch { res.status(503).json({ error: "Your shipping destination could not be saved. Try again." }); }
    });
    return api;
}

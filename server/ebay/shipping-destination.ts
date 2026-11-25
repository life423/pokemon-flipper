import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { DATA_DIR } from "../lib/paths.ts";
import { writeJsonAtomic } from "../lib/atomic-json.ts";

const destinationContext = new AsyncLocalStorage<{ zip: string | null }>();
export const validShippingZip = (value: unknown): value is string => typeof value === "string" && /^\d{5}(?:-\d{4})?$/.test(value);

export function createShippingDestination(file = path.join(DATA_DIR, "shipping-destination.json")) {
    function read(): { zip: string | null } {
        try {
            const value = JSON.parse(readFileSync(file, "utf8"));
            if (value?.version !== 1 || !validShippingZip(value.zip)) throw new Error("Invalid shipping destination");
            return { zip: value.zip };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Your saved shipping destination could not be read. Check it in Settings before researching delivery costs.", { cause: error });
            const zip = process.env.EBAY_SHIP_TO_ZIP?.trim();
            return { zip: validShippingZip(zip) ? zip : null };
        }
    }
    return {
        read,
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
    return snapshot ? snapshot.zip : shippingDestination.read().zip;
};
// Keep header, cache key and normalized quote on one destination even when
// another browser changes the installation preference during a request.
export function withShippingDestination<T>(work: () => T): T {
    const snapshot = destinationContext.getStore();
    return destinationContext.run(snapshot ?? shippingDestination.read(), work);
}

export function shippingDestinationRoutes(store = shippingDestination) {
    const api = Router();
    api.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
    api.get("/", (_req, res) => {
        try { res.json(store.read()); }
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

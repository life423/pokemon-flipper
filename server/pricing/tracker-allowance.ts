import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DATA_DIR } from "../lib/paths.ts";
import { getSqlRepositories, storageBackend, StorageUnavailableError } from "../storage/index.ts";

const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
// One fixed one-card request uses at most two Tracker credits. All assessments,
// retries and refreshes in the original search share these two request slots.
const requestSlots = 2;

async function firstReservation(key: string, reservation: { product: number; maxCredits: 2; at: string }): Promise<boolean> {
    try {
        if (storageBackend() === "azure-sql") {
            const repo = await getSqlRepositories();
            const ownerId = randomUUID();
            const claim = await repo.claimTask({ key, type: "TRACKER_PRICE_RESERVATION", inputHash: fingerprint(key), ownerId });
            if (!claim.claimed) return false;
            await repo.completeTask(key, ownerId, reservation);
            return true;
        }
        const dir = path.join(DATA_DIR, "tracker-price-reservations");
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, fingerprint(key) + ".json"), JSON.stringify(reservation), { flag: "wx" });
        return true;
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw new StorageUnavailableError("The Pokémon Price Tracker allowance could not be recorded.", { cause });
    }
}

export async function reserveTrackerLookup(account: string, searchId: string | undefined, product: number, now: Date): Promise<boolean> {
    if (!searchId || !uuid.test(searchId) || !account.trim() || !Number.isSafeInteger(product) || product <= 0) return false;
    const scope = "tracker-price:v1:" + fingerprint(account.trim());
    const search = scope + ":search:" + searchId.toLowerCase();
    const reservation = { product, maxCredits: 2 as const, at: now.toISOString() };
    // Persist before dispatch. An uncertain provider outcome cannot purchase
    // another copy on replay or when a second worker handles the same product.
    if (!await firstReservation(search + ":product:" + product, reservation)) return false;
    for (let slot = 0; slot < requestSlots; slot++) {
        if (await firstReservation(search + ":slot:" + slot, reservation))
            return firstReservation(scope + ":product:" + product + ":day:" + reservation.at.slice(0, 10), reservation);
    }
    return false;
}

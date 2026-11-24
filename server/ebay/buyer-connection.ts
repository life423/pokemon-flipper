import { createHash, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { BuyerConnectionStatus, BuyerEnvironment } from "../../shared/ebay-connection.ts";
import { DATA_DIR } from "../lib/paths.ts";
import { requireLiveProvider } from "../lib/saved-provider-evidence.ts";
import { createSingleFlight } from "../lib/single-flight.ts";
import { buyerVault, type StoredBuyer } from "./buyer-vault.ts";

// Live account linking is read-only. Auction authority is requested only from a Sandbox test buyer.
const scopes = {
    production: "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
    sandbox: "https://api.ebay.com/oauth/api_scope/buy.offer.auction",
};
const restart = () => new Error("This eBay sign-in has expired or changed. Start again in the same browser.");
const reconnect = () => new Error("The original eBay buyer is no longer connected. Reconnect and create a new plan.");
const invalidResponse = () => new Error("eBay returned an incomplete buyer authorization.");
const networkError = () => new Error("eBay account authorization is unavailable. Please try again.");

function configuration(env: BuyerEnvironment, values: NodeJS.ProcessEnv) {
    const prefix = env === "production" ? "EBAY_" : "EBAY_SANDBOX_";
    const missing = ["CLIENT_ID", "CLIENT_SECRET", "RUNAME"].map(key => prefix + key).filter(key => !values[key]?.trim());
    const clientId = values[prefix + "CLIENT_ID"]?.trim() ?? "";
    const secret = values[prefix + "CLIENT_SECRET"]?.trim() ?? "";
    const ruName = values[prefix + "RUNAME"]?.trim() ?? "";
    const scope = scopes[env];
    const client = createHash("sha256").update(JSON.stringify([clientId, ruName, scope])).digest("hex");
    const domain = env === "production" ? "ebay.com" : "sandbox.ebay.com";
    return { missing, clientId, ruName, secret, client, domain, scope };
}

type Config = ReturnType<typeof configuration>;
type Grant = NonNullable<StoredBuyer["grant"]>;
type Pending = { env: BuyerEnvironment; state: string; browser: string; id: string; client: string; expires: number };
type CachedToken = { id: string; value: string; expires: number };
const validString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const lifetime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
class RevokedGrant extends Error {}
export class LocalDisconnectError extends Error {
    constructor() { super("Disconnected locally. To finish revoking access, remove this app in your eBay account permissions."); }
}

export function createBuyerConnection(options: {
    directory?: string; keyFile?: string; env?: NodeJS.ProcessEnv; now?: () => number; fetch?: typeof fetch;
} = {}) {
    const vault = buyerVault(options.directory ?? path.join(DATA_DIR, "ebay-buyers"),
        options.keyFile ?? path.join(os.homedir(), ".config", "pokemon-flipper", "buyer-oauth.key"));
    const time = options.now ?? Date.now;
    const pending = new Map<BuyerEnvironment, Pending>();
    const access = new Map<BuyerEnvironment, CachedToken>();
    const share = createSingleFlight();
    const config = (env: BuyerEnvironment) => configuration(env, options.env ?? process.env);
    const usable = (grant: Grant | null | undefined, cfg: Config) => !!grant && !cfg.missing.length && grant.client === cfg.client && grant.scope === cfg.scope && grant.expiresAt > time();

    async function request(cfg: Config, fields: Record<string, string>, action: "" | "/revoke" = "") {
        requireLiveProvider("EBAY");
        try {
            return await (options.fetch ?? fetch)("https://api." + cfg.domain + "/identity/v1/oauth2/token" + action, {
                method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
                headers: { Authorization: "Basic " + Buffer.from(cfg.clientId + ":" + cfg.secret).toString("base64"),
                    "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams(fields),
            });
        } catch { throw networkError(); }
    }

    async function revoke(cfg: Config, refresh: string, token?: string) {
        const credentials = [{ token: refresh, token_type_hint: "refresh_token" }];
        if (token) credentials.push({ token, token_type_hint: "access_token" });
        const results = await Promise.allSettled(credentials.map(fields => request(cfg, fields, "/revoke")));
        if (results.some(result => result.status === "rejected" || !result.value.ok)) throw new LocalDisconnectError();
    }

    async function token(cfg: Config, fields: Record<string, string>) {
        const response = await request(cfg, fields);
        const body = await response.json().catch(() => null);
        if (response.status === 400 && body?.error === "invalid_grant") throw new RevokedGrant("The eBay authorization expired or was withdrawn. Connect again.");
        if (!response.ok) throw new Error("eBay declined buyer authorization. Check the app's keyset, redirect name and requested permission.");
        if (!validString(body?.access_token) || !lifetime(body.expires_in) || !["bearer", "user access token"].includes(String(body.token_type).toLowerCase()) ||
            (body.scope !== undefined && !(typeof body.scope === "string" && body.scope.split(/\s+/).includes(cfg.scope)))) throw invalidResponse();
        return body;
    }

    function refreshedGrant(body: Record<string, unknown>, cfg: Config): Grant {
        if (!validString(body.refresh_token) || !lifetime(body.refresh_token_expires_in)) throw invalidResponse();
        return { client: cfg.client, scope: cfg.scope, refresh: body.refresh_token, expiresAt: time() + body.refresh_token_expires_in * 1000 };
    }

    async function connectionId(env: BuyerEnvironment) {
        const cfg = config(env);
        if (cfg.missing.length) return null;
        const state = await vault.read(env);
        return state && usable(state.grant, cfg) ? state.id : null;
    }
    async function status(env: BuyerEnvironment): Promise<BuyerConnectionStatus> {
        const { missing } = config(env);
        return { configured: missing.length === 0, connected: Boolean(await connectionId(env)), missing };
    }

    async function start(env: BuyerEnvironment, browserKey: string) {
        const cfg = config(env);
        if (cfg.missing.length) throw new Error("Set " + cfg.missing.join(", ") + " to connect this eBay account.");
        if (!browserKey) throw restart();
        const attempt: Pending = { env, browser: browserKey, id: randomUUID(), state: randomBytes(32).toString("base64url"), client: cfg.client, expires: time() + 10 * 60_000 };
        await vault.update(env, old => {
            if (usable(old?.grant, cfg)) throw new Error("An eBay buyer is already connected. Disconnect it before connecting another account.");
            return { id: attempt.id, grant: null };
        });
        pending.set(env, attempt);
        const params = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.ruName, response_type: "code", scope: cfg.scope, state: attempt.state });
        return "https://auth." + cfg.domain + "/oauth2/authorize?" + params;
    }

    async function complete(state: string, code: string | null, browserKey: string) {
        const attempt = [...pending.values()].find(entry => entry.state === state && entry.browser === browserKey);
        if (!attempt || !browserKey || time() >= attempt.expires) throw restart();
        pending.delete(attempt.env); // Consume before the first await, including declined consent.
        const cfg = config(attempt.env);
        if (cfg.missing.length || cfg.client !== attempt.client || (await vault.read(attempt.env))?.id !== attempt.id) throw restart();
        if (code === null) return attempt.env;
        if (!code || code.length > 16384) throw restart();
        const body = await token(cfg, { grant_type: "authorization_code", redirect_uri: cfg.ruName, code });
        const grant = refreshedGrant(body, cfg);
        try {
            await vault.update(attempt.env, current => {
                if (current?.id !== attempt.id || config(attempt.env).client !== attempt.client) throw restart();
                return { id: attempt.id, grant };
            });
        } catch (error) {
            // Consent can return after a disconnect or a disk failure. Retire the new grant too.
            await revoke(cfg, grant.refresh, body.access_token);
            throw error;
        }
        access.set(attempt.env, { id: attempt.id, value: body.access_token, expires: time() + body.expires_in * 1000 });
        return attempt.env;
    }

    async function invalidate(env: BuyerEnvironment, expectedId: string) {
        await vault.update(env, current => current?.id === expectedId ? null : current);
        if (access.get(env)?.id === expectedId) access.delete(env);
    }

    async function accessToken(env: BuyerEnvironment, expectedId: string): Promise<string> {
        return share(env + "/" + expectedId, async () => {
            const current = await vault.read(env), cfg = config(env);
            if (!current?.grant || current.id !== expectedId || !usable(current.grant, cfg)) throw reconnect();
            const cached = access.get(env);
            if (cached?.id === expectedId && cached.expires > time() + 30_000) return cached.value;
            let body;
            try { body = await token(cfg, { grant_type: "refresh_token", refresh_token: current.grant.refresh, scope: cfg.scope }); }
            catch (error) { if (error instanceof RevokedGrant) await invalidate(env, expectedId); throw error; }
            const grant = body.refresh_token === undefined ? current.grant : refreshedGrant(body, cfg);
            await vault.update(env, latest => {
                if (!latest?.grant || latest.id !== expectedId || latest.grant.refresh !== current.grant?.refresh || !usable(latest.grant, config(env))) throw reconnect();
                return body.refresh_token === undefined ? latest : { id: expectedId, grant };
            });
            access.set(env, { id: expectedId, value: body.access_token, expires: time() + body.expires_in * 1000 });
            return body.access_token;
        });
    }

    async function disconnect(env: BuyerEnvironment) {
        pending.delete(env);
        const cached = access.get(env);
        access.delete(env);
        // Erase local authority first, including any pending sign-in. Revocation can fail offline.
        const previous = await vault.update(env, () => null);
        if (!previous?.grant) return;
        const cfg = config(env);
        if (cfg.missing.length || cfg.client !== previous.grant.client) throw new LocalDisconnectError();
        await revoke(cfg, previous.grant.refresh, cached?.id === previous.id && cached.expires > time() ? cached.value : undefined);
    }
    return { status, start, complete, disconnect, connectionId, accessToken, invalidate };
}

export type BuyerConnection = ReturnType<typeof createBuyerConnection>;
export const buyerConnection = createBuyerConnection();

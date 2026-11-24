import { useCallback, useEffect, useRef, useState } from "react";
import type { BuyerAccount } from "../../../shared/ebay-connection.ts";
import { disconnectBuyerAccount, fetchBuyerAccount, startBuyerConnection } from "../api";
import styles from "./AuctionSniper.module.css";

export function EbayBuyerAccount({ returnNotice }: { returnNotice?: string }) {
    const [account, setAccount] = useState<BuyerAccount | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState(returnNotice ?? "");
    const request = useRef<AbortController | null>(null);
    const refresh = useCallback(async () => {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        try {
            const result = await fetchBuyerAccount(controller.signal);
            if (!controller.signal.aborted) { setAccount(result); setError(""); }
        } catch {
            if (!controller.signal.aborted) setError("We couldn’t check your eBay connection. Try again.");
        }
    }, []);
    useEffect(() => {
        void refresh();
        return () => request.current?.abort();
    }, [refresh]);

    async function change() {
        if (!account || busy) return;
        request.current?.abort();
        setBusy(true); setError(""); setNotice("");
        try {
            if (account.connected) {
                const result = await disconnectBuyerAccount();
                setAccount(result);
            } else {
                const { authorizationUrl } = await startBuyerConnection("production");
                const url = new URL(authorizationUrl);
                if (url.origin !== "https://auth.ebay.com" || url.pathname !== "/oauth2/authorize" || url.username || url.password) {
                    throw new Error("Invalid eBay authorization URL");
                }
                window.location.assign(url.href);
            }
        } catch {
            if (account.connected) {
                // Revocation can fail after the app has already removed the local grant.
                setAccount(null);
                await refresh();
                setError("We couldn’t confirm that eBay revoked access. You can check your app permissions on eBay.");
            } else {
                setError("We couldn’t open eBay sign-in. Try again in a moment.");
            }
        } finally { setBusy(false); }
    }

    return <section className={styles.planner} aria-label="eBay account">
        {notice && <p role="status">{notice}</p>}
        <div className={styles.account}>
            <div>
                <strong>eBay account</strong>
                {account?.connected && <span className={styles.accountStatus}>Connected</span>}
                {account && !account.connected && (account.configured
                    ? <p>Sign in securely on eBay to link your account.</p>
                    : <p>eBay sign-in is unavailable. You can still set an auction reminder below.</p>)}
            </div>
            {account && (account.connected || account.configured) && <button type="button" disabled={busy}
                className={account.connected ? styles.secondary : styles.primary} onClick={() => void change()}>
                {busy ? "Please wait…" : account.connected ? "Disconnect eBay" : "Sign in with eBay"}
            </button>}
        </div>
        {!account && !error && <p role="status">Checking your eBay connection…</p>}
        {error && <div className={styles.error}><p role="alert">{error}</p>
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => void refresh()}>Check connection</button>
        </div>}
    </section>;
}

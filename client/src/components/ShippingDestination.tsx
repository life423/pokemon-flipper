import { useEffect, useId, useRef, useState } from "react";
import { fetchShippingDestination, saveShippingDestination } from "../api";
import styles from "./ShippingDestination.module.css";

export const SHIPPING_DESTINATION_SAVED = "pokemon-flipper:shipping-destination-saved";
export const SHIPPING_DESTINATION_REVISION = "pokemon-flipper:shipping-destination-revision";

export interface ShippingDestinationProps { busy?: boolean; onSaved?: (zip: string) => void }

export function ShippingDestination({ busy = false, onSaved }: ShippingDestinationProps) {
    const id = useId();
    const [zip, setZip] = useState("");
    const [saved, setSaved] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const edited = useRef(false);
    useEffect(() => {
        const controller = new AbortController();
        const savedElsewhere = (event: Event) => {
            const value = (event as CustomEvent<{ zip: string }>).detail;
            if (!value || !/^\d{5}(?:-\d{4})?$/.test(value.zip)) return;
            controller.abort();
            edited.current = false;
            setSaved(value.zip); setZip(value.zip); setLoading(false); setError("");
        };
        window.addEventListener(SHIPPING_DESTINATION_SAVED, savedElsewhere);
        void fetchShippingDestination(controller.signal).then(value => {
            if (!controller.signal.aborted) { if (!edited.current) setZip(value.zip ?? ""); setSaved(value.zip); }
        }).catch(() => {
            if (!controller.signal.aborted) setError("Could not read your shipping destination. You can save it here.");
        }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => { controller.abort(); window.removeEventListener(SHIPPING_DESTINATION_SAVED, savedElsewhere); };
    }, []);
    async function save() {
        if (saving || loading) return;
        if (!/^\d{5}(?:-\d{4})?$/.test(zip.trim())) { setError("Enter a five-digit US ZIP code, optionally followed by four more digits."); return; }
        setSaving(true); setError(""); setNotice("");
        try {
            const value = await saveShippingDestination(zip.trim());
            window.dispatchEvent(new CustomEvent(SHIPPING_DESTINATION_SAVED, { detail: value }));
            try { localStorage.setItem(SHIPPING_DESTINATION_REVISION, crypto.randomUUID()); } catch { /* The focus check also catches changes. */ }
            setSaved(value.zip); setZip(value.zip); setNotice("Shipping destination saved. Run your search again for updated delivery quotes.");
            onSaved?.(value.zip);
        } catch { setError("Could not save your shipping destination. Try again."); }
        finally { setSaving(false); }
    }
    return <div className={styles.root}>
        <label htmlFor={id}>Ship to ZIP code</label>
        <div className={styles.row}>
            <input id={id} type="text" inputMode="numeric" autoComplete="postal-code" maxLength={10}
                value={zip} disabled={saving} placeholder="US ZIP code"
                aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`} aria-invalid={error ? true : undefined}
                onChange={event => { edited.current = true; setZip(event.target.value); setError(""); setNotice(""); }}
                onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void save(); } }} />
            <button type="button" disabled={loading || saving || zip.trim() === saved} onClick={() => void save()}>
                {saving ? "Saving…" : "Save ZIP"}
            </button>
        </div>
        <p id={`${id}-help`}>{busy ? "Saving will stop the current search. Run it again for updated delivery quotes." : saved ? "Used for eBay delivery quotes. Change it before starting a new search." : "Add your destination so calculated shipping can be included in purchase limits."}</p>
        {error && <p id={`${id}-error`} role="alert" className={styles.error}>{error}</p>}
        {notice && <p role="status">{notice}</p>}
    </div>;
}

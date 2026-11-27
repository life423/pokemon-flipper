import { useState } from "react";
import { AuctionSniper } from "./components/AuctionSniper";
import { Drawer } from "./components/Drawer";
import { ShippingDestination } from "./components/ShippingDestination";
import styles from "./App.module.css";
export function App({ ebayReturnNotice }: { ebayReturnNotice?: string }) {
    const [settingsOpen, setSettingsOpen] = useState(false);
    return <div className={styles.shell}>
        <header className={styles.header}><div className={styles.brand}>
            <img className={styles.logo} src="/pokeball.png" alt="" width={44} height={44} />
            <div><h1 className={styles.title}>Pokemon Flipper</h1><p className={styles.tagline}>Auction workspace</p></div>
        </div><button type="button" className={styles.menuButton} aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(true)}>Settings</button></header>
        <main className={styles.main}>
            <AuctionSniper returnNotice={ebayReturnNotice} />
        </main>
        <Drawer open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Settings">
            <section className={styles.drawerSection}><h3>Delivery destination</h3><ShippingDestination busy={false} onSaved={() => {}} /></section>
        </Drawer>
    </div>;
}

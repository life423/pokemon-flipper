export type BuyerEnvironment = "production" | "sandbox";

export interface BuyerAccount {
    configured: boolean;
    connected: boolean;
}

export interface BuyerConnectionStatus extends BuyerAccount {
    missing: string[];
}

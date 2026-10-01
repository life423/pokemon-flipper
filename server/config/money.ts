import type { RawCondition } from "../../shared/conditions.ts";
import type { Grader } from "../../shared/types.ts";

export interface GradingTier {
    tier: string;
    fee: number;
    percentOfValue?: number;
    // null: never used until you fill it in.
    maxDeclaredValue: number | null;
}

export interface BuyingConfig {
    salesTaxRate: number;
    assumedShippingWhenUnknown: number;
}

export interface SellingConfig {
    finalValueRate: number;
    finalValueTierLimit: number;
    finalValueRateAboveLimit: number;
    perOrderFee: number;
    perOrderFeeSmall: number;
    smallOrderLimit: number;
    typicalBuyerTaxRate: number;
    promotedRate: number;
    shipping: { raw: number; graded: number };
}

export type GradingConfig = { shippingPerCard: number } & Record<Grader, GradingTier[]>;

export interface MoneyConfig {
    verified: boolean;
    targets: { minProfit: number; minRoi: number };
    prescreen: { bestGrade: Record<RawCondition, number> };
    buying: BuyingConfig;
    selling: SellingConfig;
    grading: GradingConfig;
}

// Every number the money math uses, in one place. Fees change often,
// so check these against your own accounts and set verified to true.
// A service level with maxDeclaredValue null is never used until you
// fill it in.
export const MONEY_CONFIG: MoneyConfig = {
    verified: false,

    // What a deal has to clear: profit after every cost, and return on
    // everything you put in.
    targets: {
        minProfit: 50,
        minRoi: 0.25,
    },

    // The free first check, before any paid AI, assumes each raw card
    // at its best: the seller's own condition call, and the best grade
    // a card in that condition could reach. These are guesses to tune,
    // not data. They only decide which listings get analyzed.
    prescreen: {
        bestGrade: {
            NEAR_MINT: 9,
            LIGHTLY_PLAYED: 6,
            MODERATELY_PLAYED: 4,
            HEAVILY_PLAYED: 2,
            DAMAGED: 1,
        },
    },

    buying: {
        // Sales tax eBay charges you on a purchase (price plus shipping).
        salesTaxRate: 0.0825,
        // Used when a listing doesn't quote shipping. Setting
        // EBAY_SHIP_TO_ZIP in .env gets real quotes instead.
        assumedShippingWhenUnknown: 10,
    },

    selling: {
        // eBay final value fee for trading cards, without a Store.
        finalValueRate: 0.1325,
        finalValueTierLimit: 7500,
        finalValueRateAboveLimit: 0.0235,
        perOrderFee: 0.4,
        perOrderFeeSmall: 0.3,
        smallOrderLimit: 10,
        // eBay charges its fee on everything the buyer pays, sales tax
        // included, so a typical buyer tax rate goes into the fee.
        typicalBuyerTaxRate: 0.08,
        // Promoted Listings ad rate, if you use it (0.05 is 5%).
        promotedRate: 0,
        // What shipping a sold card costs you.
        shipping: {
            raw: 5,
            graded: 10,
        },
    },

    grading: {
        // Shipping and insurance to the grader and back, per card, when
        // sending a few at a time.
        shippingPerCard: 15,

        // Service levels you can use; bulk levels are left out because
        // you send a few cards at a time. For each grader, the money
        // math uses the cheapest level whose cap covers the card's value
        // at the top of its grade range.
        PSA: [
            { tier: "Standard", fee: 59.99, maxDeclaredValue: null },
            { tier: "Regular", fee: 79.99, maxDeclaredValue: 1499 },
            { tier: "Express", fee: 175, maxDeclaredValue: 2499 },
            { tier: "Super Express", fee: 349, maxDeclaredValue: 4999 },
            { tier: "Walk-Through", fee: 599, maxDeclaredValue: 9999 },
        ],
        CGC: [
            { tier: "Economy", fee: 20, maxDeclaredValue: 1000 },
            { tier: "Standard", fee: 55, maxDeclaredValue: 3000 },
            { tier: "Express", fee: 100, maxDeclaredValue: 10000 },
            { tier: "Unlimited Value", fee: 300, percentOfValue: 0.01, maxDeclaredValue: Infinity },
        ],
    },
};

import "dotenv/config";
import { importPriceChartingGuide } from "../server/pricing/pricecharting.ts";

const [id, url] = process.argv.slice(2);
if (!id || !url) throw new Error("Usage: npm run pricecharting:guide -- PRODUCT_ID PRODUCT_URL");
console.log(JSON.stringify(await importPriceChartingGuide({ id, url }), null, 2));

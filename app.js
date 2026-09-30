import "dotenv/config";
import express from "express";
import { getListings } from "./ebay.js";
import { evaluateListing } from "./grading.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

app.get("/api/listings", async (req, res) => {
    try {
        const search = req.query.q || "";
        const listings = await getListings(search);

        res.json(listings);
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to get listings",
        });
    }
});

// Paid unless the listing's saved answer is reused: up to two
// vision requests. ?fresh=1 ignores the saved answer.
app.post("/api/listings/:id/evaluate", async (req, res) => {
    try {
        const evaluation = await evaluateListing(req.params.id, {
            fresh: req.query.fresh === "1",
        });

        res.json(evaluation);
    } catch (error) {
        console.error(error);

        const notFound = error.status === 404;

        res.status(notFound ? 404 : 500).json({
            error: notFound
                ? "Listing not found or no longer available"
                : "Listing evaluation failed",
        });
    }
});

app.listen(PORT, (error) => {
    if (error) {
        console.error(`Couldn't start on port ${PORT}: ${error.message}`);
        process.exit(1);
    }

    console.log(`Server listening on http://localhost:${PORT}`);
});

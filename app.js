import "dotenv/config";
import express from "express";
import { getListings } from "./ebay.js";
import {
    testOpenAI,
    testImageAnalysis,
    analyzeListingPhotos,
} from "./openai.js";
import { evaluateListing } from "./grading.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.send("Pokemon Flipper is running");
});

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

app.get("/api/openai/test", async (req, res) => {
    try {
        const result = await testOpenAI();

        res.json({
            result,
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "OpenAI API test failed",
        });
    }
});

app.get("/api/openai/image-test", async (req, res) => {
    try {
        const result = await testImageAnalysis();

        res.json({
            result,
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "OpenAI image test failed",
            message: error.message,
        });
    }
});

app.get("/api/openai/listing-test", async (req, res) => {
    try {
        const analysis = await analyzeListingPhotos();

        res.json(analysis);
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Listing photo analysis failed",
            message: error.message,
        });
    }
});

app.get("/api/openai/evaluate-test", async (req, res) => {
    try {
        const evaluation = await evaluateListing();

        res.json(evaluation);
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Listing evaluation failed",
            message: error.message,
        });
    }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

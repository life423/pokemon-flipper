import "dotenv/config";
import express from "express";
import { getListings } from "./ebay.js";

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

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

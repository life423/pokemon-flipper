import "dotenv/config";
import express from "express";
import { getListings } from "./ebay.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Pokemon Flipper is running");
});

app.get("/api/listings", (req, res) => {
    const search = req.query.q || "";
    const listings = getListings(search);
  
    res.json(listings);
  });

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

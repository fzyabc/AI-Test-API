const express = require("express");
const path = require("path");
const { registerApiRoutes } = require("./routes/api");

const app = express();
const port = process.env.PORT || 3006;

app.use(express.json({ limit: "2mb" }));
app.use("/api", (_req, res, next) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "Surrogate-Control": "no-store",
  });
  next();
});
app.use(express.static(path.join(__dirname, "public")));

registerApiRoutes(app);

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    message: error.message || "Internal server error",
    stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
  });
});

app.listen(port, () => {
  console.log(`Affiliate API platform running at http://localhost:${port}`);
});

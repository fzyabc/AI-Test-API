const express = require("express");
const path = require("path");
const { isHttpError } = require("./lib/http-errors");
const { registerApiRoutes } = require("./routes/api");
const { registerQbjRoutes } = require("./routes/qbj-api");

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
registerQbjRoutes(app);

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, _req, res, _next) => {
  const status = isHttpError(error) ? Number(error.status || 500) : 500;
  const code = String(error?.code || (status >= 500 ? "INTERNAL_ERROR" : "HTTP_ERROR"));
  const message =
    status >= 500 ? "Internal server error" : error.message || "Request failed";

  if (status >= 500) {
    console.error(error);
  }

  res.status(status).json({
    ok: false,
    error: {
      code,
      message,
      details: error?.details,
    },
    stack: process.env.NODE_ENV === "development" ? error?.stack : undefined,
  });
});

app.listen(port, () => {
  console.log(`Affiliate API platform running at http://localhost:${port}`);
});

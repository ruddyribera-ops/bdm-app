import express from "express";
import cors from "cors";
import { createServer } from "http";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHmac } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const COMMIT = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || "local";

const app = express();
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 400 ? "ERROR" : "INFO";
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${level} ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// API: Auth
app.post("/api/auth", (req, res) => {
  const { password } = req.body || {};
  const expected = process.env.APP_PASSWORD || "bdm2026!"; // Default for local

  if (!password || password !== expected) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }

  const token = createHmac("sha256", process.env.APP_SECRET || "bdm-secret")
    .update(expected)
    .digest("hex");

  return res.status(200).json({ token });
});

// API: Generate
function validateToken(token) {
  if (!token) return false;
  const expected = createHmac("sha256", process.env.APP_SECRET || "bdm-secret")
    .update(process.env.APP_PASSWORD || "bdm2026!")
    .digest("hex");
  return token === expected;
}

app.post("/api/generate", async (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!validateToken(token)) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "API key no configurada" });
  }

  const { model, system_instruction, contents, generationConfig } = req.body;

  try {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_instruction, contents, generationConfig }),
      }
    );
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// API: Health check (external)
app.get("/api/health", (req, res) => {
  const hasApiKey = !!process.env.GEMINI_API_KEY;
  const hasAppPassword = !!process.env.APP_PASSWORD;
  const hasAppSecret = !!process.env.APP_SECRET;

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    services: {
      gemini: hasApiKey ? "configured" : "missing",
      auth: hasAppPassword && hasAppSecret ? "configured" : "missing"
    }
  });
});

// Health check (internal)
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), commit: COMMIT });
});

// Version endpoint (for post-deploy verification)
app.get("/api/version", (req, res) => {
  res.json({ commit: COMMIT, timestamp: new Date().toISOString() });
});

// Serve static files from dist if it exists (MUST be after all API routes, BEFORE 404 handler)
const distPath = join(__dirname, "dist");
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  // Catch-all route to serve index.html for client-side routing
  app.get("*", (req, res) => {
    res.sendFile(join(distPath, "index.html"));
  });
} else {
  // Fallback: serve a simple message if dist doesn't exist
  app.get("/", (req, res) => {
    res.send("BDM App - Run 'npm run build' first, or use 'npm run dev' for development");
  });
}

// 404 handler (only reached if static middleware didn't match, e.g. no dist folder)
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler (4 params required by Express)
app.use((err, req, res, _next) => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ERROR ${req.method} ${req.path}:`, err.message, err.stack);
  res.status(500).json({ error: "Internal server error" });
});

const server = createServer(app);
server.listen(PORT, () => {
  console.log(`BDM app running on http://localhost:${PORT}`);
});
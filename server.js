import express from "express";
import cors from "cors";
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHmac } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === "production";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from dist if it exists
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

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const server = createServer(app);
server.listen(PORT, () => {
  console.log(`BDM app running on http://localhost:${PORT}`);
});
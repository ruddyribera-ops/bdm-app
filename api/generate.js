import { createHmac } from "crypto";
import { rateLimit } from "./utils/rateLimiter.js";

// Rate limit: 10 requests per minute per IP for generate endpoint
const generateLimiter = rateLimit(10, 60 * 1000);

function validateToken(token) {
  if (!token) return false;
  const secret = process.env.APP_SECRET;
  const expectedPassword = process.env.APP_PASSWORD;
  
  if (!secret || !expectedPassword) {
    console.error("CRITICAL: APP_SECRET or APP_PASSWORD not configured");
    return false;
  }
  
  const expected = createHmac("sha256", secret)
    .update(expectedPassword)
    .digest("hex");
  return token === expected;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Apply rate limiting
  await new Promise((resolve, reject) => {
    generateLimiter(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!validateToken(token)) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("CRITICAL: GEMINI_API_KEY not configured");
    return res.status(500).json({ error: "API key no configurada en el servidor" });
  }

  // Use GEMINI_MODEL env var, fallback to gemini-2.5-flash-lite
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  const { system_instruction, contents, generationConfig } = req.body;

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
    console.error("Generate API error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
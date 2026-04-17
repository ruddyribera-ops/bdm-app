import { createHmac } from "crypto";

// Simple in-memory rate limiter
const attempts = new Map();
const RATE_LIMIT = 5;
const RATE_WINDOW = 60 * 1000; // 1 minute

function isRateLimited(ip) {
  const now = Date.now();
  const record = attempts.get(ip);

  if (!record) {
    attempts.set(ip, { count: 1, firstAttempt: now });
    return false;
  }

  // Reset if window passed
  if (now - record.firstAttempt > RATE_WINDOW) {
    attempts.set(ip, { count: 1, firstAttempt: now });
    return false;
  }

  // Check if exceeded
  if (record.count >= RATE_LIMIT) {
    return true;
  }

  record.count++;
  return false;
}

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limiting
  const ip = req.headers["x-forwarded-for"] || req.connection?.remoteAddress || "unknown";
  if (isRateLimited(ip)) {
    console.warn(`Rate limit exceeded for IP: ${ip}`);
    return res.status(429).json({ error: "Demasiados intentos. Espere 1 minuto." });
  }

  const { password } = req.body || {};

  // Validate APP_PASSWORD is configured
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    console.error("CRITICAL: APP_PASSWORD not configured in environment variables");
    return res.status(500).json({ error: "Sistema no configurado. Contacte al administrador." });
  }

  // Validate APP_SECRET is configured
  const secret = process.env.APP_SECRET;
  if (!secret) {
    console.error("CRITICAL: APP_SECRET not configured - refusing to start");
    return res.status(500).json({ error: "Sistema no configurado. Contacte al administrador." });
  }

  if (!password || password !== expected) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }

  const token = createHmac("sha256", secret)
    .update(expected)
    .digest("hex");

  return res.status(200).json({ token });
}
// API service for BDM App
// Handles communication with backend AI endpoints

import { DEFAULT_MODEL } from "../theme/index.js";

/**
 * Call the AI motor (Gemini) via backend API
 * @param {string} system - System instruction/prompt
 * @param {string|Array} content - Content to send
 * @param {number} maxTokens - Max output tokens
 * @param {number} timeoutMs - Timeout in milliseconds
 */
export async function callMotor(system, content, maxTokens = 4000, timeoutMs = 480000) {
  const token = sessionStorage.getItem("bdm_token") || localStorage.getItem("bdm_token") || "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  
  let parts;
  if (Array.isArray(content)) {
    parts = content.map(block => {
      if (block.type === "text") return { text: block.text };
      if (block.type === "image") return { inline_data: { mime_type: block.source.media_type, data: block.source.data } };
      if (block.type === "document") return { inline_data: { mime_type: block.source.media_type, data: block.source.data } };
      return { text: String(block) };
    });
  } else {
    parts = [{ text: String(content) }];
  }
  
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      });
      
      clearTimeout(timer);
      
      if (res.status === 401) {
        localStorage.removeItem("bdm_token");
        localStorage.removeItem("bdm_token_expires_at");
        sessionStorage.removeItem("bdm_token");
        window.location.reload();
        throw new Error("Sesión expirada. Ingrese nuevamente.");
      }
      
      // Retry on rate limit / high demand / server overload
      if ((res.status === 429 || res.status === 503 || res.status === 502) && attempt < MAX_RETRIES) {
        const wait = (attempt + 1) * 15000; // 15s, 30s, 45s
        console.log(`Rate limited (${res.status}), retrying in ${wait/1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e?.error?.message || e?.error || `HTTP ${res.status}`);
      }
      
      const data = await res.json();
      
      if (data.error) {
        // Also retry on "high demand" errors in response body
        if (data.error.message?.includes("high demand") && attempt < MAX_RETRIES) {
          const wait = (attempt + 1) * 15000;
          console.log(`High demand, retrying in ${wait/1000}s...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw new Error(data.error.message);
      }
      
      return data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
      
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") throw new Error("Tiempo de espera agotado (8 min).");
      if (attempt < MAX_RETRIES && (err.message?.includes("high demand") || err.message?.includes("429") || err.message?.includes("503"))) {
        const wait = (attempt + 1) * 15000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Build content for AI processing based on file type and size
 * @param {Object} processed - Processed file from fileParser
 * @param {string} instruction - Instruction for AI
 * @param {Function} logFn - Logging function
 */
export async function buildContent(processed, instruction, logFn) {
  const PDF_B64_LIMIT = 27_000_000;
  
  if (processed.type === "pdf" && processed.b64 && processed.b64.length <= PDF_B64_LIMIT) {
    return [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: processed.b64 } },
      { type: "text", text: instruction }
    ];
  }
  
  if (processed.type === "pdf" && processed.b64 && processed.b64.length > PDF_B64_LIMIT) {
    if (logFn) logFn(`  ⚠ PDF grande → procesando como texto`);
  }
  
  const text = processed.text || "";
  const CHUNK_LIMIT = 50000;
  
  if (text.length <= CHUNK_LIMIT) return `${instruction}\n\nDocumento: ${processed.name}\n\n${text}`;
  
  if (logFn) logFn(`  → Documento extenso (${Math.round(text.length/1000)}KB) — fragmentando...`);
  
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK_LIMIT) chunks.push(text.slice(i, i + CHUNK_LIMIT));
  
  const summaries = [];
  for (let i = 0; i < chunks.length; i++) {
    if (logFn) logFn(`  → Fragmento ${i+1}/${chunks.length}...`);
    if (i > 0) await new Promise(r => setTimeout(r, 5000));
    
    const s = await callMotor(
      `Eres un asistente de síntesis. Extrae y conserva TODOS los datos cuantitativos, nombres, presupuestos, indicadores y resultados. Responde en español.`,
      `Fragmento ${i+1}/${chunks.length} de "${processed.name}":\n\n${chunks[i]}`, 3000
    );
    summaries.push(s);
  }
  
  return `${instruction}\n\nDocumento: ${processed.name} (${chunks.length} fragmentos)\n\n${summaries.join("\n\n---\n\n")}`;
}

/**
 * Try to parse JSON from response, return success indicator
 */
export function tryJSON(raw) {
  try {
    return { ok: true, data: JSON.parse(raw.replace(/```json\n?|```\n?/g, "").trim()) };
  } catch (e) {
    return { ok: false, data: raw, err: e.message };
  }
}

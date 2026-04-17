import { useState, useRef, useEffect } from "react";
import mammoth from "mammoth/mammoth.browser";

const MODEL = "gemini-2.5-flash-lite";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// ═══════════════════════════════════════════════════
// PDF — extracción nativa vía pdf.js (sin límite de páginas)
// ═══════════════════════════════════════════════════
let _pdfjs = null;
async function getPdfJs() {
  if (_pdfjs) return _pdfjs;
  return new Promise(resolve => {
    if (window.pdfjsLib) { _pdfjs = window.pdfjsLib; resolve(_pdfjs); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      _pdfjs = window.pdfjsLib;
      resolve(_pdfjs);
    };
    document.head.appendChild(s);
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function ocrPdfWithVision(pdf, name, logFn) {
  const total = pdf.numPages;
  const BATCH = 6;
  let allText = "";
  for (let start = 1; start <= total; start += BATCH) {
    const end = Math.min(start + BATCH - 1, total);
    if (logFn) logFn(`  → OCR páginas ${start}–${end}/${total}...`);
    const blocks = [];
    for (let p = start; p <= end; p++) {
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 0.7 });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: canvas.toDataURL("image/jpeg", 0.8).split(",")[1] } });
    }
    blocks.push({ type: "text", text: `Transcribe todo el texto visible en estas ${end - start + 1} páginas. Incluye tablas, números, nombres y cifras. Solo el texto, sin comentarios.` });
    const chunk = await callMotor("Eres un extractor OCR. Transcribe fielmente todo el contenido visible.", blocks, 4000);
    allText += chunk + "\n\n";
    if (end < total) await new Promise(r => setTimeout(r, 15000));
  }
  return allText.trim();
}

async function readFile(file, logFn) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "pdf") {
    const arrayBuf = await file.arrayBuffer();
    const b64 = arrayBufferToBase64(arrayBuf);
    try {
      const lib = await getPdfJs();
      const pdf = await lib.getDocument({ data: arrayBuf }).promise;
      let text = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map(it => it.str).join(" ") + "\n";
      }
      const avgCharsPerPage = text.trim().length / pdf.numPages;
      if (avgCharsPerPage < 80 && logFn) {
        logFn(`  → PDF escaneado detectado — aplicando OCR visual (${pdf.numPages} pág.)...`);
        const ocrText = await ocrPdfWithVision(pdf, file.name, logFn);
        return { type: "pdf", b64, text: ocrText, name: file.name, pages: pdf.numPages, ocr: true };
      }
      return { type: "pdf", b64, text: text.trim(), name: file.name, pages: pdf.numPages };
    } catch {
      return { type: "pdf", b64, text: "", name: file.name, pages: "?" };
    }
  }
  if (ext === "docx") {
    const buf = await file.arrayBuffer();
    const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
    return { type: "docx", text: value.trim(), name: file.name };
  }
  const text = await file.text();
  return { type: "text", text: text.trim(), name: file.name };
}

// ═══════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════
async function callMotor(system, content, maxTokens = 4000, timeoutMs = 480000) {
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
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({
          model: MODEL,
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      });
      clearTimeout(timer);
      if (res.status === 401) {
        localStorage.removeItem("bdm_token"); localStorage.removeItem("bdm_token_expires_at"); sessionStorage.removeItem("bdm_token");
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
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message || e?.error || `HTTP ${res.status}`); }
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

async function buildContent(processed, instruction, logFn) {
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

function tryJSON(raw) {
  try { return { ok: true, data: JSON.parse(raw.replace(/```json\n?|```\n?/g, "").trim()) }; }
  catch (e) { return { ok: false, data: raw, err: e.message }; }
}

// ═══════════════════════════════════════════════════
// PROMPTS
// ═══════════════════════════════════════════════════
const P = {
  template: `Eres el Motor TEMPLATE del sistema de memorias anuales de Bosques del Mundo Bolivia.
Analiza los documentos de referencia y extrae su estructura, tono institucional y secciones.
Responde SOLO JSON válido:
{"secciones":[{"nombre":"string","proposito":"string","orden":0}],"tono":"string","estilo_narrativo":"string","campos_caratula":["string"],"observaciones":"string"}`,

  alpha: `Eres el Motor Alpha 2.0 del sistema de memorias anuales de Bosques del Mundo Bolivia.
Extrae TODOS los datos estructurados del informe. Lee el documento COMPLETO.
PROHIBIDO añadir datos externos. Si un campo no existe usa null — NUNCA uses 0 para ausencia.
Para cada dato cuantitativo registra la fuente (sección o página).
IMPORTANTE: Busca datos en TODAS las formas — tablas, listas, párrafos, cuadros, anexos.
Responde SOLO JSON válido:
{"nombre_proyecto":"string","periodo":"string","periodo_inicio":"string","periodo_fin":"string","socios_ejecutores":["string"],"presupuesto_total":{"monto":null,"moneda":"string","fuente":"string"},"presupuesto_ejecutado":{"monto":null,"moneda":"string","porcentaje":null,"fuente":"string"},"estado":"en_ejecucion|concluido|por_iniciar","resultados":[{"id":1,"descripcion":"string","indicadores":[{"nombre":"string","valor":"string","meta":"string","porcentaje_avance":"string","fuente":"string"}],"beneficiarios_directos":null,"beneficiarios_indirectos":null,"mujeres":null,"jovenes":null,"comunidades":["string"],"participantes_actividades":null,"fuente":"string"}],"proyecciones":[{"tipo":"continuidad|nuevo|cierre","descripcion":"string","fuente":"string"}],"nuevos_proyectos":"string","datos_faltantes":["string"],"observaciones_financieras":"string","desafios":["string"],"oportunidades":["string"]}`,

  m0a: `Eres el Motor M0a. Consolida los JSONs de todos los insumos en una síntesis unificada. PROHIBIDO añadir datos externos.
ALERTA DE MONEDAS: si hay distintas monedas NO las sumes — mantenlas separadas.
Responde SOLO JSON válido:
{"proyectos":[{"nombre":"string","estado":"string","logros_narrativos":"string","indicadores_clave":[{"indicador":"string","valor":"string","meta":"string","fuente":"string"}],"beneficiarios_directos":0,"beneficiarios_indirectos":0,"mujeres":0,"jovenes":0,"comunidades":["string"],"presupuestos":[{"monto":0,"moneda":"string","tipo":"total|ejecutado"}],"desafios":"string","oportunidades":"string"}],"procesos_internos":{"logros":"string","temas_transversales":"string"},"proyecciones":[{"proyecto":"string","tipo":"continuidad|nuevo|cierre","descripcion":"string","fuente":"string"}],"nuevos_proyectos":"string","alerta_monedas":"string","inconsistencias_detectadas":["string"],"datos_faltantes_globales":["string"]}`,

  m0b: `Eres el Motor M0b del sistema de memorias anuales de Bosques del Mundo Bolivia.
Redacta el informe completo combinando datos de AMBAS fuentes: informes de gestiones pasadas E informes de socios/ejecutores.
Presenta los datos siguiendo el formato, estructura y estilo narrativo de la PLANTILLA proporcionada.
REGLAS ABSOLUTAS:
1. PROHIBIDO añadir datos no presentes en las fuentes de entrada.
2. Para CADA cifra: inserta referencia [Fuente, sección].
3. ADECUA el lenguaje y narrativa según el tipo de informe y los lineamientos de la plantilla.
4. Resalta cantidades con **negrita**. Incluye tablas de indicadores por proyecto.
5. Si un campo es null: NO simplemente escribir "Sin datos". Explica el contexto institucional: "Información en proceso de consolidación en el marco del fortalecimiento del sistema de Monitoreo, Evaluación y Aprendizaje (MEL)"
6. NO menciones errores técnicos ni problemas de archivos.
7. El informe final debe interpretar y sintetizar TODOS los insumos (gestiones pasadas + socios) y plantearlos en el formato de la plantilla del nuevo informe.
8. Cada proyecto debe comenzar con una breve introducción que incluya: nombre del proyecto, territorio, socio ejecutor, objetivo general y una frase que contextualice los desafíos operativos del periodo.
9. Incluir una sección de "Lecciones aprendidas" con frases que vinculen causa-efecto: "la [causa] incide directamente en [consecuencia]"
10. Incluir una sección de "Proyección de gestión [año siguiente]" con prioridades institucionales basadas en los resultados alcanzados.
11. Los resultados transversales (que no pertenecen a un solo proyecto) deben tener su propia sección antes de las conclusiones generales.
12. Mantener un tono institucional formal, evitando listas de actividades que parezcan reportes operativos — escribir en párrafos narrativos que conecten actividades con resultados y contexto.
13. Incluir una sección de "Consideraciones metodológicas" que explique cómo se consolidó la información y qué proceso MEL está en curso.
14. Las conclusiones deben hacer referencia al contexto operativo completo y al modelo de acompañamiento institucional de Bosques del Mundo.
Salida: MARKDOWN completo listo para Word/PDF.`,

  m0c: `Eres el Motor M0c. Genera matriz de trazabilidad e informe de consistencia.
- Tabla: dato cuantitativo → fuente exacta
- Semáforo: 🟢 correcto | 🟡 observación | 🔴 falta/inconsistente
- Señala "ALERTA DE DATO EXTERNO" si detectas info no presente en fuentes
Salida: MARKDOWN con semáforo global y tabla de trazabilidad.`,

  m2: `Eres el Motor M2. Genera panel de control ejecutivo legible en 5 minutos.
ESTRUCTURA:
1. **INDICADOR DE CONFIANZA** — 🟢/🟡/🔴 con justificación
2. **Resumen por proyecto** — máx 3 logros por proyecto
3. **Tabla ALERTAS CRÍTICAS** — Alerta | Detalle | Acción | Urgencia
4. **Tareas pendientes** — lista numerada
5. **Estado financiero** — resumen de ejecución
Salida: MARKDOWN ejecutivo conciso.`
};

// ═══════════════════════════════════════════════════
// EXPORT HELPERS
// ═══════════════════════════════════════════════════
function toWordHtml(md, title) {
  let h = md
    .replace(/^# (.+)$/gm, '<h1 style="font-family:Arial;font-size:16pt;font-weight:bold;border-bottom:1pt solid #000;padding-bottom:4pt;margin-top:20pt;">$1</h1>')
    .replace(/^## (.+)$/gm, '<h2 style="font-family:Arial;font-size:14pt;font-weight:bold;margin-top:14pt;">$1</h2>')
    .replace(/^### (.+)$/gm, '<h3 style="font-family:Arial;font-size:12pt;font-weight:bold;margin-top:10pt;">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^---$/gm, '<hr style="border:0.5pt solid #000;margin:8pt 0;"/>')
    .replace(/^\| (.+) \|$/gm, row => {
      const cells = row.split('|').slice(1,-1).map(c=>c.trim());
      if (cells.every(c=>c.match(/^[-:]+$/))) return '';
      return '<tr>' + cells.map(c=>`<td style="border:1pt solid #000;padding:5pt 8pt;font-family:Arial;font-size:13px;">${c}</td>`).join('') + '</tr>';
    })
    .replace(/(<tr>.*?<\/tr>\n?)+/gs, m=>`<table style="border-collapse:collapse;width:100%;margin:8pt 0;">${m}</table>`)
    .replace(/^[-*] (.+)$/gm, '<li style="font-family:Arial;font-size:13px;margin-bottom:3pt;">$1</li>')
    .replace(/(<li[^>]*>.*?<\/li>\n?)+/gs, m=>`<ul style="margin:4pt 0 4pt 18pt;">${m}</ul>`)
    .replace(/^(?!<[hult]|<\/|$)(.+)$/gm, '<p style="font-family:Arial;font-size:13px;line-height:1.6;margin:4pt 0;">$1</p>');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title></head><body style="font-family:Arial;font-size:13px;margin:2.5cm 2cm;">
<div style="border-bottom:2pt solid #000;padding-bottom:10pt;margin-bottom:20pt;">
<p style="font-size:18pt;font-weight:bold;margin:0;">Bosques del Mundo Bolivia</p>
<p style="font-size:11pt;color:#333;margin:4pt 0 0;">${title}</p>
</div>${h}</body></html>`;
}
function dlWord(c, n) { if(!c) return; const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([toWordHtml(c,n)],{type:"application/msword"})); a.download=n+".doc"; a.click(); }
function dlMd(c, n) { if(!c) return; const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([c],{type:"text/plain;charset=utf-8"})); a.download=n+".md"; a.click(); }

// ═══════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════
const C = {
  bg:"#f0ebe0", white:"#faf8f2", dark:"#0c1e12", mid:"#194a2c",
  sage:"#4a7c5a", amber:"#c8a020",
  text:"#16160c", muted:"#617063", border:"#cac2ae",
  codeBg:"#0f1c13", codeText:"#a0c0a8",
  errBg:"#f8ecec", errText:"#7a2020",
  note:"#fef9e7", noteBorder:"#e8d44d",
};

function getStoredToken() {
  const token = localStorage.getItem("bdm_token") || sessionStorage.getItem("bdm_token") || "";
  const exp = Number(localStorage.getItem("bdm_token_expires_at") || 0);
  if (!token) return "";
  if (exp && Date.now() > exp) { localStorage.removeItem("bdm_token"); localStorage.removeItem("bdm_token_expires_at"); sessionStorage.removeItem("bdm_token"); return ""; }
  return token;
}
function saveTokenForMonth(token) {
  const exp = Date.now() + SESSION_MAX_AGE_MS;
  localStorage.setItem("bdm_token", token); localStorage.setItem("bdm_token_expires_at", String(exp)); sessionStorage.setItem("bdm_token", token);
}

/* ═══════════════════════════════════════════════════
   DEMONSTRATION: Helper function added by Claude
   Formats file size in human-readable format
   ═══════════════════════════════════════════════════ */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ═══════════════════════════════════════════════════
// SMALL COMPONENTS
// ═══════════════════════════════════════════════════

/* Yellow sticky note — dismissable help */
function StickyNote({ text, id, dismissed, onDismiss }) {
  if (dismissed[id]) return null;
  return (
    <div style={{background:C.note,border:`1px solid ${C.noteBorder}`,borderLeft:`4px solid ${C.noteBorder}`,borderRadius:"4px",padding:"0.5rem 0.7rem",marginBottom:"0.6rem",fontSize:"0.74rem",color:"#6b5e00",display:"flex",alignItems:"flex-start",gap:"0.4rem"}}>
      <span style={{flexShrink:0}}>💡</span>
      <span style={{flex:1,lineHeight:1.45}}>{text}</span>
      <button onClick={()=>onDismiss(id)} style={{background:"none",border:"none",cursor:"pointer",color:"#b0a040",fontSize:"0.85rem",padding:0,lineHeight:1,flexShrink:0}}>×</button>
    </div>
  );
}

const ACCEPTED_FILES = ".pdf,.docx,.doc,.txt,.xlsx,.xls,.csv,.rtf,.odt,.pptx,.ppt,.html,.htm,.md,.json,.xml";

function FileRow({ p, i, onChange, onRemove, canRemove, placeholder }) {
  const ref = useRef(null);
  const [drag, setDrag] = useState(false);
  const handle = f => { if(f) onChange(i,"file",f); };
  return (
    <div style={{display:"flex",gap:"0.45rem",alignItems:"center",marginBottom:"0.45rem"}}>
      <input value={p.label} onChange={e=>onChange(i,"label",e.target.value)} placeholder={placeholder||"Etiqueta"}
        style={{width:"140px",flexShrink:0,padding:"0.38rem 0.55rem",border:`1px solid ${C.border}`,borderRadius:"6px",fontFamily:"Georgia,serif",fontSize:"0.8rem",background:C.white,color:C.text}}/>
      <div onClick={()=>ref.current?.click()}
        onDragOver={e=>{e.preventDefault();setDrag(true);}}
        onDragLeave={()=>setDrag(false)}
        onDrop={e=>{e.preventDefault();setDrag(false);handle(e.dataTransfer.files[0]);}}
        style={{flex:1,border:`2px dashed ${drag?C.amber:p.file?C.sage:C.border}`,borderRadius:"7px",padding:"0.4rem 0.7rem",cursor:"pointer",background:drag?"#eef8f2":p.file?"#eaf4ee":C.white,display:"flex",alignItems:"center",gap:"0.4rem",transition:"all 0.15s",minHeight:"36px"}}>
        <input ref={ref} type="file" accept={ACCEPTED_FILES} style={{display:"none"}} onChange={e=>handle(e.target.files[0])}/>
        <span style={{fontSize:"0.9rem"}}>{p.file?"📄":"📂"}</span>
        <span style={{fontSize:"0.76rem",color:p.file?C.mid:C.muted,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.file?p.file.name:"Clic o arrastre aquí"}</span>
        {p.file&&<span style={{fontSize:"0.63rem",color:C.sage,flexShrink:0}}>✓ {(p.file.size/1024).toFixed(0)}KB</span>}
      </div>
      {canRemove&&<button onClick={()=>onRemove(i)} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:"6px",cursor:"pointer",color:C.muted,fontSize:"0.9rem",padding:"0.35rem 0.45rem",flexShrink:0,lineHeight:1}}>×</button>}
    </div>
  );
}

/* Template file row with checkbox */
function TemplateRow({ p, i, onChange, onRemove, canRemove, checked, onCheck }) {
  const ref = useRef(null);
  const [drag, setDrag] = useState(false);
  const handle = f => { if(f) onChange(i,"file",f); };
  return (
    <div style={{display:"flex",gap:"0.4rem",alignItems:"center",marginBottom:"0.45rem"}}>
      {p.file && <input type="checkbox" checked={checked} onChange={e=>onCheck(i,e.target.checked)} style={{flexShrink:0,accentColor:C.mid}} />}
      {!p.file && <div style={{width:16,flexShrink:0}} />}
      <input value={p.label} onChange={e=>onChange(i,"label",e.target.value)} placeholder="Nombre/etiqueta"
        style={{width:"130px",flexShrink:0,padding:"0.38rem 0.55rem",border:`1px solid ${C.border}`,borderRadius:"6px",fontFamily:"Georgia,serif",fontSize:"0.8rem",background:C.white,color:C.text}}/>
      <div onClick={()=>ref.current?.click()}
        onDragOver={e=>{e.preventDefault();setDrag(true);}}
        onDragLeave={()=>setDrag(false)}
        onDrop={e=>{e.preventDefault();setDrag(false);handle(e.dataTransfer.files[0]);}}
        style={{flex:1,border:`2px dashed ${drag?C.amber:p.file?C.sage:C.border}`,borderRadius:"7px",padding:"0.4rem 0.7rem",cursor:"pointer",background:drag?"#eef8f2":p.file?"#eaf4ee":C.white,display:"flex",alignItems:"center",gap:"0.4rem",transition:"all 0.15s",minHeight:"36px"}}>
        <input ref={ref} type="file" accept={ACCEPTED_FILES} style={{display:"none"}} onChange={e=>handle(e.target.files[0])}/>
        <span style={{fontSize:"0.9rem"}}>{p.file?"📄":"📂"}</span>
        <span style={{fontSize:"0.76rem",color:p.file?C.mid:C.muted,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.file?p.file.name:"Clic o arrastre aquí"}</span>
      </div>
      {canRemove&&<button onClick={()=>onRemove(i)} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:"6px",cursor:"pointer",color:C.muted,fontSize:"0.9rem",padding:"0.35rem 0.45rem",flexShrink:0,lineHeight:1}}>×</button>}
    </div>
  );
}

function DropZone({ file, onFile, label, hint }) {
  const ref = useRef(null);
  const [drag, setDrag] = useState(false);
  const handle = f => { if(f) onFile(f); };
  return (
    <div onClick={()=>ref.current?.click()}
      onDragOver={e=>{e.preventDefault();setDrag(true);}}
      onDragLeave={()=>setDrag(false)}
      onDrop={e=>{e.preventDefault();setDrag(false);handle(e.dataTransfer.files[0]);}}
      style={{border:`2px dashed ${drag?C.amber:file?C.sage:C.border}`,borderRadius:"8px",padding:"0.7rem 0.9rem",cursor:"pointer",background:drag?"#eef8f2":file?"#eaf4ee":C.white,display:"flex",alignItems:"center",gap:"0.6rem",minHeight:"44px",transition:"all 0.15s"}}>
      <input ref={ref} type="file" accept={ACCEPTED_FILES} style={{display:"none"}} onChange={e=>handle(e.target.files[0])}/>
      <span style={{fontSize:"1.1rem",flexShrink:0}}>{file?"📄":"📂"}</span>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:"0.8rem",fontWeight:file?"bold":"normal",color:file?C.mid:C.muted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{file?file.name:label}</div>
        {!file&&hint&&<div style={{fontSize:"0.67rem",color:C.muted,marginTop:"1px"}}>{hint}</div>}
        {file&&<div style={{fontSize:"0.67rem",color:C.sage,marginTop:"1px"}}>✓ {(file.size/1024).toFixed(0)} KB</div>}
      </div>
      {file&&<button onClick={e=>{e.stopPropagation();onFile(null);}} style={{background:"none",border:"none",cursor:"pointer",color:C.muted,fontSize:"1rem",padding:"0 2px",lineHeight:1}}>×</button>}
    </div>
  );
}

function Editor({ content, onChange, exportName }) {
  const [mode, setMode] = useState("edit");
  const prev = md => {
    if(!md) return "";
    return md
      .replace(/^# (.+)$/gm,`<h1 style="color:${C.mid};font-size:1.3rem;border-bottom:2px solid ${C.amber};padding-bottom:5px;margin-top:1.3rem;">$1</h1>`)
      .replace(/^## (.+)$/gm,`<h2 style="color:${C.mid};font-size:1.08rem;margin-top:1rem;">$1</h2>`)
      .replace(/^### (.+)$/gm,`<h3 style="color:${C.sage};font-size:0.93rem;margin-top:0.85rem;">$1</h3>`)
      .replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>")
      .replace(/^---$/gm,`<hr style="border:1px solid ${C.border};margin:0.7rem 0;"/>`)
      .replace(/^\| (.+) \|$/gm, row=>{
        const cells=row.split('|').slice(1,-1).map(c=>c.trim());
        if(cells.every(c=>c.match(/^[-:]+$/))) return '';
        return `<tr>${cells.map(c=>`<td style="border:1px solid ${C.border};padding:5px 9px;font-size:0.8rem;">${c}</td>`).join('')}</tr>`;
      })
      .replace(/(<tr>.*?<\/tr>\n?)+/gs,m=>`<table style="border-collapse:collapse;width:100%;margin:6px 0;">${m}</table>`)
      .replace(/^[-*] (.+)$/gm,"<li style='font-size:0.83rem;margin-bottom:2px;'>$1</li>")
      .replace(/(<li[^>]*>.*?<\/li>\n?)+/gs,m=>`<ul style="padding-left:1.1rem;margin:3px 0;">${m}</ul>`)
      .replace(/^(?!<[hult]|<\/|$)(.+)$/gm,"<p style='font-size:0.83rem;line-height:1.6;margin:3px 0;'>$1</p>");
  };
  if(!content) return <div style={{padding:"2rem",textAlign:"center",color:C.muted,fontStyle:"italic",background:C.white,borderRadius:"8px",border:`1px solid ${C.border}`}}>Sin contenido generado.</div>;
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.58rem",flexWrap:"wrap",gap:"0.45rem"}}>
        <div style={{display:"flex",gap:"1px",background:C.border,borderRadius:"6px",overflow:"hidden"}}>
          {[["edit","✏️ Editar"],["preview","👁 Vista previa"]].map(([m,l])=>(
            <button key={m} onClick={()=>setMode(m)} style={{padding:"0.3rem 0.72rem",background:mode===m?C.mid:"transparent",color:mode===m?"#f0ebe0":C.muted,border:"none",cursor:"pointer",fontSize:"0.76rem"}}>{l}</button>
          ))}
        </div>
        <div style={{display:"flex",gap:"0.38rem"}}>
          <button onClick={()=>dlWord(content,exportName)} style={{padding:"0.3rem 0.78rem",background:C.amber,color:C.dark,border:"none",borderRadius:"5px",cursor:"pointer",fontSize:"0.76rem",fontWeight:"bold"}}>📄 Word</button>
          <button onClick={()=>dlMd(content,exportName)} style={{padding:"0.3rem 0.62rem",background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:"5px",cursor:"pointer",fontSize:"0.76rem"}}>⬇ .md</button>
        </div>
      </div>
      {mode==="edit"
        ?<textarea value={content} onChange={e=>onChange(e.target.value)} style={{width:"100%",minHeight:"490px",padding:"0.9rem",border:`1px solid ${C.border}`,borderRadius:"8px",fontFamily:"'Courier New',monospace",fontSize:"0.75rem",lineHeight:1.7,background:C.white,color:C.text,resize:"vertical",boxSizing:"border-box"}}/>
        :<div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:"8px",padding:"1.6rem",maxHeight:"530px",overflowY:"auto",fontFamily:"Georgia,serif"}} dangerouslySetInnerHTML={{__html:prev(content)}}/>
      }
    </div>
  );
}

function MCard({ icon, label, status, active }) {
  const s = status||"pending";
  const sc={running:{bg:"#deeee5",border:C.sage,text:C.mid},done:{bg:"#e3f0e6",border:"#38844e",text:"#18502a"},error:{bg:C.errBg,border:"#b06060",text:"#7a2020"},skipped:{bg:"#eee9de",border:C.border,text:C.muted},pending:{bg:C.white,border:C.border,text:"#989080"}}[s];
  return(
    <div style={{background:sc.bg,border:`1px solid ${sc.border}`,borderRadius:"6px",padding:"0.5rem 0.75rem",boxShadow:active?`0 0 0 2px ${sc.border}`:"none",transition:"all 0.25s"}}>
      <div style={{display:"flex",alignItems:"center",gap:"0.35rem"}}>
        <span style={{fontSize:"0.83rem"}}>{icon}</span>
        <span style={{flex:1,fontSize:"0.74rem",fontWeight:"bold",color:sc.text}}>{label}</span>
        <span style={{fontFamily:"monospace",color:sc.text,fontSize:"0.9rem"}}>{{"running":"⟳","done":"✓","error":"⚠","skipped":"—","pending":"○"}[s]}</span>
      </div>
    </div>
  );
}

function PasswordGate({ onAuth }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setLoading(true); setError("");
    try {
      const res = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Contraseña incorrecta"); return; }
      onAuth(data.token);
    } catch { setError("Error de conexión."); } finally { setLoading(false); }
  };
  return (
    <div style={{fontFamily:"Georgia,serif",background:C.bg,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:"12px",padding:"2.5rem",width:"100%",maxWidth:"360px",boxShadow:"0 4px 24px rgba(0,0,0,0.08)"}}>
        <div style={{textAlign:"center",marginBottom:"1.8rem"}}>
          <span style={{fontSize:"2.5rem"}}>🌿</span>
          <div style={{color:C.mid,fontSize:"1.1rem",fontWeight:"bold",marginTop:"0.5rem"}}>Bosques del Mundo Bolivia</div>
          <div style={{color:C.muted,fontSize:"0.75rem",marginTop:"0.25rem"}}>Sistema de Informes</div>
        </div>
        <form onSubmit={submit}>
          <input type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="Contraseña" autoFocus
            style={{width:"100%",padding:"0.7rem 0.9rem",border:`1px solid ${error?C.errText:C.border}`,borderRadius:"7px",fontFamily:"Georgia,serif",fontSize:"0.9rem",background:C.white,color:C.text,boxSizing:"border-box",marginBottom:"0.75rem"}} />
          {error&&<div style={{color:C.errText,fontSize:"0.78rem",marginBottom:"0.6rem"}}>{error}</div>}
          <button type="submit" disabled={loading||!pw}
            style={{width:"100%",padding:"0.75rem",background:pw&&!loading?C.dark:"#c0b8a5",color:pw&&!loading?C.amber:C.muted,border:"none",borderRadius:"7px",fontSize:"0.9rem",fontFamily:"Georgia,serif",cursor:pw&&!loading?"pointer":"not-allowed",fontWeight:"bold"}}>
            {loading?"Verificando...":"Ingresar"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════
export default function App() {
  const [token, setToken] = useState(() => getStoredToken());
  const [phase, setPhase] = useState("setup");

  // Inputs — left column: templates/past reports
  const [templates, setTemplates] = useState([{label:"",file:null}]);
  const [tplChecked, setTplChecked] = useState({});
  // Inputs — right column: partner/source documents
  const [partners, setPartners] = useState([{label:"",file:null},{label:"",file:null}]);
  // Financial — multiple
  const [finFiles, setFinFiles] = useState([{label:"",file:null}]);
  // Plantilla document
  const [plantillaFile, setPlantillaFile] = useState(null);
  // Report type — free text
  const [reportType, setReportType] = useState("");
  const [includeM2, setIncludeM2] = useState(true);
  // Chat
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMsgs, setChatMsgs] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  // DB documents
  const [dbDocs, setDbDocs] = useState([]);
  const [dbOutputs, setDbOutputs] = useState([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbOpen, setDbOpen] = useState(false);
  // Sticky notes dismissed
  const [dismissed, setDismissed] = useState({});
  const dismiss = id => setDismissed(p => ({...p, [id]: true}));
  // Outputs
  const [outs, setOuts] = useState({});
  const [edits, setEdits] = useState({});
  const [stats, setStats] = useState({});
  const [active, setActive] = useState(null);
  const [logs, setLogs] = useState([]);
  const [errs, setErrs] = useState([]);
  const [tab, setTab] = useState("m0b");
  const logRef = useRef(null);
  const chatEndRef = useRef(null);

  const log = msg => setLogs(p => { const n=[...p,`[${new Date().toLocaleTimeString("es-BO")}] ${msg}`]; setTimeout(()=>logRef.current?.scrollTo(0,9999),50); return n; });
  const setSt = (id,s) => setStats(p=>({...p,[id]:s}));
  const setOut = (id,v) => setOuts(p=>({...p,[id]:v}));
  const get = key => edits[key]!==undefined ? edits[key] : outs[key];
  const set = (key,val) => setEdits(p=>({...p,[key]:val}));

  // Template helpers
  const upT = (i,f,v) => setTemplates(p=>p.map((x,j)=>j===i?{...x,[f]:v}:x));
  const rmT = i => { setTemplates(p=>p.filter((_,j)=>j!==i)); setTplChecked(p=>{const n={...p}; delete n[i]; return n;}); };
  const addT = () => setTemplates(p=>[...p,{label:"",file:null}]);
  const checkT = (i,v) => setTplChecked(p=>({...p,[i]:v}));
  // Partner helpers
  const upP = (i,f,v) => setPartners(p=>p.map((x,j)=>j===i?{...x,[f]:v}:x));
  const rmP = i => setPartners(p=>p.filter((_,j)=>j!==i));
  const addP = () => setPartners(p=>[...p,{label:"",file:null}]);
  // Financial helpers
  const upF = (i,f,v) => setFinFiles(p=>p.map((x,j)=>j===i?{...x,[f]:v}:x));
  const rmF = i => setFinFiles(p=>p.filter((_,j)=>j!==i));
  const addF = () => setFinFiles(p=>[...p,{label:"",file:null}]);

  const selectedTemplates = templates.filter((t,i) => t.file && tplChecked[i]);
  const validPartners = partners.filter(p => p.file);
  const canRun = validPartners.length > 0;

  // Fetch DB documents when panel opens
  const fetchDbDocs = async () => {
    if (dbLoading) return;
    setDbLoading(true);
    const tk = sessionStorage.getItem("bdm_token") || localStorage.getItem("bdm_token") || "";
    const headers = { "Authorization": `Bearer ${tk}` };
    try {
      const [dRes, oRes] = await Promise.all([
        fetch("/api/documents", { headers }).then(r => r.ok ? r.json() : { documents: [] }),
        fetch("/api/outputs", { headers }).then(r => r.ok ? r.json() : { outputs: [] }),
      ]);
      setDbDocs(dRes.documents || []);
      setDbOutputs(oRes.outputs || []);
    } catch { setDbDocs([]); setDbOutputs([]); }
    setDbLoading(false);
  };

  useEffect(() => { chatEndRef.current?.scrollIntoView({behavior:"smooth"}); }, [chatMsgs]);

  const sendChat = async () => {
    const msg = chatInput.trim();
    if (!msg) return;
    setChatMsgs(prev => [...prev, { role: "user", content: msg }]);
    setChatInput("");
    if (phase === "results" && (get("m0b") || "").trim()) {
      setChatLoading(true);
      try {
        const base = get("m0b") || "";
        const rewritten = await callMotor(
          "Eres editor especializado. Reescribe SOLO donde se pida, sin inventar datos.",
          `TIPO DE INFORME: ${reportType || "general"}\n\nINSTRUCCIÓN DEL USUARIO:\n${msg}\n\nBORRADOR ACTUAL:\n${base}`, 8000
        );
        set("m0b", rewritten || base);
        setChatMsgs(prev => [...prev, { role: "assistant", content: "✅ Ajuste aplicado al borrador." }]);
      } catch (e) {
        setChatMsgs(prev => [...prev, { role: "assistant", content: `❌ ${e.message}` }]);
      } finally { setChatLoading(false); }
    } else {
      setChatMsgs(prev => [...prev, { role: "assistant", content: "📌 Instrucción guardada. Se aplicará al generar." }]);
    }
  };

  if (!token) return <PasswordGate onAuth={t => { saveTokenForMonth(t); setToken(t); }} />;

  const run = async () => {
    if (!canRun) return;
    setPhase("running"); setLogs([]); setErrs([]); setStats({}); setOuts({}); setEdits({});
    const errors = [], o = {};
    try {
      const chatInstructions = chatMsgs.filter(m=>m.role==="user").map(m=>`- ${m.content}`).join("\n");
      const effectiveType = reportType.trim() || "Informe institucional general";

      // TEMPLATE — process plantilla doc + selected past reports
      const hasPlantilla = !!plantillaFile;
      const hasTplRefs = selectedTemplates.length > 0;
      if (hasPlantilla || hasTplRefs) {
        setActive("template"); setSt("template","running");
        log(`Motor TEMPLATE: Analizando plantilla y ${selectedTemplates.length} referencia(s)...`);
        try {
          let combinedTpl = "";
          // Process dedicated plantilla file first
          if (plantillaFile) {
            const pf = await readFile(plantillaFile, log);
            const content = await buildContent(pf, `Analiza este documento plantilla "${plantillaFile.name}" y extrae estructura, formato, tono y secciones.`, log);
            const raw = await callMotor(P.template, content, 1500);
            combinedTpl += raw + "\n\n";
          }
          // Then selected past reports as style refs
          for (const t of selectedTemplates) {
            const pf = await readFile(t.file, log);
            const content = await buildContent(pf, `Analiza este documento de referencia "${t.label||t.file.name}" y extrae estructura, tono y secciones.`, log);
            const raw = await callMotor(P.template, content, 1500);
            combinedTpl += raw + "\n\n";
          }
          const p = tryJSON(combinedTpl);
          o.template = p.ok ? p.data : combinedTpl;
          setOut("template", o.template); setSt("template","done");
          log("Motor TEMPLATE: ✓ Estructura extraída.");

          // Auto-infer report type if user left it blank
          if (!reportType.trim()) {
            log("🔍 Infiriendo tipo de informe desde la plantilla...");
            try {
              const inferred = await callMotor(
                "Analiza la estructura del documento y clasifica el tipo de informe. Responde SOLO con una frase corta descriptiva en español, ej: 'Memoria anual para donante', 'Informe ministerial', 'Reporte para socios ejecutores', 'Informe interno de gestión'.",
                `Estructura extraída:\n${combinedTpl.slice(0,2000)}`, 60, 30000
              );
              const inferredType = (inferred || "").trim();
              if (inferredType) {
                setReportType(inferredType);
                log(`🔍 Tipo inferido: "${inferredType}"`);
              }
            } catch { log("🔍 No se pudo inferir el tipo — usando genérico."); }
          }
        } catch(e) { setSt("template","skipped"); log(`Motor TEMPLATE: ⚠ ${e.message}`); }
      } else { setSt("template","skipped"); log("Motor TEMPLATE: Omitido (sin plantilla ni referencias)."); }

      // ALPHA × partners
      o.alpha = [];
      for (let i = 0; i < validPartners.length; i++) {
        const sp = validPartners[i], mid = `alpha_${i}`;
        const lbl = sp.label.trim() || sp.file.name.replace(/\.[^.]+$/,"");
        setActive(mid); setSt(mid,"running");
        log(`Alpha [${lbl}]: Leyendo documento...`);
        const pf = await readFile(sp.file, log);
        log(`Alpha [${lbl}]: Extrayendo datos...`);
        const content = await buildContent(pf, `Extrae TODOS los datos estructurados de "${lbl}".`, log);
        const raw = await callMotor(P.alpha, content, 8000);
        const p = tryJSON(raw);
        if (!p.ok) { errors.push(`Alpha [${lbl}]: ${p.err}`); setSt(mid,"error"); }
        else setSt(mid,"done");
        o.alpha.push({ label: lbl, data: p.ok ? p.data : {raw:p.data, parse_error:true} });
        setOut("alpha", [...o.alpha]);
        log(`Alpha [${lbl}]: ${p.ok?"✓":"⚠"} Completado.`);
      }

      // Financial — multiple files
      let finCtx = "";
      const validFin = finFiles.filter(f => f.file);
      for (const fi of validFin) {
        const flbl = fi.label.trim() || fi.file.name.replace(/\.[^.]+$/, "");
        log(`Leyendo informe financiero [${flbl}]...`);
        try {
          const pf = await readFile(fi.file, log);
          const content = await buildContent(pf, `Extrae todos los datos financieros de "${flbl}".`, log);
          finCtx += typeof content === "string" ? `\n\nINFORME FINANCIERO [${flbl}]:\n${content.slice(0,6000)}` : `\n\nINFORME FINANCIERO [${flbl}]: adjunto.`;
        } catch(e) { log(`Financiero [${flbl}]: ⚠ ${e.message}`); }
      }

      const aStr = JSON.stringify(o.alpha.map(a=>({socio:a.label,...a.data})), null, 2);

      // M0a
      setActive("m0a"); setSt("m0a","running");
      log("M0a: Consolidando datos...");
      const m0aR = await callMotor(P.m0a, `Consolida:\n\n${aStr}${finCtx}`, 8000);
      const m0aP = tryJSON(m0aR); o.m0a = m0aP.ok ? m0aP.data : {raw:m0aR};
      setOut("m0a",o.m0a); setSt("m0a", m0aP.ok?"done":"error");
      log(`M0a: ${m0aP.ok?"✓":"⚠"} Consolidación completada.`);

      // M0b
      setActive("m0b"); setSt("m0b","running");
      log("M0b: Redactando informe narrativo...");
      const tpl = o.template ? `\n\nESTRUCTURA BASE:\n${JSON.stringify(o.template,null,2)}` : "";
      const m0bR = await callMotor(P.m0b, `TIPO DE INFORME: ${effectiveType}\n\nINSTRUCCIONES DEL USUARIO:\n${chatInstructions || "- Sin instrucciones adicionales"}\n\nDatos:\n\n${JSON.stringify(o.m0a,null,2)}${tpl}`, 8000);
      o.m0b = m0bR; setOut("m0b",m0bR); setSt("m0b","done");
      log("M0b: ✓ Informe generado.");

      // M0c
      setActive("m0c"); setSt("m0c","running");
      log("M0c: Verificando trazabilidad...");
      const m0cR = await callMotor(P.m0c, `INFORME:\n${o.m0b}\n\n---\nDATOS:\n${aStr}`, 6000);
      o.m0c = m0cR; setOut("m0c",m0cR); setSt("m0c","done");
      log("M0c: ✓ Trazabilidad completada.");

      if (includeM2) {
        setActive("m2"); setSt("m2","running");
        log("M2: Generando panel ejecutivo...");
        const m2R = await callMotor(P.m2, `TRAZABILIDAD:\n${o.m0c}\n\n---\nINFORME:\n${o.m0b}`, 4000);
        o.m2 = m2R; setOut("m2",m2R); setSt("m2","done");
        log("M2: ✓ Panel ejecutivo listo.");
      } else { setSt("m2","skipped"); }

      setActive(null); setErrs(errors); setPhase("results"); setTab("m0b");
      log("══════ PIPELINE COMPLETADO ══════");
    } catch(err) {
      errors.push(`Error: ${err.message}`); setErrs(errors); setActive(null);
      log(`❌ Error: ${err.message}`); setPhase("results");
    }
  };

  const resetAll = () => { setPhase("setup"); setOuts({}); setEdits({}); setStats({}); setLogs([]); setErrs([]); setActive(null); };

  // ─── FLOATING CHAT SIDEBAR ───
  const chatSidebar = (
    <div style={{position:"fixed",top:0,right:chatOpen?0:"-360px",width:"350px",height:"100vh",background:C.white,borderLeft:`2px solid ${C.border}`,boxShadow:chatOpen?"-4px 0 20px rgba(0,0,0,0.1)":"none",transition:"right 0.3s ease",zIndex:1000,display:"flex",flexDirection:"column"}}>
      <div style={{background:C.dark,padding:"0.7rem 1rem",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{color:C.amber,fontWeight:"bold",fontSize:"0.88rem"}}>💬 Instrucciones</span>
        <button onClick={()=>setChatOpen(false)} style={{background:"none",border:"none",color:"#78a888",cursor:"pointer",fontSize:"1.2rem",lineHeight:1}}>×</button>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"0.8rem"}}>
        <StickyNote id="chat_help" text="Escriba instrucciones antes de generar (ej: 'enfatizar gobernanza territorial'). Después de generar, úselo para pedir ajustes al borrador." dismissed={dismissed} onDismiss={dismiss} />
        {chatMsgs.length === 0 && <div style={{textAlign:"center",color:C.muted,fontSize:"0.74rem",padding:"2rem 0",fontStyle:"italic"}}>Sin mensajes todavía</div>}
        {chatMsgs.map((m,idx) => (
          <div key={idx} style={{marginBottom:"0.5rem",display:"flex",flexDirection:"column",alignItems:m.role==="user"?"flex-end":"flex-start"}}>
            <div style={{background:m.role==="user"?C.dark:C.note,color:m.role==="user"?"#e0d8c8":"#4a3f00",padding:"0.45rem 0.7rem",borderRadius:m.role==="user"?"10px 10px 2px 10px":"10px 10px 10px 2px",maxWidth:"85%",fontSize:"0.76rem",lineHeight:1.45}}>{m.content}</div>
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>
      <div style={{borderTop:`1px solid ${C.border}`,padding:"0.6rem",display:"flex",gap:"0.35rem"}}>
        <input value={chatInput} onChange={e=>setChatInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendChat()} placeholder="Escriba instrucción..."
          style={{flex:1,padding:"0.45rem 0.6rem",border:`1px solid ${C.border}`,borderRadius:"6px",fontSize:"0.78rem"}} />
        <button onClick={sendChat} disabled={chatLoading||!chatInput.trim()}
          style={{padding:"0.45rem 0.7rem",background:C.dark,color:C.amber,border:"none",borderRadius:"6px",cursor:chatLoading?"not-allowed":"pointer",fontSize:"0.75rem"}}>{chatLoading?"...":"→"}</button>
      </div>
    </div>
  );

  // Chat toggle button (always visible)
  const chatToggle = !chatOpen && (
    <button onClick={()=>setChatOpen(true)}
      style={{position:"fixed",bottom:"1.5rem",right:"1.5rem",width:"52px",height:"52px",borderRadius:"50%",background:C.dark,color:C.amber,border:`2px solid ${C.amber}`,fontSize:"1.4rem",cursor:"pointer",boxShadow:"0 4px 16px rgba(0,0,0,0.2)",zIndex:999,display:"flex",alignItems:"center",justifyContent:"center"}}>
      💬
    </button>
  );

  // ─── RENDER ───
  return (
    <div style={{fontFamily:"Georgia,'Times New Roman',serif",background:C.bg,minHeight:"100vh",color:C.text}}>
      {chatSidebar}
      {chatToggle}

      <header style={{background:C.dark,borderBottom:`3px solid ${C.amber}`,padding:"0.7rem 1.5rem",display:"flex",alignItems:"center",gap:"1rem",flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:"0.7rem"}}>
          <span style={{fontSize:"1.7rem"}}>🌿</span>
          <div>
            <div style={{color:C.amber,fontSize:"1.02rem",fontWeight:"bold"}}>Bosques del Mundo Bolivia</div>
            <div style={{color:"#78a888",fontSize:"0.6rem",fontFamily:"monospace",letterSpacing:"0.12em"}}>SISTEMA DE INFORMES · PIPELINE IA · Gemini</div>
          </div>
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:"3px",alignItems:"center"}}>
          {[["setup","① Insumos"],["running","② Procesamiento"],["results","③ Resultados"]].map(([id,lbl],i)=>{
            const idx=["setup","running","results"].indexOf(phase);
            return <span key={id} style={{padding:"0.2rem 0.58rem",borderRadius:"999px",fontSize:"0.62rem",fontFamily:"monospace",background:phase===id?C.amber:idx>i?C.mid:"rgba(255,255,255,0.07)",color:phase===id?C.dark:idx>i?"#90c8a0":"rgba(255,255,255,0.26)",fontWeight:phase===id?"bold":"normal"}}>{lbl}</span>;
          })}
          <button onClick={()=>{localStorage.removeItem("bdm_token");localStorage.removeItem("bdm_token_expires_at");sessionStorage.removeItem("bdm_token");setToken("");setPhase("setup");}} style={{marginLeft:"0.5rem",padding:"0.2rem 0.5rem",borderRadius:"4px",fontSize:"0.58rem",fontFamily:"monospace",background:"rgba(255,255,255,0.1)",color:"#78a888",border:"1px solid rgba(255,255,255,0.15)",cursor:"pointer"}}>Salir</button>
        </div>
      </header>

      {/* ═══ SETUP PHASE ═══ */}
      {phase==="setup" && (
        <div style={{maxWidth:"1100px",margin:"0 auto",padding:"1.5rem 1.5rem"}}>

          {/* ── Row 1: Two input columns ── */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"1rem",marginBottom:"1rem"}}>

            {/* LEFT — Past reports */}
            <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:"10px",padding:"1.1rem"}}>
              <h3 style={{color:C.mid,margin:"0 0 0.4rem 0",fontSize:"0.9rem"}}>📋 Insumos informes presentados gestiones pasadas</h3>
              <StickyNote id="tpl_help" text="Suba informes de gestiones anteriores. El sistema extraerá datos y podrá usar su formato como referencia para el nuevo informe." dismissed={dismissed} onDismiss={dismiss} />
              {templates.map((t,i) => (
                <FileRow key={i} p={t} i={i} onChange={upT} onRemove={rmT} canRemove={templates.length>1} placeholder="Etiqueta" />
              ))}
              <button onClick={addT} style={{marginTop:"0.15rem",padding:"0.32rem 0.7rem",background:"none",border:`1px dashed ${C.sage}`,borderRadius:"6px",color:C.mid,cursor:"pointer",fontSize:"0.74rem"}}>+ Agregar documento</button>
            </div>

            {/* RIGHT — Partner documents */}
            <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:"10px",padding:"1.1rem"}}>
              <h3 style={{color:C.mid,margin:"0 0 0.4rem 0",fontSize:"0.9rem"}}>📁 Insumos informes de socios</h3>
              <StickyNote id="partner_help" text="Suba los informes de socios, ejecutores, reportes técnicos u otros documentos fuente. Al menos uno es necesario. El sistema extraerá todos los datos para el nuevo informe." dismissed={dismissed} onDismiss={dismiss} />
              {partners.map((p,i) => (
                <FileRow key={i} p={p} i={i} onChange={upP} onRemove={rmP} canRemove={partners.length>1} placeholder="Etiqueta" />
              ))}
              <button onClick={addP} style={{marginTop:"0.15rem",padding:"0.32rem 0.7rem",background:"none",border:`1px dashed ${C.sage}`,borderRadius:"6px",color:C.mid,cursor:"pointer",fontSize:"0.74rem"}}>+ Agregar documento</button>
            </div>
          </div>

          {/* ── Row 2: Plantilla del nuevo informe (full width, prominent) ── */}
          <div style={{background:"#e8f0ea",border:`2px solid ${C.sage}`,borderRadius:"10px",padding:"1.2rem",marginBottom:"1rem"}}>
            <h3 style={{color:C.mid,margin:"0 0 0.5rem 0",fontSize:"0.95rem",textAlign:"center"}}>📐 Plantilla del nuevo informe a elaborar</h3>
            <StickyNote id="plantilla_help" text="Defina cómo será el nuevo informe. El sistema interpreta el formato, los lineamientos y adapta el lenguaje y narrativa según el tipo seleccionado. Puede subir un documento de referencia como plantilla y/o seleccionar informes pasados como guía de estilo." dismissed={dismissed} onDismiss={dismiss} />

            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"1rem"}}>
              {/* Left: template document + past report selection */}
              <div>
                <div style={{fontSize:"0.78rem",fontWeight:"bold",color:C.mid,marginBottom:"0.35rem"}}>Documento plantilla (opcional)</div>
                <DropZone file={plantillaFile} onFile={setPlantillaFile} label="Subir documento de referencia para formato" hint="El sistema extraerá estructura, tono y lineamientos" />
                {templates.filter(t=>t.file).length > 0 && (
                  <div style={{marginTop:"0.6rem"}}>
                    <div style={{fontSize:"0.74rem",color:C.muted,marginBottom:"0.3rem"}}>O seleccione informes pasados como guía de estilo:</div>
                    {templates.map((t,i) => t.file ? (
                      <label key={i} style={{display:"flex",gap:"0.35rem",alignItems:"center",fontSize:"0.76rem",color:C.text,marginBottom:"0.2rem"}}>
                        <input type="checkbox" checked={!!tplChecked[i]} onChange={e=>checkT(i,e.target.checked)} style={{accentColor:C.mid}} />
                        {t.label || t.file.name}
                      </label>
                    ) : null)}
                  </div>
                )}
              </div>
              {/* Right: report type + auto-infer */}
              <div>
                <div style={{fontSize:"0.78rem",fontWeight:"bold",color:C.mid,marginBottom:"0.35rem"}}>Tipo de informe</div>
                <StickyNote id="type_help" text="Escriba el tipo o deje vacío para que el sistema lo detecte automáticamente de la plantilla. Ej: Ministerial, Donantes, Socios, Interno." dismissed={dismissed} onDismiss={dismiss} />
                <input value={reportType} onChange={e=>setReportType(e.target.value)}
                  placeholder="Ej: Ministerial, Para donante DANIDA, Para socios..."
                  style={{width:"100%",padding:"0.5rem 0.7rem",border:`1px solid ${C.border}`,borderRadius:"6px",fontFamily:"Georgia,serif",fontSize:"0.82rem",background:C.white,color:C.text,boxSizing:"border-box",marginBottom:"0.5rem"}} />
                {!reportType.trim() && <div style={{fontSize:"0.68rem",color:C.sage,fontStyle:"italic"}}>🔍 El sistema inferirá el tipo automáticamente de los documentos cargados</div>}
                <label style={{display:"flex",gap:"0.4rem",alignItems:"center",fontSize:"0.76rem",color:C.muted,marginTop:"0.4rem"}}>
                  <input type="checkbox" checked={includeM2} onChange={e=>setIncludeM2(e.target.checked)} style={{accentColor:C.mid}} />
                  Incluir panel ejecutivo como salida adicional
                </label>
              </div>
            </div>
          </div>

          {/* ── Row 3: Financial ── */}
          <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:"10px",padding:"1.1rem",marginBottom:"1rem"}}>
            <h3 style={{color:C.mid,margin:"0 0 0.4rem 0",fontSize:"0.9rem"}}>💰 Informes financieros <span style={{color:C.muted,fontSize:"0.72rem",fontWeight:"normal",fontStyle:"italic"}}>— opcional</span></h3>
            <StickyNote id="fin_help" text="Suba informes de ejecución presupuestaria, balances o estados financieros para enriquecer el análisis." dismissed={dismissed} onDismiss={dismiss} />
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.5rem"}}>
              <div>
                {finFiles.map((f,i) => (
                  <FileRow key={i} p={f} i={i} onChange={upF} onRemove={rmF} canRemove={finFiles.length>1} placeholder="Etiqueta" />
                ))}
                <button onClick={addF} style={{marginTop:"0.15rem",padding:"0.32rem 0.7rem",background:"none",border:`1px dashed ${C.sage}`,borderRadius:"6px",color:C.mid,cursor:"pointer",fontSize:"0.74rem"}}>+ Agregar informe</button>
              </div>
            </div>
          </div>

          {/* ── Row 4: Saved DB Documents (collapsible) ── */}
          <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:"10px",marginBottom:"1rem",overflow:"hidden"}}>
            <button onClick={()=>{setDbOpen(o=>!o); if(!dbOpen) fetchDbDocs();}}
              style={{width:"100%",padding:"0.75rem 1.1rem",background:"none",border:"none",cursor:"pointer",display:"flex",alignItems:"center",gap:"0.5rem",fontFamily:"Georgia,serif"}}>
              <span style={{fontSize:"0.95rem"}}>{dbOpen?"▾":"▸"}</span>
              <span style={{color:C.mid,fontSize:"0.9rem",fontWeight:"bold"}}>🗄️ Documentos guardados en la base de datos</span>
              {(dbDocs.length>0||dbOutputs.length>0)&&<span style={{fontSize:"0.68rem",background:C.sage,color:"#fff",borderRadius:"999px",padding:"0.1rem 0.45rem",marginLeft:"0.3rem"}}>{dbDocs.length + dbOutputs.length}</span>}
            </button>
            {dbOpen && (
              <div style={{padding:"0 1.1rem 1.1rem",borderTop:`1px solid ${C.border}`}}>
                {dbLoading && <div style={{textAlign:"center",padding:"1rem",color:C.muted,fontSize:"0.78rem"}}>⟳ Cargando...</div>}
                {!dbLoading && dbDocs.length===0 && dbOutputs.length===0 && (
                  <div style={{textAlign:"center",padding:"1.2rem",color:C.muted,fontSize:"0.78rem",fontStyle:"italic"}}>No hay documentos guardados en la base de datos.</div>
                )}
                {!dbLoading && dbDocs.length>0 && (
                  <div style={{marginTop:"0.7rem"}}>
                    <div style={{fontSize:"0.78rem",fontWeight:"bold",color:C.mid,marginBottom:"0.4rem"}}>📄 Documentos analizados ({dbDocs.length})</div>
                    <div style={{maxHeight:"220px",overflowY:"auto",border:`1px solid ${C.border}`,borderRadius:"6px"}}>
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:"0.72rem"}}>
                        <thead>
                          <tr style={{background:"#e8e3d8",position:"sticky",top:0}}>
                            <th style={{padding:"0.4rem 0.6rem",textAlign:"left",color:C.mid,fontWeight:"bold",borderBottom:`1px solid ${C.border}`}}>Archivo</th>
                            <th style={{padding:"0.4rem 0.5rem",textAlign:"left",color:C.mid,fontWeight:"bold",borderBottom:`1px solid ${C.border}`,width:"90px"}}>Tipo</th>
                            <th style={{padding:"0.4rem 0.5rem",textAlign:"left",color:C.mid,fontWeight:"bold",borderBottom:`1px solid ${C.border}`,width:"60px"}}>Págs</th>
                            <th style={{padding:"0.4rem 0.5rem",textAlign:"left",color:C.mid,fontWeight:"bold",borderBottom:`1px solid ${C.border}`,width:"130px"}}>Fecha</th>
                            <th style={{padding:"0.4rem 0.5rem",textAlign:"right",color:C.mid,fontWeight:"bold",borderBottom:`1px solid ${C.border}`,width:"70px"}}>Texto</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dbDocs.map(d=>(
                            <tr key={d.id} style={{borderBottom:`1px solid ${C.border}`}}>
                              <td style={{padding:"0.35rem 0.6rem",color:C.text}}>{d.label||d.original_file_name||`Doc #${d.id}`}</td>
                              <td style={{padding:"0.35rem 0.5rem",color:C.muted}}>{d.source_type}{d.ocr?" 🔍":""}</td>
                              <td style={{padding:"0.35rem 0.5rem",color:C.muted}}>{d.pages||"—"}</td>
                              <td style={{padding:"0.35rem 0.5rem",color:C.muted}}>{d.created_at?new Date(d.created_at).toLocaleString("es-BO",{dateStyle:"short",timeStyle:"short"}):"—"}</td>
                              <td style={{padding:"0.35rem 0.5rem",color:C.sage,textAlign:"right"}}>{d.extracted_text?`${Math.round(d.extracted_text.length/1000)}KB`:"—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                {!dbLoading && dbOutputs.length>0 && (
                  <div style={{marginTop:"0.7rem"}}>
                    <div style={{fontSize:"0.78rem",fontWeight:"bold",color:C.mid,marginBottom:"0.4rem"}}>📝 Informes generados ({dbOutputs.length})</div>
                    <div style={{maxHeight:"180px",overflowY:"auto",border:`1px solid ${C.border}`,borderRadius:"6px"}}>
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:"0.72rem"}}>
                        <thead>
                          <tr style={{background:"#e8e3d8",position:"sticky",top:0}}>
                            <th style={{padding:"0.4rem 0.6rem",textAlign:"left",color:C.mid,fontWeight:"bold",borderBottom:`1px solid ${C.border}`}}>Título</th>
                            <th style={{padding:"0.4rem 0.5rem",textAlign:"left",color:C.mid,fontWeight:"bold",borderBottom:`1px solid ${C.border}`,width:"110px"}}>Tipo</th>
                            <th style={{padding:"0.4rem 0.5rem",textAlign:"left",color:C.mid,fontWeight:"bold",borderBottom:`1px solid ${C.border}`,width:"130px"}}>Fecha</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dbOutputs.map(o=>(
                            <tr key={o.id} style={{borderBottom:`1px solid ${C.border}`}}>
                              <td style={{padding:"0.35rem 0.6rem",color:C.text}}>{o.title||`Informe #${o.id}`}</td>
                              <td style={{padding:"0.35rem 0.5rem",color:C.muted}}>{o.output_type||"—"}</td>
                              <td style={{padding:"0.35rem 0.5rem",color:C.muted}}>{o.created_at?new Date(o.created_at).toLocaleString("es-BO",{dateStyle:"short",timeStyle:"short"}):"—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                {!dbLoading && (dbDocs.length>0||dbOutputs.length>0) && (
                  <button onClick={fetchDbDocs} style={{marginTop:"0.5rem",padding:"0.3rem 0.7rem",background:"none",border:`1px solid ${C.border}`,borderRadius:"5px",color:C.muted,cursor:"pointer",fontSize:"0.7rem"}}>🔄 Actualizar</button>
                )}
              </div>
            )}
          </div>

          {/* Generate button */}
          <button onClick={run} disabled={!canRun}
            style={{width:"100%",padding:"1rem",background:canRun?C.dark:"#c0b8a5",color:canRun?C.amber:C.muted,border:"none",borderRadius:"9px",fontSize:"1rem",fontFamily:"Georgia,serif",cursor:canRun?"pointer":"not-allowed",fontWeight:"bold",letterSpacing:"0.04em",transition:"all 0.2s"}}>
            {canRun ? `🚀 Generar informe · ${validPartners.length} documento${validPartners.length!==1?"s":""} fuente` : "Suba al menos un documento fuente para continuar"}
          </button>
          {chatMsgs.filter(m=>m.role==="user").length > 0 && (
            <div style={{textAlign:"center",marginTop:"0.5rem",fontSize:"0.72rem",color:C.sage}}>📌 {chatMsgs.filter(m=>m.role==="user").length} instrucción(es) del chat serán aplicadas</div>
          )}
        </div>
      )}

      {/* ═══ RUNNING PHASE ═══ */}
      {phase==="running" && (
        <div style={{maxWidth:"880px",margin:"0 auto",padding:"2rem 1.5rem"}}>
          <h2 style={{color:C.mid,marginBottom:"1.1rem"}}>Generando informe con Gemini...</h2>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(185px,1fr))",gap:"0.46rem",marginBottom:"1.1rem"}}>
            <MCard icon="📋" label="Motor TEMPLATE" status={stats.template} active={active==="template"}/>
            {validPartners.map((_,i) => (
              <MCard key={i} icon="🔍" label={`Alpha: ${validPartners[i].label||validPartners[i].file?.name?.replace(/\.[^.]+$/,"")||`Doc ${i+1}`}`} status={stats[`alpha_${i}`]} active={active===`alpha_${i}`}/>
            ))}
            <MCard icon="🔀" label="Consolidación" status={stats.m0a} active={active==="m0a"}/>
            <MCard icon="✍️" label="Narrativa" status={stats.m0b} active={active==="m0b"}/>
            <MCard icon="✅" label="Trazabilidad" status={stats.m0c} active={active==="m0c"}/>
            <MCard icon="📊" label="Panel Ejecutivo" status={stats.m2} active={active==="m2"}/>
          </div>
          <div style={{borderRadius:"8px",overflow:"hidden",border:`1px solid ${C.dark}`}}>
            <div style={{background:C.dark,padding:"0.34rem 0.85rem",display:"flex",gap:"0.3rem",alignItems:"center"}}>
              {["#ff5f57","#febc2e","#28c840"].map(c=><span key={c} style={{width:7,height:7,borderRadius:"50%",background:c,display:"inline-block"}}/>)}
              <span style={{fontFamily:"monospace",color:"#78a888",fontSize:"0.6rem",marginLeft:"0.32rem"}}>registro del sistema</span>
            </div>
            <div ref={logRef} style={{background:C.codeBg,padding:"0.78rem 0.92rem",fontFamily:"monospace",fontSize:"0.72rem",color:C.codeText,maxHeight:"220px",overflowY:"auto",lineHeight:1.7}}>
              {logs.length===0?<span style={{opacity:.3}}>Inicializando...</span>:logs.map((l,i)=><div key={i} style={{color:l.includes("❌")?"#f09090":l.includes("⚠")?"#f0d080":C.codeText}}>{l}</div>)}
            </div>
          </div>
        </div>
      )}

      {/* ═══ RESULTS PHASE ═══ */}
      {phase==="results" && (
        <div style={{maxWidth:"1100px",margin:"0 auto",padding:"2rem 1.5rem"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"1rem",flexWrap:"wrap",gap:"0.55rem"}}>
            <h2 style={{color:C.mid,margin:0}}>Resultados{reportType ? ` — ${reportType}` : ""}</h2>
            <button onClick={resetAll} style={{padding:"0.37rem 0.82rem",background:"none",border:`1px solid ${C.mid}`,color:C.mid,borderRadius:"5px",cursor:"pointer",fontSize:"0.78rem"}}>← Nueva ejecución</button>
          </div>

          {errs.length>0 && (
            <div style={{background:C.errBg,border:"1px solid #c09090",borderRadius:"8px",padding:"0.75rem 0.95rem",marginBottom:"0.9rem"}}>
              <strong style={{color:C.errText}}>⚠ Advertencias:</strong>
              {errs.map((e,i)=><div key={i} style={{color:C.errText,fontSize:"0.78rem",marginTop:"0.18rem"}}>{e}</div>)}
            </div>
          )}

          <div style={{display:"flex",gap:"2px",borderBottom:`2px solid ${C.border}`,marginBottom:"1.1rem",overflowX:"auto",paddingBottom:"2px"}}>
            {[["m0b","✍️ Informe"],["m0c","✅ Trazabilidad"],["m2","📊 Panel Ejecutivo"],["alpha","🔍 Datos Extraídos"]].map(([id,lbl])=>(
              <button key={id} onClick={()=>setTab(id)} style={{padding:"0.42rem 0.88rem",border:"none",borderBottom:tab===id?`3px solid ${C.amber}`:"3px solid transparent",background:tab===id?C.white:"transparent",color:tab===id?C.mid:C.muted,cursor:"pointer",fontFamily:"Georgia,serif",fontSize:"0.79rem",whiteSpace:"nowrap",fontWeight:tab===id?"bold":"normal",marginBottom:"-2px"}}>{lbl}</button>
            ))}
          </div>

          {tab==="m0b" && <Editor content={get("m0b")||""} onChange={v=>set("m0b",v)} exportName={`BDM_Informe_${(reportType||"General").replace(/\s+/g,"_")}_2025`}/>}

          {tab==="m2" && (
            <div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.62rem",flexWrap:"wrap",gap:"0.42rem"}}>
                <strong style={{color:C.mid}}>Panel Ejecutivo</strong>
                <div style={{display:"flex",gap:"0.38rem"}}>
                  <button onClick={()=>dlWord(outs.m2||"","Panel_Ejecutivo_BDM_2025")} style={{padding:"0.3rem 0.78rem",background:C.amber,color:C.dark,border:"none",borderRadius:"5px",cursor:"pointer",fontSize:"0.76rem",fontWeight:"bold"}}>📄 Word</button>
                  <button onClick={()=>dlMd(outs.m2||"","Panel_Ejecutivo_BDM_2025")} style={{padding:"0.3rem 0.62rem",background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:"5px",cursor:"pointer",fontSize:"0.76rem"}}>⬇ .md</button>
                </div>
              </div>
              <pre style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:"8px",padding:"1.15rem",whiteSpace:"pre-wrap",fontFamily:"monospace",fontSize:"0.76rem",lineHeight:1.7,color:C.text,maxHeight:"560px",overflowY:"auto"}}>{outs.m2||"Sin datos."}</pre>
            </div>
          )}

          {tab==="m0c" && (
            <div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.62rem"}}>
                <strong style={{color:C.mid}}>Trazabilidad y Consistencia</strong>
                <button onClick={()=>dlMd(outs.m0c||"","BDM_Trazabilidad_2025")} style={{padding:"0.3rem 0.62rem",background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:"5px",cursor:"pointer",fontSize:"0.76rem"}}>⬇ .md</button>
              </div>
              <pre style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:"8px",padding:"1.15rem",whiteSpace:"pre-wrap",fontFamily:"monospace",fontSize:"0.76rem",lineHeight:1.7,color:C.text,maxHeight:"560px",overflowY:"auto"}}>{outs.m0c||"Sin datos."}</pre>
            </div>
          )}

          {tab==="alpha" && (
            <div>
              {(outs.alpha||[]).map((a,i) => (
                <div key={i} style={{marginBottom:"1.1rem"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.58rem"}}>
                    <strong style={{color:C.mid}}>Datos extraídos — {a.label}</strong>
                    <button onClick={()=>dlMd(JSON.stringify(a.data,null,2),`Alpha_${a.label}`)} style={{padding:"0.3rem 0.62rem",background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:"5px",cursor:"pointer",fontSize:"0.76rem"}}>⬇ .json</button>
                  </div>
                  <pre style={{background:C.codeBg,border:`1px solid ${C.dark}`,borderRadius:"8px",padding:"1.15rem",overflowX:"auto",whiteSpace:"pre-wrap",fontFamily:"monospace",fontSize:"0.74rem",lineHeight:1.6,color:C.codeText,maxHeight:"440px",overflowY:"auto"}}>{JSON.stringify(a.data,null,2)}</pre>
                </div>
              ))}
              {(!outs.alpha?.length) && <div style={{padding:"2rem",textAlign:"center",color:C.muted,fontStyle:"italic",background:C.white,borderRadius:"8px",border:`1px solid ${C.border}`}}>Sin datos extraídos.</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

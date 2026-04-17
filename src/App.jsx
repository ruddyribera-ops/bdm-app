import { useState, useRef, useEffect } from "react";
import mammoth from "mammoth/mammoth.browser";

const MODEL = "gemini-3.1-pro-preview";

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

// Convierte ArrayBuffer a base64 en bloques para evitar stack overflow con archivos grandes
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// OCR vía visión de Claude: renderiza páginas con pdf.js y las envía como imágenes
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

// Lee el archivo completo — PDFs como base64 para envío nativo a la API
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
      // Si hay muy poco texto, es un PDF escaneado — usar OCR visual
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
// API — llama a Gemini via proxy serverless (/api/generate)
// La clave de API vive en el servidor, nunca en el cliente
// ═══════════════════════════════════════════════════
async function callMotor(system, content, maxTokens = 4000, timeoutMs = 480000) {
  const token = sessionStorage.getItem("bdm_token") || "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let parts;
  if (Array.isArray(content)) {
    parts = content.map(block => {
      if (block.type === "text")     return { text: block.text };
      if (block.type === "image")    return { inline_data: { mime_type: block.source.media_type, data: block.source.data } };
      if (block.type === "document") return { inline_data: { mime_type: block.source.media_type, data: block.source.data } };
      return { text: String(block) };
    });
  } else {
    parts = [{ text: String(content) }];
  }

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: MODEL,
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e?.error?.message || e?.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error("Tiempo de espera agotado (8 min). Reintentando puede ayudar.");
    throw err;
  }
}

// Construye el contenido para la API:
// - PDFs: bloque de documento nativo (la API lee el PDF completo)
// - DOCX/texto largo: chunking automático con pre-síntesis si supera límite
async function buildContent(processed, instruction, logFn) {
  // Límite ~20 MB original → ~27 M caracteres en base64; sobre ese umbral usamos texto
  const PDF_B64_LIMIT = 27_000_000;
  if (processed.type === "pdf" && processed.b64 && processed.b64.length <= PDF_B64_LIMIT) {
    // Envío nativo: la API de Anthropic procesa el PDF completo sin truncar
    return [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: processed.b64 }
      },
      { type: "text", text: instruction }
    ];
  }

  if (processed.type === "pdf" && processed.b64 && processed.b64.length > PDF_B64_LIMIT) {
    if (logFn) logFn(`  ⚠ PDF grande (${Math.round(processed.b64.length/1_000_000)}MB en base64) → procesando como texto extraído por pdf.js`);
  }

  const text = processed.text || "";
  const CHUNK_LIMIT = 50000; // chars por chunk — Gemini soporta contexto largo

  if (text.length <= CHUNK_LIMIT) {
    return `${instruction}\n\nDocumento: ${processed.name}\n\n${text}`;
  }

  // Documento grande: pre-síntesis por fragmentos
  if (logFn) logFn(`  → Documento extenso (${Math.round(text.length/1000)}KB) — procesando en fragmentos...`);
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK_LIMIT) {
    chunks.push(text.slice(i, i + CHUNK_LIMIT));
  }

  const summaries = [];
  for (let i = 0; i < chunks.length; i++) {
    if (logFn) logFn(`  → Fragmento ${i+1}/${chunks.length}...`);
    if (i > 0) await new Promise(r => setTimeout(r, 5000)); // pausa para evitar rate limit
    const s = await callMotor(
      `Eres un asistente de síntesis. Extrae y conserva TODOS los datos cuantitativos, nombres de comunidades, beneficiarios, presupuestos, indicadores y resultados del siguiente fragmento de documento. No omitas ningún número ni cifra. Responde en español.`,
      `Fragmento ${i+1}/${chunks.length} de "${processed.name}":\n\n${chunks[i]}`,
      3000
    );
    summaries.push(s);
  }

  const combined = summaries.join("\n\n---\n\n");
  return `${instruction}\n\nDocumento: ${processed.name} (procesado en ${chunks.length} fragmentos)\n\n${combined}`;
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
Analiza la memoria del año anterior y extrae su estructura, tono institucional y secciones.
Responde SOLO JSON válido:
{"secciones":[{"nombre":"string","proposito":"string","orden":0}],"tono":"string","estilo_narrativo":"string","campos_caratula":["string"],"observaciones":"string"}`,

  alpha: `Eres el Motor Alpha 2.0 del sistema de memorias anuales de Bosques del Mundo Bolivia.
Extrae TODOS los datos estructurados del informe del socio/ejecutor. Lee el documento COMPLETO.
PROHIBIDO añadir datos externos. Si un campo no existe en el documento usa null — NUNCA uses 0 para representar ausencia de dato. 0 solo significa cero real y comprobado.
Para cada dato cuantitativo registra la fuente (sección o página aproximada).
IMPORTANTE: Busca datos en TODAS las formas posibles — tablas, listas, párrafos narrativos, cuadros de indicadores, anexos. Si hay tablas, extrae cada fila. No omitas datos por estar en formato tabular.
CAMPOS CLAVE A BUSCAR: beneficiarios directos e indirectos, desglose por género (mujeres) y edad (jóvenes), hectáreas SAF (sistemas agroforestales), injertos, cosecha, recolección, parcelas, comunidades, monitores, bomberos comunales. Si no están en el documento, usa null.
Responde SOLO JSON válido:
{"nombre_proyecto":"string","periodo":"string","periodo_inicio":"string","periodo_fin":"string","socios_ejecutores":["string"],"presupuesto_total":{"monto":null,"moneda":"string","fuente":"string"},"presupuesto_ejecutado":{"monto":null,"moneda":"string","porcentaje":null,"fuente":"string"},"estado":"en_ejecucion|concluido|por_iniciar","resultados":[{"id":1,"descripcion":"string","indicadores":[{"nombre":"string","valor":"string","meta":"string","porcentaje_avance":"string","fuente":"string"}],"beneficiarios_directos":null,"beneficiarios_indirectos":null,"mujeres":null,"jovenes":null,"comunidades":["string"],"participantes_actividades":null,"fuente":"string"}],"proyecciones":[{"tipo":"continuidad|nuevo|cierre","descripcion":"string","fuente":"string"}],"nuevos_proyectos":"string","datos_faltantes":["string"],"observaciones_financieras":"string","desafios":["string"],"oportunidades":["string"]}`,

  m0a: `Eres el Motor M0a del sistema de memorias anuales de Bosques del Mundo Bolivia.
Consolida los JSONs de todos los socios en una síntesis unificada. PROHIBIDO añadir datos externos.
ALERTA DE MONEDAS: si hay distintas monedas (DKK, USD, BOB) NO las sumes — mantenlas separadas y señala alerta explícita.
Responde SOLO JSON válido:
{"proyectos":[{"nombre":"string","estado":"string","logros_narrativos":"string","indicadores_clave":[{"indicador":"string","valor":"string","meta":"string","fuente":"string"}],"beneficiarios_directos":0,"beneficiarios_indirectos":0,"mujeres":0,"jovenes":0,"comunidades":["string"],"presupuestos":[{"monto":0,"moneda":"string","tipo":"total|ejecutado"}],"desafios":"string","oportunidades":"string"}],"procesos_internos":{"logros":"string","temas_transversales":"string"},"proyecciones":[{"proyecto":"string","tipo":"continuidad|nuevo|cierre","descripcion":"string","fuente":"string"}],"nuevos_proyectos":"string","alerta_monedas":"string","inconsistencias_detectadas":["string"],"datos_faltantes_globales":["string"]}`,

  m0b: `Eres el Motor M0b del sistema de memorias anuales de Bosques del Mundo Bolivia.
Redacta la memoria anual completa con lenguaje técnico especializado en:
- Ciencias ambientales y conservación de bosques
- Soluciones climáticas inteligentes (climate-smart solutions)
- Defensa y gobernanza territorial indígena
- Cooperación internacional para la conservación
REGLAS ABSOLUTAS:
1. PROHIBIDO añadir datos no presentes en el JSON de entrada.
2. Para CADA cifra, beneficiario, comunidad o presupuesto: inserta referencia [Socio, año, sección].
3. Español institucional boliviano. Anglicismos técnicos solo si no hay equivalente preciso.
4. Resalta cantidades, beneficiarios, presupuestos y comunidades con **negrita**.
5. Incluye tablas de indicadores para cada proyecto.
6. Si un campo es null o está ausente en el JSON: escribe "Sin datos" — NUNCA uses 0 para representar ausencia de información. 0 solo significa cero real.
7. PROHIBIDO ABSOLUTO: No menciones errores técnicos, problemas de lectura de archivos, código binario, estructuras XML/ZIP, formatos ilegibles, ni ningún tipo de falla técnica. Si un documento no aportó datos, simplemente indica que no hay información disponible para ese campo.
ESTRUCTURA OBLIGATORIA:
# 1. Introducción
# 2. Contexto institucional y marco normativo
# 3. Áreas de trabajo
# 4. Resultados por proyecto
## [Nombre del Proyecto] (una sección por proyecto)
### Indicadores clave (tabla: Indicador | Meta | Resultado | % Avance | Fuente)
### Beneficiarios y comunidades alcanzadas
### Desafíos y oportunidades
# 5. Socios ejecutores
# 6. Proyección de trabajo en el país
# 7. Conclusiones
Salida: MARKDOWN completo listo para convertir a Word/PDF.`,

  m0c: `Eres el Motor M0c del sistema de memorias anuales de Bosques del Mundo Bolivia.
Genera matriz de trazabilidad e informe de consistencia para validar la memoria anual.
- Tabla: cada dato cuantitativo en la memoria → fuente exacta en los datos de origen
- Semáforo: 🟢 dato incluido correctamente | 🟡 observación menor | 🔴 falta o es inconsistente
- Señala "ALERTA DE DATO EXTERNO" si detectas información no presente en las fuentes originales
- Al final: lista de tareas de verificación para la directora
Salida: MARKDOWN con semáforo global al inicio y tabla de trazabilidad completa.`,

  m1a: `Eres el Motor M1a del sistema de memorias anuales de Bosques del Mundo Bolivia.
Genera 3 versiones de la memoria con carátulas y énfasis diferenciados por ministerio.
USA EXACTAMENTE estos delimitadores (sin variaciones):

=== MINISTERIO DE PLANIFICACIÓN DEL DESARROLLO ===
[Ajuste: carátula dirigida al VIPFE. Énfasis en: PDES, ODS, planificación estratégica, cronograma de actividades, indicadores de desarrollo]

=== MINISTERIO DE DESARROLLO RURAL Y TIERRAS ===
[Ajuste: carátula dirigida al Director General de Planificación MDRyT. Énfasis en: gobernanza territorial, ficha técnica del proyecto, SAF, cacao silvestre, seguridad alimentaria, bomberos comunales]

=== MINISTERIO DE MEDIO AMBIENTE Y AGUA ===
[Ajuste: carátula dirigida al Viceministro MMAyA-DGF. Énfasis en: conservación de ecosistemas, biodiversidad, superficie de bosque protegida, cambio climático, monitoreo ambiental, bomberos comunales]

Al inicio de cada versión incluye bloque "## CAMBIOS REALIZADOS EN ESTA VERSIÓN".
PROHIBIDO añadir información nueva no presente en el borrador base.
PROHIBIDO ABSOLUTO: No menciones errores técnicos, problemas de archivo, código binario, estructuras XML/ZIP, ni ningún tipo de falla técnica en ninguna de las tres versiones.
OBLIGATORIO: Las tres versiones deben estar completas en la misma respuesta, separadas exactamente por los delimitadores indicados. No omitas ninguna versión.`,

  m2: `Eres el Motor M2 del sistema de memorias anuales de Bosques del Mundo Bolivia.
Genera el panel de control ejecutivo para la directora regional. Legible en menos de 5 minutos.
ESTRUCTURA:
1. **INDICADOR DE CONFIANZA** — 🟢 ALTA / 🟡 MEDIA / 🔴 BAJA con justificación en 2 líneas
2. **Resumen por proyecto** — máximo 3 logros clave en bullets por proyecto
3. **Tabla ALERTAS CRÍTICAS** — columnas: Alerta | Detalle | Acción requerida | Urgencia
4. **Cobertura ministerial** — tabla: Ministerio | Versión generada | Pendientes de adjuntar
5. **Tareas pendientes** — lista numerada de acciones antes de la presentación oficial
6. **Estado financiero** — resumen de ejecución presupuestaria por proyecto y alerta de inconsistencias
Salida: MARKDOWN ejecutivo conciso. Sin relleno.`
};

// ═══════════════════════════════════════════════════
// WORD / MD EXPORT
// ═══════════════════════════════════════════════════
function toWordHtml(md, title) {
  let h = md
    .replace(/^# (.+)$/gm, '<h1 style="font-family:Arial,sans-serif;font-size:16pt;font-weight:bold;color:#000000;border-bottom:1pt solid #000000;padding-bottom:4pt;margin-top:20pt;margin-bottom:6pt;">$1</h1>')
    .replace(/^## (.+)$/gm, '<h2 style="font-family:Arial,sans-serif;font-size:14pt;font-weight:bold;color:#000000;margin-top:14pt;margin-bottom:4pt;">$1</h2>')
    .replace(/^### (.+)$/gm, '<h3 style="font-family:Arial,sans-serif;font-size:12pt;font-weight:bold;color:#000000;margin-top:10pt;margin-bottom:3pt;">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^---$/gm, '<hr style="border:0.5pt solid #000000;margin:8pt 0;"/>')
    .replace(/^\| (.+) \|$/gm, row => {
      const cells = row.split('|').slice(1,-1).map(c=>c.trim());
      if (cells.every(c=>c.match(/^[-:]+$/))) return '';
      return '<tr>' + cells.map(c=>`<td style="border:1pt solid #000000;padding:5pt 8pt;font-family:Arial,sans-serif;font-size:13px;color:#000000;">${c}</td>`).join('') + '</tr>';
    })
    .replace(/(<tr>.*?<\/tr>\n?)+/gs, m=>`<table style="border-collapse:collapse;width:100%;margin:8pt 0;">${m}</table>`)
    .replace(/^[-*] (.+)$/gm, '<li style="font-family:Arial,sans-serif;font-size:13px;color:#000000;margin-bottom:3pt;">$1</li>')
    .replace(/(<li[^>]*>.*?<\/li>\n?)+/gs, m=>`<ul style="margin:4pt 0 4pt 18pt;">${m}</ul>`)
    .replace(/\[([^\]]+),\s*[\d]+,\s*([^\]]+)\]/g, '<span style="color:#555555;font-size:10px;font-style:italic;">[$1, $2]</span>')
    .replace(/^(?!<[hult]|<\/|$)(.+)$/gm, '<p style="font-family:Arial,sans-serif;font-size:13px;color:#000000;line-height:1.6;margin:4pt 0;">$1</p>');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>
<style>body{font-family:Arial,sans-serif;font-size:13px;color:#000000;margin:2.5cm 2cm;}@page{margin:2.5cm 2cm;}table{border-collapse:collapse;width:100%;}td,th{border:1pt solid #000000;padding:5pt 8pt;font-family:Arial,sans-serif;font-size:13px;color:#000000;}</style>
</head><body>
<div style="border-bottom:2pt solid #000000;padding-bottom:10pt;margin-bottom:20pt;">
<p style="font-family:Arial,sans-serif;font-size:18pt;font-weight:bold;color:#000000;margin:0;">Bosques del Mundo Bolivia</p>
<p style="font-family:Arial,sans-serif;font-size:11pt;color:#333333;margin:4pt 0 0;">${title}</p>
</div>${h}
<hr style="margin-top:22pt;border:0.5pt solid #999999;"/>
<p style="color:#666666;font-size:10px;font-family:Arial,sans-serif;text-align:center;">Sistema de Memorias Anuales BdM · Pipeline IA v2.0 · Gemini</p>
</body></html>`;
}
function dlWord(c, n) {
  if(!c) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([toWordHtml(c,n)],{type:"application/msword"}));
  a.download = n+".doc"; a.click();
}
function dlMd(c, n) {
  if(!c) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([c],{type:"text/plain;charset=utf-8"}));
  a.download = n+".md"; a.click();
}
function extractMin(content, key) {
  if (!content) return null;
  const d = `=== MINISTERIO DE ${key} ===`;
  const idx = content.indexOf(d);
  if (idx === -1) return null;
  const start = idx + d.length;
  const keys = ["PLANIFICACIÓN DEL DESARROLLO","DESARROLLO RURAL Y TIERRAS","MEDIO AMBIENTE Y AGUA"];
  let end = content.length;
  keys.filter(k=>k!==key).forEach(k=>{
    const ni = content.indexOf(`=== MINISTERIO DE ${k} ===`, start);
    if (ni !== -1 && ni < end) end = ni;
  });
  return content.slice(start, end).trim();
}

const C = {
  bg:"#f0ebe0", white:"#faf8f2", dark:"#0c1e12", mid:"#194a2c",
  sage:"#4a7c5a", amber:"#c8a020",
  text:"#16160c", muted:"#617063", border:"#cac2ae",
  codeBg:"#0f1c13", codeText:"#a0c0a8",
  errBg:"#f8ecec", errText:"#7a2020",
};

function DropZone({ file, onFile, label, hint }) {
  const ref = useRef(null);
  const [drag, setDrag] = useState(false);
  const handle = f => { if(f) onFile(f); };
  return (
    <div onClick={()=>ref.current?.click()}
      onDragOver={e=>{e.preventDefault();setDrag(true);}}
      onDragLeave={()=>setDrag(false)}
      onDrop={e=>{e.preventDefault();setDrag(false);handle(e.dataTransfer.files[0]);}}
      style={{border:`2px dashed ${drag?C.amber:file?C.sage:C.border}`,borderRadius:"8px",padding:"0.85rem 1rem",cursor:"pointer",background:drag?"#eef8f2":file?"#eaf4ee":C.white,display:"flex",alignItems:"center",gap:"0.7rem",minHeight:"50px",transition:"all 0.15s"}}>
      <input ref={ref} type="file" accept=".pdf,.docx,.txt,.xlsx" style={{display:"none"}} onChange={e=>handle(e.target.files[0])}/>
      <span style={{fontSize:"1.3rem",flexShrink:0}}>{file?"📄":"📂"}</span>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:"0.84rem",fontWeight:file?"bold":"normal",color:file?C.mid:C.muted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{file?file.name:label}</div>
        {!file&&hint&&<div style={{fontSize:"0.7rem",color:C.muted,marginTop:"1px"}}>{hint}</div>}
        {file&&<div style={{fontSize:"0.7rem",color:C.sage,marginTop:"1px"}}>✓ {(file.size/1024).toFixed(0)} KB · listo</div>}
      </div>
      {file?<button onClick={e=>{e.stopPropagation();onFile(null);}} style={{background:"none",border:"none",cursor:"pointer",color:C.muted,fontSize:"1.1rem",padding:"0 2px",lineHeight:1}}>×</button>
           :<span style={{fontSize:"0.67rem",color:C.muted,fontFamily:"monospace",flexShrink:0}}>PDF·DOCX·TXT</span>}
    </div>
  );
}

function PartnerRow({ p, i, onChange, onRemove, canRemove }) {
  const ref = useRef(null);
  const [drag, setDrag] = useState(false);
  const handle = f => { if(f) onChange(i,"file",f); };
  return (
    <div style={{display:"flex",gap:"0.5rem",alignItems:"center",marginBottom:"0.5rem"}}>
      <input value={p.label} onChange={e=>onChange(i,"label",e.target.value)} placeholder="Nombre del socio"
        style={{width:"155px",flexShrink:0,padding:"0.42rem 0.6rem",border:`1px solid ${C.border}`,borderRadius:"6px",fontFamily:"Georgia,serif",fontSize:"0.83rem",background:C.white,color:C.text}}/>
      <div onClick={()=>ref.current?.click()}
        onDragOver={e=>{e.preventDefault();setDrag(true);}}
        onDragLeave={()=>setDrag(false)}
        onDrop={e=>{e.preventDefault();setDrag(false);handle(e.dataTransfer.files[0]);}}
        style={{flex:1,border:`2px dashed ${drag?C.amber:p.file?C.sage:C.border}`,borderRadius:"7px",padding:"0.48rem 0.8rem",cursor:"pointer",background:drag?"#eef8f2":p.file?"#eaf4ee":C.white,display:"flex",alignItems:"center",gap:"0.48rem",transition:"all 0.15s",minHeight:"40px"}}>
        <input ref={ref} type="file" accept=".pdf,.docx,.txt" style={{display:"none"}} onChange={e=>handle(e.target.files[0])}/>
        <span style={{fontSize:"0.95rem"}}>{p.file?"📄":"📂"}</span>
        <span style={{fontSize:"0.8rem",color:p.file?C.mid:C.muted,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.file?p.file.name:"Clic o arrastre el informe aquí"}</span>
        {p.file&&<span style={{fontSize:"0.67rem",color:C.sage,flexShrink:0}}>✓ {(p.file.size/1024).toFixed(0)}KB</span>}
      </div>
      {canRemove&&<button onClick={()=>onRemove(i)} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:"6px",cursor:"pointer",color:C.muted,fontSize:"1rem",padding:"0.42rem 0.52rem",flexShrink:0,lineHeight:1}}>×</button>}
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
            <button key={m} onClick={()=>setMode(m)} style={{padding:"0.3rem 0.72rem",background:mode===m?C.mid:"transparent",color:mode===m?"#f0ebe0":C.muted,border:"none",cursor:"pointer",fontSize:"0.76rem",transition:"all 0.15s"}}>{l}</button>
          ))}
        </div>
        <div style={{display:"flex",gap:"0.38rem"}}>
          <button onClick={()=>dlWord(content,exportName)} style={{padding:"0.3rem 0.78rem",background:C.amber,color:C.dark,border:"none",borderRadius:"5px",cursor:"pointer",fontSize:"0.76rem",fontWeight:"bold"}}>📄 Exportar Word</button>
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

const MK = ["PLANIFICACIÓN DEL DESARROLLO","DESARROLLO RURAL Y TIERRAS","MEDIO AMBIENTE Y AGUA"];
const MS = ["Planificación","Desarrollo Rural","Medio Ambiente"];

function PasswordGate({ onAuth }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Contraseña incorrecta"); return; }
      onAuth(data.token);
    } catch {
      setError("Error de conexión. Intente nuevamente.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{fontFamily:"Georgia,'Times New Roman',serif",background:C.bg,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:"12px",padding:"2.5rem",width:"100%",maxWidth:"360px",boxShadow:"0 4px 24px rgba(0,0,0,0.08)"}}>
        <div style={{textAlign:"center",marginBottom:"1.8rem"}}>
          <span style={{fontSize:"2.5rem"}}>🌿</span>
          <div style={{color:C.mid,fontSize:"1.1rem",fontWeight:"bold",marginTop:"0.5rem"}}>Bosques del Mundo Bolivia</div>
          <div style={{color:C.muted,fontSize:"0.75rem",marginTop:"0.25rem"}}>Sistema de Memorias Anuales</div>
        </div>
        <form onSubmit={submit}>
          <input
            type="password"
            value={pw}
            onChange={e=>setPw(e.target.value)}
            placeholder="Contraseña de acceso"
            autoFocus
            style={{width:"100%",padding:"0.7rem 0.9rem",border:`1px solid ${error?C.errText:C.border}`,borderRadius:"7px",fontFamily:"Georgia,serif",fontSize:"0.9rem",background:C.white,color:C.text,boxSizing:"border-box",marginBottom:"0.75rem",outline:"none"}}
          />
          {error&&<div style={{color:C.errText,fontSize:"0.78rem",marginBottom:"0.6rem"}}>{error}</div>}
          <button type="submit" disabled={loading||!pw}
            style={{width:"100%",padding:"0.75rem",background:pw&&!loading?C.dark:"#c0b8a5",color:pw&&!loading?C.amber:C.muted,border:"none",borderRadius:"7px",fontSize:"0.9rem",fontFamily:"Georgia,serif",cursor:pw&&!loading?"pointer":"not-allowed",fontWeight:"bold",transition:"all 0.2s"}}>
            {loading?"Verificando...":"Ingresar"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem("bdm_token") || "");
  const [phase, setPhase]       = useState("setup");
  const [tplFile, setTplFile]   = useState(null);
  const [finFile, setFinFile]   = useState(null);
  const [partners, setPartners] = useState([{label:"",file:null},{label:"",file:null}]);
  const [outs, setOuts]         = useState({});
  const [edits, setEdits]       = useState({});
  const [stats, setStats]       = useState({});
  const [active, setActive]     = useState(null);
  const [logs, setLogs]         = useState([]);
  const [errs, setErrs]         = useState([]);
  const [tab, setTab]           = useState("m2");
  const [selMin, setSelMin]     = useState(0);
  const [editMins, setEditMins] = useState({});
  const logRef = useRef(null);

  const log = msg => setLogs(p=>{
    const n=[...p,`[${new Date().toLocaleTimeString("es-BO")}] ${msg}`];
    setTimeout(()=>logRef.current?.scrollTo(0,9999),50);
    return n;
  });
  const setSt=(id,s)=>setStats(p=>({...p,[id]:s}));
  const setOut=(id,v)=>setOuts(p=>({...p,[id]:v}));
  const get=key=>edits[key]!==undefined?edits[key]:outs[key];
  const set=(key,val)=>setEdits(p=>({...p,[key]:val}));
  const upP=(i,f,v)=>setPartners(p=>p.map((x,j)=>j===i?{...x,[f]:v}:x));
  const rmP=i=>setPartners(p=>p.filter((_,j)=>j!==i));
  const addP=()=>setPartners(p=>[...p,{label:"",file:null}]);

  const valid = partners.filter(p=>p.file);
  const canRun = valid.length > 0;

  if (!token) return <PasswordGate onAuth={t => { sessionStorage.setItem("bdm_token", t); setToken(t); }} />;

  const run = async () => {
    if (!canRun) return;
    setPhase("running"); setLogs([]); setErrs([]); setStats({}); setOuts({}); setEdits({}); setEditMins({});
    const errors=[], o={};

    try {
      // TEMPLATE
      if (tplFile) {
        setActive("template"); setSt("template","running");
        log("Motor TEMPLATE: Leyendo plantilla base...");
        try {
          const pf = await readFile(tplFile, log);
          log(`Motor TEMPLATE: ${pf.type==="pdf"?`PDF completo (${pf.pages} pág.)`:"Documento"} — analizando estructura...`);
          const content = await buildContent(pf, "Analiza esta memoria anual y extrae su estructura, tono y secciones.", log);
          log("Motor TEMPLATE: Enviando a Gemini, esperando respuesta...");
          const raw = await callMotor(P.template, content, 1500);
          const p = tryJSON(raw);
          o.template = p.ok ? p.data : raw;
          setOut("template",o.template); setSt("template","done");
          log("Motor TEMPLATE: ✓ Estructura extraída.");
        } catch(e) {
          setSt("template","skipped");
          log(`Motor TEMPLATE: ⚠ Omitido (${e.message}) — el pipeline continúa.`);
        }
      } else { setSt("template","skipped"); log("Motor TEMPLATE: Omitido (sin plantilla)."); }

      // ALPHA × socios — documentos completos
      o.alpha = [];
      for (let i=0; i<valid.length; i++) {
        const sp=valid[i], mid=`alpha_${i}`;
        const lbl = sp.label.trim() || sp.file.name.replace(/\.[^.]+$/,"");
        setActive(mid); setSt(mid,"running");
        log(`Alpha 2.0 [${lbl}]: Leyendo documento completo...`);
        const pf = await readFile(sp.file, log);
        const sizeInfo = pf.type==="pdf" ? `PDF ${pf.pages} pág.` : `${Math.round(pf.text.length/1000)}KB texto`;
        log(`Alpha 2.0 [${lbl}]: ${sizeInfo} — extrayendo datos...`);
        const content = await buildContent(pf, `Extrae TODOS los datos estructurados de este informe del socio "${lbl}". Lee el documento completo sin omitir nada.`, log);
        log(`Alpha 2.0 [${lbl}]: Enviando a Gemini, esperando respuesta...`);
        const raw = await callMotor(P.alpha, content, 8000);
        const p = tryJSON(raw);
        if (!p.ok) { errors.push(`Alpha [${lbl}]: ${p.err}`); setSt(mid,"error"); }
        else setSt(mid,"done");
        o.alpha.push({ label: lbl, data: p.ok?p.data:{raw:p.data,parse_error:true} });
        setOut("alpha",[...o.alpha]);
        log(`Alpha 2.0 [${lbl}]: ${p.ok?"✓":"⚠"} Completado.`);
      }

      // Informe financiero
      let finCtx = "";
      if (finFile) {
        log("Leyendo informe financiero completo...");
        try {
          const pf = await readFile(finFile, log);
          const content = await buildContent(pf, "Extrae todos los datos financieros: presupuestos, ejecución, rubros, monedas.", log);
          finCtx = typeof content === "string"
            ? `\n\nINFORME FINANCIERO:\n${content.slice(0,6000)}`
            : `\n\nINFORME FINANCIERO: adjunto como documento.`;
        } catch(e) {
          log(`Financiero: ⚠ ${e.message}`);
        }
      }

      const aStr = JSON.stringify(o.alpha.map(a=>({socio:a.label,...a.data})), null, 2);

      // M0a
      setActive("m0a"); setSt("m0a","running");
      log("M0a: Consolidando datos de todos los socios... (esperando Gemini)");
      const m0aR = await callMotor(P.m0a, `Consolida estos datos:\n\n${aStr}${finCtx}`, 8000);
      const m0aP = tryJSON(m0aR); o.m0a = m0aP.ok ? m0aP.data : {raw:m0aR};
      setOut("m0a",o.m0a); setSt("m0a",m0aP.ok?"done":"error");
      log(`M0a: ${m0aP.ok?"✓":"⚠"} Consolidación completada.`);

      // M0b
      setActive("m0b"); setSt("m0b","running");
      log("M0b: Redactando memoria anual narrativa completa... (esperando Gemini, puede tardar 2-3 min)");
      const tpl = o.template ? `\n\nESTRUCTURA BASE:\n${JSON.stringify(o.template,null,2)}` : "";
      const m0bR = await callMotor(P.m0b, `Genera la memoria EXCLUSIVAMENTE con estos datos:\n\n${JSON.stringify(o.m0a,null,2)}${tpl}`, 8000);
      o.m0b = m0bR; setOut("m0b",m0bR); setSt("m0b","done");
      log("M0b: ✓ Memoria narrativa generada.");

      // M0c
      setActive("m0c"); setSt("m0c","running");
      log("M0c: Verificando trazabilidad y consistencia...");
      const m0cR = await callMotor(P.m0c, `MEMORIA:\n${o.m0b}\n\n---\nDATOS ORIGINALES:\n${aStr}`, 6000);
      o.m0c = m0cR; setOut("m0c",m0cR); setSt("m0c","done");
      log("M0c: ✓ Trazabilidad completada.");

      // M1a
      setActive("m1a"); setSt("m1a","running");
      log("M1a: Generando versiones para los tres ministerios...");
      const m1aR = await callMotor(P.m1a, `BORRADOR BASE:\n\n${o.m0b}`, 8000);
      o.m1a = m1aR; setOut("m1a",m1aR); setSt("m1a","done");
      log("M1a: ✓ Tres versiones ministeriales generadas.");

      // M2
      setActive("m2"); setSt("m2","running");
      log("M2: Generando panel ejecutivo para la directora...");
      const m2R = await callMotor(P.m2, `TRAZABILIDAD:\n${o.m0c}\n\n---\nMINISTERIOS:\n${o.m1a}`, 4000);
      o.m2 = m2R; setOut("m2",m2R); setSt("m2","done");
      log("M2: ✓ Panel ejecutivo listo.");

      setActive(null); setErrs(errors); setPhase("results"); setTab("m2");
      log("══════ PIPELINE COMPLETADO ══════");

    } catch(err) {
      errors.push(`Error: ${err.message}`);
      setErrs(errors); setActive(null);
      log(`❌ Error: ${err.message}`);
      setPhase("results");
    }
  };

  const getMin = i => {
    const r = extractMin(outs.m1a, MK[i]);
    return editMins[i]!==undefined ? editMins[i] : r;
  };
  const resetAll = () => {
    setPhase("setup"); setOuts({}); setEdits({}); setStats({});
    setLogs([]); setErrs([]); setEditMins({}); setActive(null);
  };

  return (
    <div style={{fontFamily:"Georgia,'Times New Roman',serif",background:C.bg,minHeight:"100vh",color:C.text}}>

      <header style={{background:C.dark,borderBottom:`3px solid ${C.amber}`,padding:"0.82rem 1.5rem",display:"flex",alignItems:"center",gap:"1rem",flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:"0.7rem"}}>
          <span style={{fontSize:"1.7rem"}}>🌿</span>
          <div>
            <div style={{color:C.amber,fontSize:"1.02rem",fontWeight:"bold"}}>Bosques del Mundo Bolivia</div>
            <div style={{color:"#78a888",fontSize:"0.6rem",fontFamily:"monospace",letterSpacing:"0.12em"}}>SISTEMA DE MEMORIAS ANUALES · PIPELINE IA · Gemini</div>
          </div>
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:"3px"}}>
          {[["setup","① Documentos"],["running","② Procesamiento"],["results","③ Resultados"]].map(([id,lbl],i)=>{
            const idx=["setup","running","results"].indexOf(phase);
            return <span key={id} style={{padding:"0.2rem 0.58rem",borderRadius:"999px",fontSize:"0.62rem",fontFamily:"monospace",background:phase===id?C.amber:idx>i?C.mid:"rgba(255,255,255,0.07)",color:phase===id?C.dark:idx>i?"#90c8a0":"rgba(255,255,255,0.26)",fontWeight:phase===id?"bold":"normal"}}>{lbl}</span>;
          })}
        </div>
      </header>

      {phase==="setup" && (
        <div style={{maxWidth:"760px",margin:"0 auto",padding:"2rem 1.5rem"}}>

          <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:"10px",padding:"1.2rem",marginBottom:"0.9rem"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.5rem"}}>
              <h3 style={{color:C.mid,margin:0,fontSize:"0.92rem"}}>📋 Memoria del año anterior</h3>
              <span style={{color:C.muted,fontSize:"0.71rem",fontStyle:"italic"}}>opcional</span>
            </div>
            <p style={{color:C.muted,fontSize:"0.78rem",margin:"0 0 0.6rem 0"}}>El sistema aprenderá el formato y tono institucional. Documentos grandes son procesados completamente.</p>
            <DropZone file={tplFile} onFile={setTplFile} label="Subir memoria del año anterior" hint="PDF, Word o texto — procesado completo sin límite de páginas"/>
          </div>

          <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:"10px",padding:"1.2rem",marginBottom:"0.9rem"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.5rem"}}>
              <h3 style={{color:C.mid,margin:0,fontSize:"0.92rem"}}>💰 Informe financiero</h3>
              <span style={{color:C.muted,fontSize:"0.71rem",fontStyle:"italic"}}>opcional</span>
            </div>
            <p style={{color:C.muted,fontSize:"0.78rem",margin:"0 0 0.6rem 0"}}>Detalle de ejecución presupuestaria. Alimenta el análisis financiero del panel ejecutivo.</p>
            <DropZone file={finFile} onFile={setFinFile} label="Subir informe financiero" hint="XLSX, PDF o texto"/>
          </div>

          <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:"10px",padding:"1.2rem",marginBottom:"0.9rem"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.5rem"}}>
              <h3 style={{color:C.mid,margin:0,fontSize:"0.92rem"}}>📁 Informes de socios / ejecutores</h3>
              <span style={{color:"#c04040",fontSize:"0.71rem"}}>requerido</span>
            </div>
            <p style={{color:C.muted,fontSize:"0.78rem",margin:"0 0 0.75rem 0"}}>Un archivo por cada socio. El nombre es opcional. Documentos de cualquier tamaño son procesados completos.</p>
            {partners.map((p,i)=>(
              <PartnerRow key={i} p={p} i={i} onChange={upP} onRemove={rmP} canRemove={partners.length>1}/>
            ))}
            <button onClick={addP} style={{marginTop:"0.2rem",padding:"0.38rem 0.8rem",background:"none",border:`1px dashed ${C.sage}`,borderRadius:"6px",color:C.mid,cursor:"pointer",fontSize:"0.78rem"}}>+ Agregar otro socio</button>
          </div>

          <button onClick={run} disabled={!canRun}
            style={{width:"100%",padding:"1rem",background:canRun?C.dark:"#c0b8a5",color:canRun?C.amber:C.muted,border:"none",borderRadius:"9px",fontSize:"1rem",fontFamily:"Georgia,serif",cursor:canRun?"pointer":"not-allowed",fontWeight:"bold",letterSpacing:"0.04em",transition:"all 0.2s"}}>
            {canRun?`🚀 Generar Memoria Anual · ${valid.length} archivo${valid.length!==1?"s":""} cargado${valid.length!==1?"s":""}`:"Suba al menos un informe de socio para continuar"}
          </button>
        </div>
      )}

      {phase==="running" && (
        <div style={{maxWidth:"880px",margin:"0 auto",padding:"2rem 1.5rem"}}>
          <h2 style={{color:C.mid,marginBottom:"1.1rem"}}>Generando memoria anual con Gemini...</h2>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(185px,1fr))",gap:"0.46rem",marginBottom:"1.1rem"}}>
            <MCard icon="📋" label="Motor TEMPLATE" status={stats.template} active={active==="template"}/>
            {valid.map((sp,i)=>(
              <MCard key={i} icon="🔍" label={`Alpha: ${sp.label||sp.file?.name?.replace(/\.[^.]+$/,"")||`Socio ${i+1}`}`} status={stats[`alpha_${i}`]} active={active===`alpha_${i}`}/>
            ))}
            <MCard icon="🔀" label="M0a · Consolidación" status={stats.m0a} active={active==="m0a"}/>
            <MCard icon="✍️" label="M0b · Narrativa" status={stats.m0b} active={active==="m0b"}/>
            <MCard icon="✅" label="M0c · Trazabilidad" status={stats.m0c} active={active==="m0c"}/>
            <MCard icon="🏛️" label="M1a · Ministerios" status={stats.m1a} active={active==="m1a"}/>
            <MCard icon="📊" label="M2 · Panel Ejecutivo" status={stats.m2} active={active==="m2"}/>
          </div>
          <div style={{borderRadius:"8px",overflow:"hidden",border:`1px solid ${C.dark}`}}>
            <div style={{background:C.dark,padding:"0.34rem 0.85rem",display:"flex",gap:"0.3rem",alignItems:"center"}}>
              {["#ff5f57","#febc2e","#28c840"].map(c=><span key={c} style={{width:7,height:7,borderRadius:"50%",background:c,display:"inline-block"}}/>)}
              <span style={{fontFamily:"monospace",color:"#78a888",fontSize:"0.6rem",marginLeft:"0.32rem"}}>registro del sistema · gemini</span>
            </div>
            <div ref={logRef} style={{background:C.codeBg,padding:"0.78rem 0.92rem",fontFamily:"monospace",fontSize:"0.72rem",color:C.codeText,maxHeight:"220px",overflowY:"auto",lineHeight:1.7}}>
              {logs.length===0?<span style={{opacity:.3}}>Inicializando motores...</span>:logs.map((l,i)=><div key={i} style={{color:l.includes("❌")?"#f09090":l.includes("⚠")?"#f0d080":C.codeText}}>{l}</div>)}
            </div>
          </div>
        </div>
      )}

      {phase==="results" && (
        <div style={{maxWidth:"1100px",margin:"0 auto",padding:"2rem 1.5rem"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"1rem",flexWrap:"wrap",gap:"0.55rem"}}>
            <h2 style={{color:C.mid,margin:0}}>Resultados</h2>
            <button onClick={resetAll} style={{padding:"0.37rem 0.82rem",background:"none",border:`1px solid ${C.mid}`,color:C.mid,borderRadius:"5px",cursor:"pointer",fontSize:"0.78rem"}}>← Nueva ejecución</button>
          </div>
          {errs.length>0&&<div style={{background:C.errBg,border:"1px solid #c09090",borderRadius:"8px",padding:"0.75rem 0.95rem",marginBottom:"0.9rem"}}>
            <strong style={{color:C.errText}}>⚠ Advertencias:</strong>
            {errs.map((e,i)=><div key={i} style={{color:C.errText,fontSize:"0.78rem",marginTop:"0.18rem"}}>{e}</div>)}
          </div>}
          <div style={{display:"flex",gap:"2px",borderBottom:`2px solid ${C.border}`,marginBottom:"1.1rem",overflowX:"auto",paddingBottom:"2px"}}>
            {[["m2","📊 Panel Ejecutivo"],["m0b","✍️ Memoria Anual"],["m1a","🏛️ Ministerios"],["m0c","✅ Trazabilidad"],["alpha","🔍 Datos Extraídos"]].map(([id,lbl])=>(
              <button key={id} onClick={()=>setTab(id)} style={{padding:"0.42rem 0.88rem",border:"none",borderBottom:tab===id?`3px solid ${C.amber}`:"3px solid transparent",background:tab===id?C.white:"transparent",color:tab===id?C.mid:C.muted,cursor:"pointer",fontFamily:"Georgia,serif",fontSize:"0.79rem",whiteSpace:"nowrap",fontWeight:tab===id?"bold":"normal",marginBottom:"-2px"}}>{lbl}</button>
            ))}
          </div>
          {tab==="m2"&&(<div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.62rem",flexWrap:"wrap",gap:"0.42rem"}}>
              <strong style={{color:C.mid}}>Panel Ejecutivo — Directora Regional</strong>
              <div style={{display:"flex",gap:"0.38rem"}}>
                <button onClick={()=>dlWord(outs.m2||"","Panel_Ejecutivo_BDM_2025")} style={{padding:"0.3rem 0.78rem",background:C.amber,color:C.dark,border:"none",borderRadius:"5px",cursor:"pointer",fontSize:"0.76rem",fontWeight:"bold"}}>📄 Exportar Word</button>
                <button onClick={()=>dlMd(outs.m2||"","Panel_Ejecutivo_BDM_2025")} style={{padding:"0.3rem 0.62rem",background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:"5px",cursor:"pointer",fontSize:"0.76rem"}}>⬇ .md</button>
              </div>
            </div>
            <pre style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:"8px",padding:"1.15rem",whiteSpace:"pre-wrap",fontFamily:"monospace",fontSize:"0.76rem",lineHeight:1.7,color:C.text,maxHeight:"560px",overflowY:"auto"}}>{outs.m2||"Sin datos."}</pre>
          </div>)}
          {tab==="m0b"&&<Editor content={get("m0b")||""} onChange={v=>set("m0b",v)} exportName="Memoria_Anual_BDM_2025"/>}
          {tab==="m1a"&&(<div>
            <div style={{display:"flex",gap:"3px",marginBottom:"0.78rem",flexWrap:"wrap"}}>
              {MS.map((lbl,i)=>(
                <button key={i} onClick={()=>setSelMin(i)} style={{padding:"0.34rem 0.75rem",border:`1px solid ${selMin===i?C.mid:C.border}`,borderRadius:"5px",background:selMin===i?C.mid:C.white,color:selMin===i?"#f2ede3":C.muted,cursor:"pointer",fontSize:"0.75rem"}}>{lbl}</button>
              ))}
            </div>
            {getMin(selMin)
              ?<Editor content={getMin(selMin)} onChange={v=>setEditMins(p=>({...p,[selMin]:v}))} exportName={`BDM_2025_Min_${MS[selMin].replace(/ /g,"_")}`}/>
              :<div style={{padding:"2rem",textAlign:"center",color:C.muted,fontStyle:"italic",background:C.white,borderRadius:"8px",border:`1px solid ${C.border}`}}>Sección no encontrada.</div>
            }
            <button onClick={()=>outs.m1a&&dlMd(outs.m1a,"BDM_Versiones_Ministeriales_2025")} style={{marginTop:"0.68rem",padding:"0.3rem 0.75rem",background:"none",border:`1px solid ${C.mid}`,color:C.mid,borderRadius:"5px",cursor:"pointer",fontSize:"0.76rem"}}>⬇ Descargar todas (.md)</button>
          </div>)}
          {tab==="m0c"&&(<div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.62rem"}}>
              <strong style={{color:C.mid}}>Informe de Trazabilidad y Consistencia</strong>
              <button onClick={()=>dlMd(outs.m0c||"","BDM_Trazabilidad_2025")} style={{padding:"0.3rem 0.62rem",background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:"5px",cursor:"pointer",fontSize:"0.76rem"}}>⬇ .md</button>
            </div>
            <pre style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:"8px",padding:"1.15rem",whiteSpace:"pre-wrap",fontFamily:"monospace",fontSize:"0.76rem",lineHeight:1.7,color:C.text,maxHeight:"560px",overflowY:"auto"}}>{outs.m0c||"Sin datos."}</pre>
          </div>)}
          {tab==="alpha"&&(<div>
            {(outs.alpha||[]).map((a,i)=>(
              <div key={i} style={{marginBottom:"1.1rem"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.58rem"}}>
                  <strong style={{color:C.mid}}>Datos extraídos — {a.label}</strong>
                  <button onClick={()=>dlMd(JSON.stringify(a.data,null,2),`Alpha_${a.label}`)} style={{padding:"0.3rem 0.62rem",background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:"5px",cursor:"pointer",fontSize:"0.76rem"}}>⬇ .json</button>
                </div>
                <pre style={{background:C.codeBg,border:`1px solid ${C.dark}`,borderRadius:"8px",padding:"1.15rem",overflowX:"auto",whiteSpace:"pre-wrap",fontFamily:"monospace",fontSize:"0.74rem",lineHeight:1.6,color:C.codeText,maxHeight:"440px",overflowY:"auto"}}>{JSON.stringify(a.data,null,2)}</pre>
              </div>
            ))}
            {(!outs.alpha?.length)&&<div style={{padding:"2rem",textAlign:"center",color:C.muted,fontStyle:"italic",background:C.white,borderRadius:"8px",border:`1px solid ${C.border}`}}>Sin datos extraídos.</div>}
          </div>)}
        </div>
      )}
    </div>
  );
}

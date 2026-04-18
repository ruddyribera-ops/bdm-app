import { useState, useRef, useEffect } from "react";

// Theme & Config
import { THEME as C, SESSION_MAX_AGE_MS } from "./theme/index.js";

// Prompts
import { PROMPTS as P } from "./prompts/index.js";

// Services
import { callMotor, buildContent, tryJSON } from "./services/api.js";
import { readFile } from "./services/fileParser.js";

// Components
import {
  StickyNote,
  FileRow,
  DropZone,
  Editor,
  MCard,
  PasswordGate
} from "./components/index.js";

// Utils
import { getStoredToken, saveTokenForMonth, clearAuth } from "./utils/auth.js";
import { dlWord, dlMd } from "./utils/exportHelpers.js";

// ═══════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════
export default function App() {
  const [token, setToken] = useState(() => getStoredToken());
  const [phase, setPhase] = useState("setup");

  // Inputs
  const [templates, setTemplates] = useState([{ label: "", file: null }]);
  const [partners, setPartners] = useState([{ label: "", file: null }, { label: "", file: null }]);
  const [finFiles, setFinFiles] = useState([{ label: "", file: null }]);
  const [plantillaFile, setPlantillaFile] = useState(null);
  const [reportType, setReportType] = useState("");
  const [includeM2, setIncludeM2] = useState(true);

  // Chat
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMsgs, setChatMsgs] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  // UI State
  const [dismissed, setDismissed] = useState({});
  const [outs, setOuts] = useState({});
  const [edits, setEdits] = useState({});
  const [stats, setStats] = useState({});
  const [active, setActive] = useState(null);
  const [logs, setLogs] = useState([]);
  const [errs, setErrs] = useState([]);
  const [tab, setTab] = useState("m0b");

  const logRef = useRef(null);
  const chatEndRef = useRef(null);

  // Helpers
  const dismiss = id => setDismissed(p => ({ ...p, [id]: true }));
  const setSt = (id, s) => setStats(p => ({ ...p, [id]: s }));
  const setOut = (id, v) => setOuts(p => ({ ...p, [id]: v }));
  const get = key => edits[key] !== undefined ? edits[key] : outs[key];
  const set = (key, val) => setEdits(p => ({ ...p, [key]: val }));
  const log = msg => setLogs(p => {
    const n = [...p, `[${new Date().toLocaleTimeString("es-BO")}] ${msg}`];
    setTimeout(() => logRef.current?.scrollTo(0, 9999), 50);
    return n;
  });

  // Template helpers
  const upT = (i, f, v) => setTemplates(p => p.map((x, j) => j === i ? { ...x, [f]: v } : x));
  const rmT = i => setTemplates(p => p.filter((_, j) => j !== i));
  const addT = () => setTemplates(p => [...p, { label: "", file: null }]);

  // Partner helpers
  const upP = (i, f, v) => setPartners(p => p.map((x, j) => j === i ? { ...x, [f]: v } : x));
  const rmP = i => setPartners(p => p.filter((_, j) => j !== i));
  const addP = () => setPartners(p => [...p, { label: "", file: null }]);

  // Financial helpers
  const upF = (i, f, v) => setFinFiles(p => p.map((x, j) => j === i ? { ...x, [f]: v } : x));
  const rmF = i => setFinFiles(p => p.filter((_, j) => j !== i));
  const addF = () => setFinFiles(p => [...p, { label: "", file: null }]);

  const selectedTemplates = templates.filter((t) => t.file);
  const validPartners = partners.filter(p => p.file);
  const canRun = validPartners.length > 0;

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMsgs]);

  // Send chat message
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

  // Logout handler
  const handleLogout = () => {
    clearAuth();
    setToken("");
    setPhase("setup");
  };

  if (!token) return <PasswordGate onAuth={t => { saveTokenForMonth(t); setToken(t); }} />;

  // ═══════════════════════════════════════════════════
  // PIPELINE RUN
  // ═══════════════════════════════════════════════════
  const run = async () => {
    if (!canRun) return;
    setPhase("running"); setLogs([]); setErrs([]); setStats({}); setOuts({}); setEdits({});
    const errors = [], o = {};

    try {
      const chatInstructions = chatMsgs.filter(m => m.role === "user").map(m => `- ${m.content}`).join("\n");
      const effectiveType = reportType.trim() || "Informe institucional general";

      // TEMPLATE
      const hasPlantilla = !!plantillaFile;
      const hasTplRefs = selectedTemplates.length > 0;
      if (hasPlantilla || hasTplRefs) {
        setActive("template"); setSt("template", "running");
        log(`Motor TEMPLATE: Analizando plantilla y ${selectedTemplates.length} referencia(s)...`);
        try {
          let combinedTpl = "";
          if (plantillaFile) {
            const pf = await readFile(plantillaFile, callMotor, log);
            const content = await buildContent(pf, `Analiza este documento plantilla "${plantillaFile.name}" y extrae estructura, formato, tono y secciones.`, log);
            const raw = await callMotor(P.template, content, 1500);
            combinedTpl += raw + "\n\n";
          }
          for (const t of selectedTemplates) {
            const pf = await readFile(t.file, callMotor, log);
            const content = await buildContent(pf, `Analiza este documento de referencia "${t.label || t.file.name}" y extrae estructura, tono y secciones.`, log);
            const raw = await callMotor(P.template, content, 1500);
            combinedTpl += raw + "\n\n";
          }
          const p = tryJSON(combinedTpl);
          o.template = p.ok ? p.data : combinedTpl;
          setOut("template", o.template); setSt("template", "done");
          log("Motor TEMPLATE: ✓ Estructura extraída.");

          if (!reportType.trim()) {
            log("🔍 Infiriendo tipo de informe desde la plantilla...");
            try {
              const inferred = await callMotor(
                "Analiza la estructura del documento y clasifica el tipo de informe. Responde SOLO con una frase corta descriptiva en español.",
                `Estructura extraída:\n${combinedTpl.slice(0, 2000)}`, 60, 30000
              );
              const inferredType = (inferred || "").trim();
              if (inferredType) { setReportType(inferredType); log(`🔍 Tipo inferido: "${inferredType}"`); }
            } catch { log("🔍 No se pudo inferir el tipo — usando genérico."); }
          }
        } catch (e) { setSt("template", "skipped"); log(`Motor TEMPLATE: ⚠ ${e.message}`); }
      } else { setSt("template", "skipped"); log("Motor TEMPLATE: Omitido (sin plantilla ni referencias)."); }

      // ALPHA × partners
      o.alpha = [];
      for (let i = 0; i < validPartners.length; i++) {
        const sp = validPartners[i], mid = `alpha_${i}`;
        const lbl = sp.label.trim() || sp.file.name.replace(/\.[^.]+$/, "");
        setActive(mid); setSt(mid, "running");
        log(`Alpha [${lbl}]: Leyendo documento...`);
        const pf = await readFile(sp.file, callMotor, log);
        log(`Alpha [${lbl}]: Extrayendo datos...`);
        const content = await buildContent(pf, `Extrae TODOS los datos estructurados de "${lbl}".`, log);
        const raw = await callMotor(P.alpha, content, 8000);
        const p = tryJSON(raw);
        if (!p.ok) { errors.push(`Alpha [${lbl}]: ${p.err}`); setSt(mid, "error"); }
        else setSt(mid, "done");
        o.alpha.push({ label: lbl, data: p.ok ? p.data : { raw: p.data, parse_error: true } });
        setOut("alpha", [...o.alpha]);
        log(`Alpha [${lbl}]: ${p.ok ? "✓" : "⚠"} Completado.`);
      }

      // Financial
      let finCtx = "";
      const validFin = finFiles.filter(f => f.file);
      for (const fi of validFin) {
        const flbl = fi.label.trim() || fi.file.name.replace(/\.[^.]+$/, "");
        log(`Leyendo informe financiero [${flbl}]...`);
        try {
          const pf = await readFile(fi.file, callMotor, log);
          const content = await buildContent(pf, `Extrae todos los datos financieros de "${flbl}".`, log);
          finCtx += typeof content === "string" ? `\n\nINFORME FINANCIERO [${flbl}]:\n${content.slice(0, 6000)}` : `\n\nINFORME FINANCIERO [${flbl}]: adjunto.`;
        } catch (e) { log(`Financiero [${flbl}]: ⚠ ${e.message}`); }
      }

      const aStr = JSON.stringify(o.alpha.map(a => ({ socio: a.label, ...a.data })), null, 2);

      // M0a
      setActive("m0a"); setSt("m0a", "running");
      log("M0a: Consolidando datos...");
      const m0aR = await callMotor(P.m0a, `Consolida:\n\n${aStr}${finCtx}`, 8000);
      const m0aP = tryJSON(m0aR);
      o.m0a = m0aP.ok ? m0aP.data : { raw: m0aR };
      setOut("m0a", o.m0a); setSt("m0a", m0aP.ok ? "done" : "error");
      log(`M0a: ${m0aP.ok ? "✓" : "⚠"} Consolidación completada.`);

      // M0b
      setActive("m0b"); setSt("m0b", "running");
      log("M0b: Redactando informe narrativo...");
      const tpl = o.template ? `\n\nESTRUCTURA BASE:\n${JSON.stringify(o.template, null, 2)}` : "";
      const m0bR = await callMotor(P.m0b, `TIPO DE INFORME: ${effectiveType}\n\nINSTRUCCIONES DEL USUARIO:\n${chatInstructions || "- Sin instrucciones adicionales"}\n\nDatos:\n\n${JSON.stringify(o.m0a, null, 2)}${tpl}`, 8000);
      o.m0b = m0bR; setOut("m0b", m0bR); setSt("m0b", "done");
      log("M0b: ✓ Informe generado.");

      // M0c
      setActive("m0c"); setSt("m0c", "running");
      log("M0c: Verificando trazabilidad...");
      const m0cR = await callMotor(P.m0c, `INFORME:\n${o.m0b}\n\n---\nDATOS:\n${aStr}`, 6000);
      o.m0c = m0cR; setOut("m0c", m0cR); setSt("m0c", "done");
      log("M0c: ✓ Trazabilidad completada.");

      // M2
      if (includeM2) {
        setActive("m2"); setSt("m2", "running");
        log("M2: Generando panel ejecutivo...");
        const m2R = await callMotor(P.m2, `TRAZABILIDAD:\n${o.m0c}\n\n---\nINFORME:\n${o.m0b}`, 4000);
        o.m2 = m2R; setOut("m2", m2R); setSt("m2", "done");
        log("M2: ✓ Panel ejecutivo listo.");
      } else { setSt("m2", "skipped"); }

      setActive(null); setErrs(errors); setPhase("results"); setTab("m0b");
      log("══════ PIPELINE COMPLETADO ══════");
    } catch (err) {
      errors.push(`Error: ${err.message}`); setErrs(errors); setActive(null);
      log(`❌ Error: ${err.message}`); setPhase("results");
    }
  };

  const resetAll = () => { setPhase("setup"); setOuts({}); setEdits({}); setStats({}); setLogs([]); setErrs([]); setActive(null); };

  // ═══════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════
  return (
    <div style={{ fontFamily: "Georgia,'Times New Roman',serif", background: C.bg, minHeight: "100vh", color: C.text }}>
      {/* Chat Sidebar */}
      {chatOpen && (
        <div style={{ position: "fixed", top: 0, right: 0, width: "350px", height: "100vh", background: C.white, borderLeft: `2px solid ${C.border}`, boxShadow: "-4px 0 20px rgba(0,0,0,0.1)", zIndex: 1000, display: "flex", flexDirection: "column" }}>
          <div style={{ background: C.dark, padding: "0.7rem 1rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ color: C.amber, fontWeight: "bold", fontSize: "0.88rem" }}>💬 Instrucciones</span>
            <button onClick={() => setChatOpen(false)} style={{ background: "none", border: "none", color: "#78a888", cursor: "pointer", fontSize: "1.2rem", lineHeight: 1 }}>×</button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "0.8rem" }}>
            <StickyNote id="chat_help" text="Escriba instrucciones antes de generar. Después de generar, úselo para pedir ajustes al borrador." dismissed={dismissed} onDismiss={dismiss} />
            {chatMsgs.length === 0 && <div style={{ textAlign: "center", color: C.muted, fontSize: "0.74rem", padding: "2rem 0", fontStyle: "italic" }}>Sin mensajes todavía</div>}
            {chatMsgs.map((m, idx) => (
              <div key={idx} style={{ marginBottom: "0.5rem", display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={{ background: m.role === "user" ? C.dark : C.note, color: m.role === "user" ? "#e0d8c8" : "#4a3f00", padding: "0.45rem 0.7rem", borderRadius: m.role === "user" ? "10px 10px 2px 10px" : "10px 10px 10px 2px", maxWidth: "85%", fontSize: "0.76rem", lineHeight: 1.45 }}>{m.content}</div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <div style={{ borderTop: `1px solid ${C.border}`, padding: "0.6rem", display: "flex", gap: "0.35rem" }}>
            <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === "Enter" && sendChat()} placeholder="Escriba instrucción..."
              style={{ flex: 1, padding: "0.45rem 0.6rem", border: `1px solid ${C.border}`, borderRadius: "6px", fontSize: "0.78rem" }} />
            <button onClick={sendChat} disabled={chatLoading || !chatInput.trim()}
              style={{ padding: "0.45rem 0.7rem", background: C.dark, color: C.amber, border: "none", borderRadius: "6px", cursor: chatLoading ? "not-allowed" : "pointer", fontSize: "0.75rem" }}>
              {chatLoading ? "..." : "→"}
            </button>
          </div>
        </div>
      )}

      {/* Chat Toggle */}
      {!chatOpen && (
        <button onClick={() => setChatOpen(true)}
          style={{ position: "fixed", bottom: "1.5rem", right: "1.5rem", width: "52px", height: "52px", borderRadius: "50%", background: C.dark, color: C.amber, border: `2px solid ${C.amber}`, fontSize: "1.4rem", cursor: "pointer", boxShadow: "0 4px 16px rgba(0,0,0,0.2)", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center" }}>
          💬
        </button>
      )}

      {/* Logout — fixed bottom-right below chat */}
      <button onClick={handleLogout}
        title="Cerrar sesión"
        style={{ position: "fixed", bottom: "1.5rem", right: chatOpen ? "1.5rem" : "5.8rem", width: "52px", height: "52px", borderRadius: "50%", background: C.dark, color: "#f87171", border: "2px solid #f87171", fontSize: "1.1rem", cursor: "pointer", boxShadow: "0 4px 16px rgba(0,0,0,0.2)", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center", transition: "right 0.2s ease" }}>
        🚪
      </button>

      {/* Header */}
      <header style={{ background: C.dark, borderBottom: `3px solid ${C.amber}`, padding: "0.7rem 1.5rem", display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.7rem" }}>
          <span style={{ fontSize: "1.7rem" }}>🌿</span>
          <div>
            <div style={{ color: C.amber, fontSize: "1.02rem", fontWeight: "bold" }}>Bosques del Mundo Bolivia</div>
            <div style={{ color: "#78a888", fontSize: "0.6rem", fontFamily: "monospace", letterSpacing: "0.12em" }}>SISTEMA DE INFORMES · PIPELINE IA · Gemini</div>
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: "3px", alignItems: "center" }}>
          {[["setup", "① Insumos"], ["running", "② Procesamiento"], ["results", "③ Resultados"]].map(([id, lbl], i) => {
            const idx = ["setup", "running", "results"].indexOf(phase);
            return <span key={id} style={{ padding: "0.2rem 0.58rem", borderRadius: "999px", fontSize: "0.62rem", fontFamily: "monospace", background: phase === id ? C.amber : idx > i ? C.mid : "rgba(255,255,255,0.07)", color: phase === id ? C.dark : idx > i ? "#90c8a0" : "rgba(255,255,255,0.26)", fontWeight: phase === id ? "bold" : "normal" }}>{lbl}</span>;
          })}
          <button onClick={handleLogout} style={{ marginLeft: "1rem", padding: "0.35rem 0.8rem", borderRadius: "6px", fontSize: "0.78rem", fontFamily: "monospace", background: "rgba(255,255,255,0.12)", color: C.amber, border: `1px solid ${C.amber}`, cursor: "pointer", fontWeight: "bold", letterSpacing: "0.05em" }}>Cerrar sesión</button>
        </div>
      </header>

      {/* SETUP PHASE */}
      {phase === "setup" && (
        <div style={{ maxWidth: "1100px", margin: "0 auto", padding: "1.5rem 1.5rem" }}>
          {/* Two columns */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
            {/* Left: Past reports */}
            <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: "10px", padding: "1.1rem" }}>
              <h3 style={{ color: C.mid, margin: "0 0 0.4rem 0", fontSize: "0.9rem" }}>📋 Insumos informes presentados gestiones pasadas</h3>
              <StickyNote id="tpl_help" text="Suba informes de gestiones anteriores. El sistema extraerá datos y podrá usar su formato como referencia." dismissed={dismissed} onDismiss={dismiss} />
              {templates.map((t, i) => (
                <FileRow key={i} p={t} i={i} onChange={upT} onRemove={rmT} canRemove={templates.length > 1} placeholder="Etiqueta" />
              ))}
              <button onClick={addT} style={{ marginTop: "0.15rem", padding: "0.32rem 0.7rem", background: "none", border: `1px dashed ${C.sage}`, borderRadius: "6px", color: C.mid, cursor: "pointer", fontSize: "0.74rem" }}>+ Agregar documento</button>
            </div>

            {/* Right: Partner documents */}
            <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: "10px", padding: "1.1rem" }}>
              <h3 style={{ color: C.mid, margin: "0 0 0.4rem 0", fontSize: "0.9rem" }}>📁 Insumos informes de socios</h3>
              <StickyNote id="partner_help" text="Suba los informes de socios, ejecutores, reportes técnicos u otros documentos fuente. Al menos uno es necesario." dismissed={dismissed} onDismiss={dismiss} />
              {partners.map((p, i) => (
                <FileRow key={i} p={p} i={i} onChange={upP} onRemove={rmP} canRemove={partners.length > 1} placeholder="Etiqueta" />
              ))}
              <button onClick={addP} style={{ marginTop: "0.15rem", padding: "0.32rem 0.7rem", background: "none", border: `1px dashed ${C.sage}`, borderRadius: "6px", color: C.mid, cursor: "pointer", fontSize: "0.74rem" }}>+ Agregar documento</button>
            </div>
          </div>

          {/* Plantilla */}
          <div style={{ background: "#e8f0ea", border: `2px solid ${C.sage}`, borderRadius: "10px", padding: "1.2rem", marginBottom: "1rem" }}>
            <h3 style={{ color: C.mid, margin: "0 0 0.5rem 0", fontSize: "0.95rem", textAlign: "center" }}>📐 Plantilla del nuevo informe a elaborar</h3>
            <StickyNote id="plantilla_help" text="Defina cómo será el nuevo informe. El sistema interpreta el formato y adapta el lenguaje según el tipo seleccionado." dismissed={dismissed} onDismiss={dismiss} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div>
                <div style={{ fontSize: "0.78rem", fontWeight: "bold", color: C.mid, marginBottom: "0.35rem" }}>Documento plantilla (opcional)</div>
                <DropZone file={plantillaFile} onFile={setPlantillaFile} label="Subir documento de referencia" hint="El sistema extraerá estructura y tono" />
              </div>
              <div>
                <div style={{ fontSize: "0.78rem", fontWeight: "bold", color: C.mid, marginBottom: "0.35rem" }}>Tipo de informe</div>
                <StickyNote id="type_help" text="Escriba el tipo o deje vacío para detección automática." dismissed={dismissed} onDismiss={dismiss} />
                <input value={reportType} onChange={e => setReportType(e.target.value)} placeholder="Ej: Ministerial, Para donante..."
                  style={{ width: "100%", padding: "0.5rem 0.7rem", border: `1px solid ${C.border}`, borderRadius: "6px", fontFamily: "Georgia,serif", fontSize: "0.82rem", background: C.white, color: C.text, boxSizing: "border-box", marginBottom: "0.5rem" }} />
                <label style={{ display: "flex", gap: "0.4rem", alignItems: "center", fontSize: "0.76rem", color: C.muted }}>
                  <input type="checkbox" checked={includeM2} onChange={e => setIncludeM2(e.target.checked)} style={{ accentColor: C.mid }} />
                  Incluir panel ejecutivo
                </label>
              </div>
            </div>
          </div>

          {/* Financial */}
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: "10px", padding: "1.1rem", marginBottom: "1rem" }}>
            <h3 style={{ color: C.mid, margin: "0 0 0.4rem 0", fontSize: "0.9rem" }}>💰 Informes financieros <span style={{ color: C.muted, fontSize: "0.72rem", fontWeight: "normal", fontStyle: "italic" }}>— opcional</span></h3>
            <StickyNote id="fin_help" text="Suba informes de ejecución presupuestaria para enriquecer el análisis." dismissed={dismissed} onDismiss={dismiss} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
              {finFiles.map((f, i) => (
                <FileRow key={i} p={f} i={i} onChange={upF} onRemove={rmF} canRemove={finFiles.length > 1} placeholder="Etiqueta" />
              ))}
            </div>
            <button onClick={addF} style={{ marginTop: "0.15rem", padding: "0.32rem 0.7rem", background: "none", border: `1px dashed ${C.sage}`, borderRadius: "6px", color: C.mid, cursor: "pointer", fontSize: "0.74rem" }}>+ Agregar informe</button>
          </div>

          {/* Generate button */}
          <button onClick={run} disabled={!canRun}
            style={{ width: "100%", padding: "1rem", background: canRun ? C.dark : "#c0b8a5", color: canRun ? C.amber : C.muted, border: "none", borderRadius: "9px", fontSize: "1rem", fontFamily: "Georgia,serif", cursor: canRun ? "pointer" : "not-allowed", fontWeight: "bold" }}>
            {canRun ? `🚀 Generar informe · ${validPartners.length} documento${validPartners.length !== 1 ? "s" : ""} fuente` : "Suba al menos un documento fuente para continuar"}
          </button>
        </div>
      )}

      {/* RUNNING PHASE */}
      {phase === "running" && (
        <div style={{ maxWidth: "880px", margin: "0 auto", padding: "2rem 1.5rem" }}>
          <h2 style={{ color: C.mid, marginBottom: "1.1rem" }}>Generando informe con Gemini...</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(185px,1fr))", gap: "0.46rem", marginBottom: "1.1rem" }}>
            <MCard icon="📋" label="Motor TEMPLATE" status={stats.template} active={active === "template"} />
            {validPartners.map((_, i) => (
              <MCard key={i} icon="🔍" label={`Alpha: ${validPartners[i].label || validPartners[i].file?.name?.replace(/\.[^.]+$/, "") || `Doc ${i + 1}`}`} status={stats[`alpha_${i}`]} active={active === `alpha_${i}`} />
            ))}
            <MCard icon="🔀" label="Consolidación" status={stats.m0a} active={active === "m0a"} />
            <MCard icon="✍️" label="Narrativa" status={stats.m0b} active={active === "m0b"} />
            <MCard icon="✅" label="Trazabilidad" status={stats.m0c} active={active === "m0c"} />
            <MCard icon="📊" label="Panel Ejecutivo" status={stats.m2} active={active === "m2"} />
          </div>
          <div style={{ borderRadius: "8px", overflow: "hidden", border: `1px solid ${C.dark}` }}>
            <div style={{ background: C.dark, padding: "0.34rem 0.85rem", display: "flex", gap: "0.3rem", alignItems: "center" }}>
              {["#ff5f57", "#febc2e", "#28c840"].map(c => <span key={c} style={{ width: 7, height: 7, borderRadius: "50%", background: c, display: "inline-block" }} />)}
              <span style={{ fontFamily: "monospace", color: "#78a888", fontSize: "0.6rem", marginLeft: "0.32rem" }}>registro del sistema</span>
            </div>
            <div ref={logRef} style={{ background: C.codeBg, padding: "0.78rem 0.92rem", fontFamily: "monospace", fontSize: "0.72rem", color: C.codeText, maxHeight: "220px", overflowY: "auto", lineHeight: 1.7 }}>
              {logs.length === 0 ? <span style={{ opacity: .3 }}>Inicializando...</span> : logs.map((l, i) => <div key={i} style={{ color: l.includes("❌") ? "#f09090" : l.includes("⚠") ? "#f0d080" : C.codeText }}>{l}</div>)}
            </div>
          </div>
        </div>
      )}

      {/* RESULTS PHASE */}
      {phase === "results" && (
        <div style={{ maxWidth: "1100px", margin: "0 auto", padding: "2rem 1.5rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem", flexWrap: "wrap", gap: "0.55rem" }}>
            <h2 style={{ color: C.mid, margin: 0 }}>Resultados{reportType ? ` — ${reportType}` : ""}</h2>
            <button onClick={resetAll} style={{ padding: "0.37rem 0.82rem", background: "none", border: `1px solid ${C.mid}`, color: C.mid, borderRadius: "5px", cursor: "pointer", fontSize: "0.78rem" }}>← Nueva ejecución</button>
          </div>

          {errs.length > 0 && (
            <div style={{ background: C.errBg, border: "1px solid #c09090", borderRadius: "8px", padding: "0.75rem 0.95rem", marginBottom: "0.9rem" }}>
              <strong style={{ color: C.errText }}>⚠ Advertencias:</strong>
              {errs.map((e, i) => <div key={i} style={{ color: C.errText, fontSize: "0.78rem", marginTop: "0.18rem" }}>{e}</div>)}
            </div>
          )}

          {/* Tabs */}
          <div style={{ display: "flex", gap: "2px", borderBottom: `2px solid ${C.border}`, marginBottom: "1.1rem", overflowX: "auto", paddingBottom: "2px" }}>
            {[["m0b", "✍️ Informe"], ["m0c", "✅ Trazabilidad"], ["m2", "📊 Panel Ejecutivo"], ["alpha", "🔍 Datos Extraídos"]].map(([id, lbl]) => (
              <button key={id} onClick={() => setTab(id)} style={{ padding: "0.42rem 0.88rem", border: "none", borderBottom: tab === id ? `3px solid ${C.amber}` : "3px solid transparent", background: tab === id ? C.white : "transparent", color: tab === id ? C.mid : C.muted, cursor: "pointer", fontFamily: "Georgia,serif", fontSize: "0.79rem", whiteSpace: "nowrap", fontWeight: tab === id ? "bold" : "normal", marginBottom: "-2px" }}>{lbl}</button>
            ))}
          </div>

          {/* Tab Content */}
          {tab === "m0b" && <Editor content={get("m0b") || ""} onChange={v => set("m0b", v)} exportName={`BDM_Informe_${(reportType || "General").replace(/\s+/g, "_")}_2025`} />}

          {tab === "m2" && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.62rem", flexWrap: "wrap", gap: "0.42rem" }}>
                <strong style={{ color: C.mid }}>Panel Ejecutivo</strong>
                <div style={{ display: "flex", gap: "0.38rem" }}>
                  <button onClick={() => dlWord(outs.m2 || "", "Panel_Ejecutivo_BDM_2025")} style={{ padding: "0.3rem 0.78rem", background: C.amber, color: C.dark, border: "none", borderRadius: "5px", cursor: "pointer", fontSize: "0.76rem", fontWeight: "bold" }}>📄 Word</button>
                  <button onClick={() => dlMd(outs.m2 || "", "Panel_Ejecutivo_BDM_2025")} style={{ padding: "0.3rem 0.62rem", background: "none", border: `1px solid ${C.border}`, color: C.muted, borderRadius: "5px", cursor: "pointer", fontSize: "0.76rem" }}>⬇ .md</button>
                </div>
              </div>
              <pre style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "1.15rem", whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: "0.76rem", lineHeight: 1.7, color: C.text, maxHeight: "560px", overflowY: "auto" }}>{outs.m2 || "Sin datos."}</pre>
            </div>
          )}

          {tab === "m0c" && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.62rem" }}>
                <strong style={{ color: C.mid }}>Trazabilidad y Consistencia</strong>
                <button onClick={() => dlMd(outs.m0c || "", "BDM_Trazabilidad_2025")} style={{ padding: "0.3rem 0.62rem", background: "none", border: `1px solid ${C.border}`, color: C.muted, borderRadius: "5px", cursor: "pointer", fontSize: "0.76rem" }}>⬇ .md</button>
              </div>
              <pre style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "1.15rem", whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: "0.76rem", lineHeight: 1.7, color: C.text, maxHeight: "560px", overflowY: "auto" }}>{outs.m0c || "Sin datos."}</pre>
            </div>
          )}

          {tab === "alpha" && (
            <div>
              {(outs.alpha || []).map((a, i) => (
                <div key={i} style={{ marginBottom: "1.1rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.58rem" }}>
                    <strong style={{ color: C.mid }}>Datos extraídos — {a.label}</strong>
                    <button onClick={() => dlMd(JSON.stringify(a.data, null, 2), `Alpha_${a.label}`)} style={{ padding: "0.3rem 0.62rem", background: "none", border: `1px solid ${C.border}`, color: C.muted, borderRadius: "5px", cursor: "pointer", fontSize: "0.76rem" }}>⬇ .json</button>
                  </div>
                  <pre style={{ background: C.codeBg, border: `1px solid ${C.dark}`, borderRadius: "8px", padding: "1.15rem", overflowX: "auto", whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: "0.74rem", lineHeight: 1.6, color: C.codeText, maxHeight: "440px", overflowY: "auto" }}>{JSON.stringify(a.data, null, 2)}</pre>
                </div>
              ))}
              {!outs.alpha?.length && <div style={{ padding: "2rem", textAlign: "center", color: C.muted, fontStyle: "italic", background: C.white, borderRadius: "8px", border: `1px solid ${C.border}` }}>Sin datos extraídos.</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Editor component - markdown edit/preview with Word export
import { useState } from "react";
import { THEME as C } from "../theme/index.js";
import { dlWord, dlMd } from "../utils/exportHelpers.js";

export function Editor({ content, onChange, exportName }) {
  const [mode, setMode] = useState("edit");
  
  const prev = md => {
    if (!md) return "";
    return md
      .replace(/^# (.+)$/gm, `<h1 style="color:${C.mid};font-size:1.3rem;border-bottom:2px solid ${C.amber};padding-bottom:5px;margin-top:1.3rem;">$1</h1>`)
      .replace(/^## (.+)$/gm, `<h2 style="color:${C.mid};font-size:1.08rem;margin-top:1rem;">$1</h2>`)
      .replace(/^### (.+)$/gm, `<h3 style="color:${C.sage};font-size:0.93rem;margin-top:0.85rem;">$1</h3>`)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/^---$/gm, `<hr style="border:1px solid ${C.border};margin:0.7rem 0;"/>`)
      .replace(/^\| (.+) \|$/gm, row => {
        const cells = row.split('|').slice(1, -1).map(c => c.trim());
        if (cells.every(c => c.match(/^[-:]+$/))) return '';
        return `<tr>${cells.map(c => `<td style="border:1px solid ${C.border};padding:5px 9px;font-size:0.8rem;">${c}</td>`).join('')}</tr>`;
      })
      .replace(/(<tr>.*?<\/tr>\n?)+/gs, m => `<table style="border-collapse:collapse;width:100%;margin:6px 0;">${m}</table>`)
      .replace(/^[-*] (.+)$/gm, "<li style='font-size:0.83rem;margin-bottom:2px;'>$1</li>")
      .replace(/(<li[^>]*>.*?<\/li>\n?)+/gs, m => `<ul style="padding-left:1.1rem;margin:3px 0;">${m}</ul>`)
      .replace(/^(?!<[hult]|<\/|$)(.+)$/gm, "<p style='font-size:0.83rem;line-height:1.6;margin:3px 0;'>$1</p>");
  };
  
  if (!content) {
    return (
      <div style={{
        padding: "2rem",
        textAlign: "center",
        color: C.muted,
        fontStyle: "italic",
        background: C.white,
        borderRadius: "8px",
        border: `1px solid ${C.border}`
      }}>
        Sin contenido generado.
      </div>
    );
  }
  
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.58rem", flexWrap: "wrap", gap: "0.45rem" }}>
        <div style={{ display: "flex", gap: "1px", background: C.border, borderRadius: "6px", overflow: "hidden" }}>
          {[["edit", "✏️ Editar"], ["preview", "👁 Vista previa"]].map(([m, l]) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                padding: "0.3rem 0.72rem",
                background: mode === m ? C.mid : "transparent",
                color: mode === m ? "#f0ebe0" : C.muted,
                border: "none",
                cursor: "pointer",
                fontSize: "0.76rem"
              }}
            >
              {l}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: "0.38rem" }}>
          <button
            onClick={() => dlWord(content, exportName)}
            style={{
              padding: "0.3rem 0.78rem",
              background: C.amber,
              color: C.dark,
              border: "none",
              borderRadius: "5px",
              cursor: "pointer",
              fontSize: "0.76rem",
              fontWeight: "bold"
            }}
          >
            📄 Word
          </button>
          <button
            onClick={() => dlMd(content, exportName)}
            style={{
              padding: "0.3rem 0.62rem",
              background: "none",
              border: `1px solid ${C.border}`,
              color: C.muted,
              borderRadius: "5px",
              cursor: "pointer",
              fontSize: "0.76rem"
            }}
          >
            ⬇ .md
          </button>
        </div>
      </div>
      {mode === "edit" ? (
        <textarea
          value={content}
          onChange={e => onChange(e.target.value)}
          style={{
            width: "100%",
            minHeight: "490px",
            padding: "0.9rem",
            border: `1px solid ${C.border}`,
            borderRadius: "8px",
            fontFamily: "'Courier New',monospace",
            fontSize: "0.75rem",
            lineHeight: 1.7,
            background: C.white,
            color: C.text,
            resize: "vertical",
            boxSizing: "border-box"
          }}
        />
      ) : (
        <div style={{
          background: C.white,
          border: `1px solid ${C.border}`,
          borderRadius: "8px",
          padding: "1.6rem",
          maxHeight: "530px",
          overflowY: "auto",
          fontFamily: "Georgia,serif"
        }}
          dangerouslySetInnerHTML={{ __html: prev(content) }}
        />
      )}
    </div>
  );
}

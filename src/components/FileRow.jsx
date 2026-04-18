// FileRow component - file input with label and drag-drop
import { useState, useRef } from "react";
import { THEME as C, ACCEPTED_FILES } from "../theme/index.js";

export function FileRow({ p, i, onChange, onRemove, canRemove, placeholder }) {
  const ref = useRef(null);
  const [drag, setDrag] = useState(false);
  
  const handle = f => { if (f) onChange(i, "file", f); };
  
  return (
    <div style={{ display: "flex", gap: "0.45rem", alignItems: "center", marginBottom: "0.45rem" }}>
      <input
        value={p.label}
        onChange={e => onChange(i, "label", e.target.value)}
        placeholder={placeholder || "Etiqueta"}
        style={{
          width: "140px",
          flexShrink: 0,
          padding: "0.38rem 0.55rem",
          border: `1px solid ${C.border}`,
          borderRadius: "6px",
          fontFamily: "Georgia,serif",
          fontSize: "0.8rem",
          background: C.white,
          color: C.text
        }}
      />
      <div
        onClick={() => ref.current?.click()}
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files[0]); }}
        style={{
          flex: 1,
          border: `2px dashed ${drag ? C.amber : p.file ? C.sage : C.border}`,
          borderRadius: "7px",
          padding: "0.4rem 0.7rem",
          cursor: "pointer",
          background: drag ? "#eef8f2" : p.file ? "#eaf4ee" : C.white,
          display: "flex",
          alignItems: "center",
          gap: "0.4rem",
          transition: "all 0.15s",
          minHeight: "36px"
        }}
      >
        <input ref={ref} type="file" accept={ACCEPTED_FILES} style={{ display: "none" }} onChange={e => handle(e.target.files[0])} />
        <span style={{ fontSize: "0.9rem" }}>{p.file ? "📄" : "📂"}</span>
        <span style={{
          fontSize: "0.76rem",
          color: p.file ? C.mid : C.muted,
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }}>
          {p.file ? p.file.name : "Clic o arrastre aquí"}
        </span>
        {p.file && <span style={{ fontSize: "0.63rem", color: C.sage, flexShrink: 0 }}>✓ {(p.file.size / 1024).toFixed(0)}KB</span>}
      </div>
      {canRemove && (
        <button
          onClick={() => onRemove(i)}
          style={{
            background: "none",
            border: `1px solid ${C.border}`,
            borderRadius: "6px",
            cursor: "pointer",
            color: C.muted,
            fontSize: "0.9rem",
            padding: "0.35rem 0.45rem",
            flexShrink: 0,
            lineHeight: 1
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

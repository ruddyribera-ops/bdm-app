// DropZone component - simple file drop area
import { useState, useRef } from "react";
import { THEME as C, ACCEPTED_FILES } from "../theme/index.js";

export function DropZone({ file, onFile, label, hint }) {
  const ref = useRef(null);
  const [drag, setDrag] = useState(false);
  
  const handle = f => { if (f) onFile(f); };
  
  return (
    <div
      onClick={() => ref.current?.click()}
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={e => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files[0]); }}
      style={{
        border: `2px dashed ${drag ? C.amber : file ? C.sage : C.border}`,
        borderRadius: "8px",
        padding: "0.7rem 0.9rem",
        cursor: "pointer",
        background: drag ? "#eef8f2" : file ? "#eaf4ee" : C.white,
        display: "flex",
        alignItems: "center",
        gap: "0.6rem",
        minHeight: "44px",
        transition: "all 0.15s"
      }}
    >
      <input ref={ref} type="file" accept={ACCEPTED_FILES} style={{ display: "none" }} onChange={e => handle(e.target.files[0])} />
      <span style={{ fontSize: "1.1rem", flexShrink: 0 }}>{file ? "📄" : "📂"}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: "0.8rem",
          fontWeight: file ? "bold" : "normal",
          color: file ? C.mid : C.muted,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }}>
          {file ? file.name : label}
        </div>
        {!file && hint && <div style={{ fontSize: "0.67rem", color: C.muted, marginTop: "1px" }}>{hint}</div>}
        {file && <div style={{ fontSize: "0.67rem", color: C.sage, marginTop: "1px" }}>✓ {(file.size / 1024).toFixed(0)} KB</div>}
      </div>
      {file && (
        <button
          onClick={e => { e.stopPropagation(); onFile(null); }}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: C.muted,
            fontSize: "1rem",
            padding: "0 2px",
            lineHeight: 1
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

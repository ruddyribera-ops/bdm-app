// StickyNote component - dismissable help message
import { THEME as C } from "../theme/index.js";

export function StickyNote({ text, id, dismissed, onDismiss }) {
  if (dismissed[id]) return null;
  return (
    <div style={{
      background: C.note,
      border: `1px solid ${C.noteBorder}`,
      borderLeft: `4px solid ${C.noteBorder}`,
      borderRadius: "4px",
      padding: "0.5rem 0.7rem",
      marginBottom: "0.6rem",
      fontSize: "0.74rem",
      color: "#6b5e00",
      display: "flex",
      alignItems: "flex-start",
      gap: "0.4rem"
    }}>
      <span style={{ flexShrink: 0 }}>💡</span>
      <span style={{ flex: 1, lineHeight: 1.45 }}>{text}</span>
      <button
        onClick={() => onDismiss(id)}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "#b0a040",
          fontSize: "0.85rem",
          padding: 0,
          lineHeight: 1,
          flexShrink: 0
        }}
      >
        ×
      </button>
    </div>
  );
}

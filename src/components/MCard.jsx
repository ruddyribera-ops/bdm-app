// MCard component - Motor status card
import { THEME as C } from "../theme/index.js";

const STATUS_CONFIG = {
  running: { bg: "#deeee5", border: C.sage, text: C.mid },
  done: { bg: "#e3f0e6", border: "#38844e", text: "#18502a" },
  error: { bg: C.errBg, border: "#b06060", text: "#7a2020" },
  skipped: { bg: "#eee9de", border: C.border, text: C.muted },
  pending: { bg: C.white, border: C.border, text: "#989080" }
};

const STATUS_ICONS = {
  running: "⟳",
  done: "✓",
  error: "⚠",
  skipped: "—",
  pending: "○"
};

export function MCard({ icon, label, status, active }) {
  const s = status || "pending";
  const sc = STATUS_CONFIG[s] || STATUS_CONFIG.pending;
  
  return (
    <div style={{
      background: sc.bg,
      border: `1px solid ${sc.border}`,
      borderRadius: "6px",
      padding: "0.5rem 0.75rem",
      boxShadow: active ? `0 0 0 2px ${sc.border}` : "none",
      transition: "all 0.25s"
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
        <span style={{ fontSize: "0.83rem" }}>{icon}</span>
        <span style={{ flex: 1, fontSize: "0.74rem", fontWeight: "bold", color: sc.text }}>{label}</span>
        <span style={{ fontFamily: "monospace", color: sc.text, fontSize: "0.9rem" }}>
          {STATUS_ICONS[s]}
        </span>
      </div>
    </div>
  );
}

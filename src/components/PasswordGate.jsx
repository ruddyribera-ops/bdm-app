// PasswordGate component - login screen
import { useState } from "react";
import { THEME as C } from "../theme/index.js";

export function PasswordGate({ onAuth }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  
  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw })
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Contraseña incorrecta");
        return;
      }
      onAuth(data.token);
    } catch {
      setError("Error de conexión.");
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div style={{
      fontFamily: "Georgia,serif",
      background: C.bg,
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }}>
      <div style={{
        background: C.white,
        border: `1px solid ${C.border}`,
        borderRadius: "12px",
        padding: "2.5rem",
        width: "100%",
        maxWidth: "360px",
        boxShadow: "0 4px 24px rgba(0,0,0,0.08)"
      }}>
        <div style={{ textAlign: "center", marginBottom: "1.8rem" }}>
          <span style={{ fontSize: "2.5rem" }}>🌿</span>
          <div style={{ color: C.mid, fontSize: "1.1rem", fontWeight: "bold", marginTop: "0.5rem" }}>
            Bosques del Mundo Bolivia
          </div>
          <div style={{ color: C.muted, fontSize: "0.75rem", marginTop: "0.25rem" }}>
            Sistema de Informes
          </div>
        </div>
        <form onSubmit={submit}>
          <input
            type="password"
            value={pw}
            onChange={e => setPw(e.target.value)}
            placeholder="Contraseña"
            autoFocus
            style={{
              width: "100%",
              padding: "0.7rem 0.9rem",
              border: `1px solid ${error ? C.errText : C.border}`,
              borderRadius: "7px",
              fontFamily: "Georgia,serif",
              fontSize: "0.9rem",
              background: C.white,
              color: C.text,
              boxSizing: "border-box",
              marginBottom: "0.75rem"
            }}
          />
          {error && (
            <div style={{ color: C.errText, fontSize: "0.78rem", marginBottom: "0.6rem" }}>
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={loading || !pw}
            style={{
              width: "100%",
              padding: "0.75rem",
              background: pw && !loading ? C.dark : "#c0b8a5",
              color: pw && !loading ? C.amber : C.muted,
              border: "none",
              borderRadius: "7px",
              fontSize: "0.9rem",
              fontFamily: "Georgia,serif",
              cursor: pw && !loading ? "pointer" : "not-allowed",
              fontWeight: "bold"
            }}
          >
            {loading ? "Verificando..." : "Ingresar"}
          </button>
        </form>
      </div>
    </div>
  );
}

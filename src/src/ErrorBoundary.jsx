import { Component } from "react";

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f0ebe0",
          fontFamily: "Georgia, serif",
          padding: "2rem"
        }}>
          <div style={{
            background: "#faf8f2",
            border: "1px solid #cac2ae",
            borderRadius: "12px",
            padding: "2rem",
            maxWidth: "400px",
            textAlign: "center"
          }}>
            <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>⚠️</div>
            <h2 style={{ color: "#7a2020", marginBottom: "1rem" }}>Algo salió mal</h2>
            <p style={{ color: "#617063", marginBottom: "1.5rem" }}>
              {this.state.error?.message || "Error inesperado en la aplicación"}
            </p>
            <button
              onClick={this.handleRetry}
              style={{
                padding: "0.75rem 1.5rem",
                background: "#194a2c",
                color: "#c8a020",
                border: "none",
                borderRadius: "6px",
                cursor: "pointer",
                fontSize: "1rem",
                fontWeight: "bold"
              }}
            >
              Reintentar
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
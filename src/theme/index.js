// Theme colors and constants for BDM App
// Centralized design tokens for consistent styling

export const THEME = {
  // Background colors
  bg: "#f0ebe0",
  white: "#faf8f2",
  dark: "#0c1e12",
  mid: "#194a2c",
  
  // Accent colors
  sage: "#4a7c5a",
  amber: "#c8a020",
  
  // Text colors
  text: "#16160c",
  muted: "#617063",
  border: "#cac2ae",
  
  // Code colors
  codeBg: "#0f1c13",
  codeText: "#a0c0a8",
  
  // Error colors
  errBg: "#f8ecec",
  errText: "#7a2020",
  
  // Note colors
  note: "#fef9e7",
  noteBorder: "#e8d44d",
};

// Session configuration
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// AI Model configuration
export const DEFAULT_MODEL = "gemini-2.5-flash-lite";

// Accepted file types
export const ACCEPTED_FILES = ".pdf,.docx,.doc,.txt,.xlsx,.xls,.csv,.rtf,.odt,.pptx,.ppt,.html,.htm,.md,.json,.xml";

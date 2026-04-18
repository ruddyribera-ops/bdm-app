// Auth utilities for BDM App
// Handles token storage and session management

import { SESSION_MAX_AGE_MS } from "../theme/index.js";

/**
 * Get stored token if valid
 * @returns {string} Token or empty string if expired/missing
 */
export function getStoredToken() {
  const token = localStorage.getItem("bdm_token") || sessionStorage.getItem("bdm_token") || "";
  const exp = Number(localStorage.getItem("bdm_token_expires_at") || 0);
  if (!token) return "";
  if (exp && Date.now() > exp) {
    localStorage.removeItem("bdm_token");
    localStorage.removeItem("bdm_token_expires_at");
    sessionStorage.removeItem("bdm_token");
    return "";
  }
  return token;
}

/**
 * Save token for session (30 days)
 */
export function saveTokenForMonth(token) {
  const exp = Date.now() + SESSION_MAX_AGE_MS;
  localStorage.setItem("bdm_token", token);
  localStorage.setItem("bdm_token_expires_at", String(exp));
  sessionStorage.setItem("bdm_token", token);
}

/**
 * Clear all auth data (logout)
 */
export function clearAuth() {
  localStorage.removeItem("bdm_token");
  localStorage.removeItem("bdm_token_expires_at");
  sessionStorage.removeItem("bdm_token");
}

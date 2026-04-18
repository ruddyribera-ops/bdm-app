// Tests for utils/auth.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getStoredToken, saveTokenForMonth, clearAuth } from '../src/utils/auth.js';

describe('Auth Utilities', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  describe('getStoredToken', () => {
    it('should return empty string when no token exists', () => {
      expect(getStoredToken()).toBe('');
    });

    it('should return token from localStorage when valid', () => {
      localStorage.setItem('bdm_token', 'test-token-123');
      localStorage.setItem('bdm_token_expires_at', String(Date.now() + 86400000)); // 1 day from now
      expect(getStoredToken()).toBe('test-token-123');
    });

    it('should return token from sessionStorage when localStorage is empty', () => {
      sessionStorage.setItem('bdm_token', 'session-token');
      expect(getStoredToken()).toBe('session-token');
    });

    it('should clear expired token', () => {
      localStorage.setItem('bdm_token', 'expired-token');
      localStorage.setItem('bdm_token_expires_at', String(Date.now() - 1000)); // 1 second ago
      expect(getStoredToken()).toBe('');
      expect(localStorage.getItem('bdm_token')).toBeNull();
    });
  });

  describe('saveTokenForMonth', () => {
    it('should save token to localStorage', () => {
      saveTokenForMonth('new-token');
      expect(localStorage.getItem('bdm_token')).toBe('new-token');
    });

    it('should save token to sessionStorage', () => {
      saveTokenForMonth('new-token');
      expect(sessionStorage.getItem('bdm_token')).toBe('new-token');
    });

    it('should set expiration 30 days from now', () => {
      const before = Date.now();
      saveTokenForMonth('expiring-token');
      const exp = Number(localStorage.getItem('bdm_token_expires_at'));
      const after = Date.now();
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      expect(exp).toBeGreaterThanOrEqual(before + thirtyDays);
      expect(exp).toBeLessThanOrEqual(after + thirtyDays);
    });
  });

  describe('clearAuth', () => {
    it('should clear all auth data from localStorage', () => {
      localStorage.setItem('bdm_token', 'token');
      localStorage.setItem('bdm_token_expires_at', '12345');
      clearAuth();
      expect(localStorage.getItem('bdm_token')).toBeNull();
      expect(localStorage.getItem('bdm_token_expires_at')).toBeNull();
    });

    it('should clear all auth data from sessionStorage', () => {
      sessionStorage.setItem('bdm_token', 'token');
      clearAuth();
      expect(sessionStorage.getItem('bdm_token')).toBeNull();
    });
  });
});

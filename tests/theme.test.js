// Tests for theme/index.js
import { describe, it, expect } from 'vitest';
import { THEME, SESSION_MAX_AGE_MS, ACCEPTED_FILES, DEFAULT_MODEL } from '../src/theme/index.js';

describe('THEME', () => {
  it('should have all required color properties', () => {
    expect(THEME).toHaveProperty('bg');
    expect(THEME).toHaveProperty('white');
    expect(THEME).toHaveProperty('dark');
    expect(THEME).toHaveProperty('mid');
    expect(THEME).toHaveProperty('sage');
    expect(THEME).toHaveProperty('amber');
    expect(THEME).toHaveProperty('text');
    expect(THEME).toHaveProperty('muted');
    expect(THEME).toHaveProperty('border');
  });

  it('should have valid hex color values', () => {
    const hexRegex = /^#[0-9a-fA-F]{6}$/;
    expect(THEME.bg).toMatch(hexRegex);
    expect(THEME.white).toMatch(hexRegex);
    expect(THEME.dark).toMatch(hexRegex);
    expect(THEME.mid).toMatch(hexRegex);
  });
});

describe('SESSION_MAX_AGE_MS', () => {
  it('should be 30 days in milliseconds', () => {
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(SESSION_MAX_AGE_MS).toBe(thirtyDays);
  });
});

describe('ACCEPTED_FILES', () => {
  it('should include pdf', () => {
    expect(ACCEPTED_FILES).toContain('.pdf');
  });

  it('should include docx', () => {
    expect(ACCEPTED_FILES).toContain('.docx');
  });
});

describe('DEFAULT_MODEL', () => {
  it('should be gemini-2.5-flash-lite', () => {
    expect(DEFAULT_MODEL).toBe('gemini-2.5-flash-lite');
  });
});

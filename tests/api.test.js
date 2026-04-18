// Tests for services/api.js
import { describe, it, expect } from 'vitest';
import { tryJSON } from '../src/services/api.js';

describe('API Service', () => {
  describe('tryJSON', () => {
    it('should parse valid JSON', () => {
      const result = tryJSON('{"name": "test", "value": 123}');
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ name: 'test', value: 123 });
    });

    it('should handle JSON with extra whitespace', () => {
      const result = tryJSON('  {"name": "test"}  ');
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ name: 'test' });
    });

    it('should handle JSON wrapped in markdown code blocks', () => {
      const result = tryJSON('```json\n{"name": "test"}\n```');
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ name: 'test' });
    });

    it('should handle single code block marker', () => {
      const result = tryJSON('```json\n{"name": "test"}```');
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ name: 'test' });
    });

    it('should return ok=false for invalid JSON', () => {
      const result = tryJSON('not valid json {');
      expect(result.ok).toBe(false);
      expect(result.data).toBe('not valid json {');
      expect(result.err).toBeDefined();
    });

    it('should handle plain text', () => {
      const result = tryJSON('just some plain text');
      expect(result.ok).toBe(false);
      expect(result.data).toBe('just some plain text');
    });

    it('should handle empty string', () => {
      const result = tryJSON('');
      expect(result.ok).toBe(false);
    });

    it('should handle nested JSON objects', () => {
      const nested = '{"project": {"name": "BDM", "data": {"value": 42}}}';
      const result = tryJSON(nested);
      expect(result.ok).toBe(true);
      expect(result.data.project.name).toBe('BDM');
      expect(result.data.project.data.value).toBe(42);
    });

    it('should handle JSON arrays', () => {
      const result = tryJSON('[1, 2, 3, "test"]');
      expect(result.ok).toBe(true);
      expect(result.data).toEqual([1, 2, 3, 'test']);
    });
  });
});

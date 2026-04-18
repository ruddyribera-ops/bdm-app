// Tests for utils/exportHelpers.js
import { describe, it, expect } from 'vitest';
import { toWordHtml, dlWord, dlMd } from '../src/utils/exportHelpers.js';

describe('Export Helpers', () => {
  describe('toWordHtml', () => {
    it('should convert h1 to Word HTML', () => {
      const result = toWordHtml('# Test Title', 'Test');
      expect(result).toContain('<h1');
      expect(result).toContain('Test Title</h1>');
    });

    it('should convert h2 to Word HTML', () => {
      const result = toWordHtml('## Section', 'Test');
      expect(result).toContain('<h2');
      expect(result).toContain('Section</h2>');
    });

    it('should convert bold text', () => {
      const result = toWordHtml('This is **bold** text', 'Test');
      expect(result).toContain('<strong>bold</strong>');
    });

    it('should include document title', () => {
      const result = toWordHtml('Content', 'My Document');
      expect(result).toContain('<title>My Document</title>');
      expect(result).toContain('Bosques del Mundo Bolivia');
    });

    it('should handle empty content', () => {
      const result = toWordHtml('', 'Empty');
      expect(result).toContain('<title>Empty</title>');
    });
  });

  describe('dlWord', () => {
    it('should not throw when called with valid content', () => {
      expect(() => dlWord('# Test', 'test')).not.toThrow();
    });

    it('should not throw when called with empty content', () => {
      expect(() => dlWord('', 'empty')).not.toThrow();
    });

    it('should not throw when called with null', () => {
      expect(() => dlWord(null, 'null')).not.toThrow();
    });
  });

  describe('dlMd', () => {
    it('should not throw when called with valid content', () => {
      expect(() => dlMd('# Test markdown', 'test')).not.toThrow();
    });

    it('should not throw when called with empty content', () => {
      expect(() => dlMd('', 'empty')).not.toThrow();
    });

    it('should not throw when called with null', () => {
      expect(() => dlMd(null, 'null')).not.toThrow();
    });
  });
});

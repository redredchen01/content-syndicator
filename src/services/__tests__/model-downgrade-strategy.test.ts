import { describe, it, expect, vi } from 'vitest';
import { getNextModel, canDowngrade, tryDowngradeAndRetry } from '../model-downgrade-strategy';

describe('model-downgrade-strategy', () => {
  describe('getNextModel', () => {
    it('returns next model in cascade', () => {
      expect(getNextModel('gpt-4o')).toBe('gpt-4o-mini');
      expect(getNextModel('gpt-4o-mini')).toBe('gemini-1.5-flash');
    });

    it('returns null at end of cascade', () => {
      expect(getNextModel('gemini-1.5-flash')).toBeNull();
    });

    it('returns null for unknown model', () => {
      expect(getNextModel('unknown-model')).toBeNull();
    });
  });

  describe('canDowngrade', () => {
    it('returns true for models that can downgrade', () => {
      expect(canDowngrade('gpt-4o')).toBe(true);
      expect(canDowngrade('gpt-4o-mini')).toBe(true);
    });

    it('returns false for models at end of cascade', () => {
      expect(canDowngrade('gemini-1.5-flash')).toBe(false);
    });

    it('returns false for unknown model', () => {
      expect(canDowngrade('unknown')).toBe(false);
    });
  });

  describe('tryDowngradeAndRetry', () => {
    it('downgrades and retries with next model', async () => {
      const invokeDirectly = vi.fn().mockResolvedValue({ content: 'success' });
      const options = { model: 'gpt-4o', messages: [] };
      const error = new Error('gpt-4o 失败');

      const result = await tryDowngradeAndRetry(options, error, invokeDirectly);

      expect(invokeDirectly).toHaveBeenCalledWith({
        ...options,
        model: 'gpt-4o-mini',
      });
      expect(result).toEqual({ content: 'success' });
    });

    it('rejects when no model to downgrade to', async () => {
      const invokeDirectly = vi.fn();
      const options = { model: 'gemini-1.5-flash' };
      const error = new Error('下游失败');

      await expect(
        tryDowngradeAndRetry(options, error, invokeDirectly)
      ).rejects.toThrow('下游失败');

      expect(invokeDirectly).not.toHaveBeenCalled();
    });

    it('propagates downgrade retry errors', async () => {
      const downgradeError = new Error('降级后仍失败');
      const invokeDirectly = vi.fn().mockRejectedValue(downgradeError);
      const options = { model: 'gpt-4o-mini' };
      const originalError = new Error('原始错误');

      await expect(
        tryDowngradeAndRetry(options, originalError, invokeDirectly)
      ).rejects.toThrow('降级后仍失败');

      expect(invokeDirectly).toHaveBeenCalledWith({
        ...options,
        model: 'gemini-1.5-flash',
      });
    });
  });
});

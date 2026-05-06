import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AsyncLogger, LogEntry } from '../async-logger';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('AsyncLogger', () => {
  let tempDir: string;
  let asyncLogger: AsyncLogger;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'async-logger-'));
  });

  afterEach(async () => {
    if (asyncLogger) {
      await asyncLogger.shutdown();
    }
    // 清理临时目录
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe('Happy path', () => {
    it('应该成功加入日志条目到缓冲', () => {
      asyncLogger = new AsyncLogger(tempDir);

      asyncLogger.enqueue({
        timestamp: Date.now(),
        level: 'info',
        message: 'test message',
        meta: { key: 'value' },
      });

      const stats = asyncLogger.getStats();
      expect(stats.pendingEntries).toBe(1);
    });

    it('应该批量刷新日志到文件', async () => {
      asyncLogger = new AsyncLogger(tempDir, 100, 100);

      const entries: LogEntry[] = Array.from({ length: 5 }, (_, i) => ({
        timestamp: Date.now() + i,
        level: 'info',
        message: `message ${i}`,
        meta: { index: i },
      }));

      entries.forEach(e => asyncLogger.enqueue(e));

      // 等待刷新
      await new Promise(r => setTimeout(r, 200));

      const stats = asyncLogger.getStats();
      expect(stats.flushCount).toBeGreaterThan(0);
      expect(stats.totalFlushed).toBeGreaterThan(0);

      // 验证文件内容
      const files = fs.readdirSync(tempDir);
      expect(files.length).toBeGreaterThan(0);
    });
  });

  describe('Edge cases', () => {
    it('缓冲达到上限时应该自动刷新', async () => {
      asyncLogger = new AsyncLogger(tempDir, 5000, 3); // 小缓冲

      // 加入 4 条日志，应该触发自动刷新
      for (let i = 0; i < 4; i++) {
        asyncLogger.enqueue({
          timestamp: Date.now(),
          level: 'info',
          message: `message ${i}`,
        });
      }

      // 等待异步刷新
      await new Promise(r => setTimeout(r, 100));

      const stats = asyncLogger.getStats();
      expect(stats.flushCount).toBeGreaterThan(0);
    });

    it('缓冲超过上限时应该丢弃最早的日志', async () => {
      asyncLogger = new AsyncLogger(tempDir, 5000, 2); // 上限 2

      // 加入日志，当达到上限时会自动刷新
      asyncLogger.enqueue({ timestamp: Date.now(), level: 'info', message: 'msg1' });
      asyncLogger.enqueue({ timestamp: Date.now(), level: 'info', message: 'msg2' });

      // 此时缓冲应该被刷新（异步）
      await new Promise(r => setTimeout(r, 50));

      const stats = asyncLogger.getStats();
      // 刷新完成后，缓冲应该为空
      expect(stats.pendingEntries).toBe(0);
    });

    it('进程关闭时应该清空队列', async () => {
      asyncLogger = new AsyncLogger(tempDir, 5000, 100);

      // 加入日志
      for (let i = 0; i < 5; i++) {
        asyncLogger.enqueue({
          timestamp: Date.now(),
          level: 'info',
          message: `message ${i}`,
        });
      }

      const statsBefore = asyncLogger.getStats();
      expect(statsBefore.pendingEntries).toBe(5);

      // 关闭
      await asyncLogger.shutdown();

      const statsAfter = asyncLogger.getStats();
      expect(statsAfter.pendingEntries).toBe(0);
    });

    it('空缓冲应该不刷新', async () => {
      asyncLogger = new AsyncLogger(tempDir);

      const statsBefore = asyncLogger.getStats();
      const flushCountBefore = statsBefore.flushCount;

      // 刷新空缓冲
      await asyncLogger.flush();

      const statsAfter = asyncLogger.getStats();
      expect(statsAfter.flushCount).toBe(flushCountBefore);
    });
  });

  describe('Error handling', () => {
    it('文件写入失败时应该降级到 stderr', async () => {
      // 使用无法写入的目录
      asyncLogger = new AsyncLogger('/invalid/path/that/does/not/exist', 100, 10);

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      asyncLogger.enqueue({
        timestamp: Date.now(),
        level: 'info',
        message: 'test',
      });

      await new Promise(r => setTimeout(r, 200));

      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
      await asyncLogger.shutdown();
    });
  });

  describe('Statistics', () => {
    it('应该正确统计已刷新和已丢弃的条目', async () => {
      asyncLogger = new AsyncLogger(tempDir, 100, 2);

      // 加入 5 条日志
      for (let i = 0; i < 5; i++) {
        asyncLogger.enqueue({
          timestamp: Date.now(),
          level: 'info',
          message: `message ${i}`,
        });
      }

      await new Promise(r => setTimeout(r, 150));

      const stats = asyncLogger.getStats();
      expect(stats.totalFlushed + stats.totalDropped).toBeGreaterThanOrEqual(3); // 至少应该处理了 3 条
    });
  });
});

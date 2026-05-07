import fs from 'fs';
import path from 'path';

/**
 * AsyncLogger - 异步日志缓冲层
 * 优化日志输出性能，避免主线程阻塞
 */

export interface LogEntry {
  timestamp: number;
  level: string;
  message: string;
  meta?: Record<string, any>;
}

export class AsyncLogger {
  private buffer: LogEntry[] = [];
  private maxBufferSize: number;
  private flushInterval: number;
  private timerId: NodeJS.Timeout | null = null;
  private stats = {
    totalFlushed: 0,
    totalDropped: 0,
    flushCount: 0,
  };
  private isFlushing = false;
  private fileHandle: fs.promises.FileHandle | null = null;
  private logsDir: string;

  constructor(logsDir: string, flushInterval: number = 5000, maxBufferSize: number = 1000) {
    this.logsDir = logsDir;
    this.flushInterval = flushInterval;
    this.maxBufferSize = maxBufferSize;

    // 启动定时刷新
    this.startFlushing();
  }

  /**
   * 加入日志条目到缓冲
   */
  enqueue(entry: LogEntry): void {
    if (this.buffer.length >= this.maxBufferSize) {
      // 缓冲满了，丢弃最早的日志并记录
      this.buffer.shift();
      this.stats.totalDropped++;
    }

    this.buffer.push(entry);

    // 如果缓冲达到上限，主动刷新
    if (this.buffer.length >= this.maxBufferSize) {
      this.flush().catch(err => {
        console.error('[AsyncLogger] flush error:', err.message);
      });
    }
  }

  /**
   * 批量刷新日志到文件
   */
  async flush(): Promise<void> {
    if (this.isFlushing || this.buffer.length === 0) {
      return;
    }

    this.isFlushing = true;

    try {
      const entries = this.buffer.splice(0);
      await this.writeToFile(entries);
      this.stats.totalFlushed += entries.length;
      this.stats.flushCount++;
    } catch (error) {
      console.error('[AsyncLogger] write error:', error);
      // entries already spliced — nothing to push back; they are lost on write failure
      // (acceptable tradeoff: prevents re-entrant flush loops)
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * 异步写入到文件
   */
  private async writeToFile(entries: LogEntry[]): Promise<void> {
    if (entries.length === 0) return;

    // 使用 setImmediate 避免阻塞事件循环
    return new Promise((resolve, reject) => {
      setImmediate(() => {
        try {
          const logsPath = path.join(this.logsDir, `app-${new Date().toISOString().split('T')[0]}.log`);

          // 同步写入（但在 setImmediate 中，所以不会阻塞主事件循环）
          const lines = entries
            .map(entry => {
              const metaStr = entry.meta && Object.keys(entry.meta).length > 0
                ? ` ${JSON.stringify(entry.meta)}`
                : '';
              return `${new Date(entry.timestamp).toISOString()} [${entry.level}] ${entry.message}${metaStr}`;
            })
            .join('\n');

          fs.appendFileSync(logsPath, lines + '\n');
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * 启动定时刷新
   */
  private startFlushing(): void {
    this.timerId = setInterval(() => {
      this.flush().catch(err => {
        console.error('[AsyncLogger] periodic flush error:', err.message);
      });
    }, this.flushInterval);

    // Node.js 进程关闭时，不阻塞退出
    if (this.timerId.unref) {
      this.timerId.unref();
    }
  }

  /**
   * 停止刷新并清空缓冲
   */
  async shutdown(): Promise<void> {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }

    // 最后一次刷新
    await this.flush();

    // 关闭文件句柄
    if (this.fileHandle) {
      try {
        await this.fileHandle.close();
        this.fileHandle = null;
      } catch (error) {
        console.error('[AsyncLogger] close error:', error);
      }
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      pendingEntries: this.buffer.length,
      maxBufferSize: this.maxBufferSize,
      totalFlushed: this.stats.totalFlushed,
      totalDropped: this.stats.totalDropped,
      flushCount: this.stats.flushCount,
      isFlushing: this.isFlushing,
    };
  }
}

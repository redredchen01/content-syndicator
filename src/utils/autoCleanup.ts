import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { systemMonitor } from './systemMonitor';

interface CleanupStats {
  tempFilesRemoved: number;
  tempFilesSize: string;
  oldLogsRemoved: number;
  cacheEntriesRemoved: number;
  totalSpaceFreed: string;
  diskSpaceBefore: string;
  diskSpaceAfter: string;
}

interface CleanupOptions {
  tempFiles?: boolean;
  oldLogs?: boolean;
  cache?: boolean;
  dryRun?: boolean;
}

class AutoCleanup {
  private dataDir: string;
  private tempFilePattern: RegExp = /temp_[a-f0-9-]+\.html?$/i;
  private maxLogFiles: number = 10;
  private minDiskSpaceMB: number = 500; // 最小剩余空间警告阈值
  private cleanupInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor() {
    this.dataDir = path.join(process.cwd(), '.data');
    
    // 启动时检查一次
    this.checkDiskSpace();
  }

  // 启动自动清理（每小时检查一次）
  startAutoCleanup(intervalMs: number = 3600000): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.cleanupInterval = setInterval(() => {
      this.runCleanup({ tempFiles: true, oldLogs: true, cache: true });
    }, intervalMs);

    logger.info(`Auto cleanup started (interval: ${intervalMs / 60000} min)`);
  }

  // 停止自动清理
  stopAutoCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.info('Auto cleanup stopped');
    }
  }

  // 主清理函数
  async runCleanup(options: CleanupOptions = {}): Promise<CleanupStats> {
    if (this.isRunning) {
      logger.warn('Cleanup already running, skipping...');
      return {
        tempFilesRemoved: 0,
        tempFilesSize: '0 B',
        oldLogsRemoved: 0,
        cacheEntriesRemoved: 0,
        totalSpaceFreed: '0 B',
        diskSpaceBefore: 'N/A',
        diskSpaceAfter: 'N/A',
      };
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      const diskBefore = this.getDiskSpace();
      let tempFilesRemoved = 0;
      let tempFilesSize = 0;
      let oldLogsRemoved = 0;
      let cacheEntriesRemoved = 0;

      logger.info('Starting cleanup...');

      // 1. 清理临时文件
      if (options.tempFiles !== false) {
        const tempResult = await this.cleanupTempFiles(options.dryRun || false);
        tempFilesRemoved = tempResult.count;
        tempFilesSize = tempResult.size;
      }

      // 2. 清理旧日志
      if (options.oldLogs !== false) {
        oldLogsRemoved = await this.cleanupOldLogs(options.dryRun || false);
      }

      // 3. 清理过期缓存
      if (options.cache !== false) {
        cacheEntriesRemoved = await this.cleanupCache(options.dryRun || false);
      }

      const diskAfter = this.getDiskSpace();
      const totalFreed = this.formatBytes(tempFilesSize);

      const stats: CleanupStats = {
        tempFilesRemoved,
        tempFilesSize: this.formatBytes(tempFilesSize),
        oldLogsRemoved,
        cacheEntriesRemoved,
        totalSpaceFreed: totalFreed,
        diskSpaceBefore: diskBefore,
        diskSpaceAfter: diskAfter,
      };

      const duration = Date.now() - startTime;
      systemMonitor.recordOperation('cleanup', duration, true, stats);

      logger.success(
        `Cleanup completed in ${duration}ms. ` +
        `Removed: ${tempFilesRemoved} temp files, ${oldLogsRemoved} old logs, ${cacheEntriesRemoved} cache entries. ` +
        `Freed: ${totalFreed}`
      );

      return stats;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      systemMonitor.recordOperation('cleanup', duration, false, { error: error.message });
      logger.error('Cleanup failed:', error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  private async cleanupTempFiles(dryRun: boolean): Promise<{ count: number; size: number }> {
    try {
      if (!fs.existsSync(this.dataDir)) {
        return { count: 0, size: 0 };
      }

      const files = fs.readdirSync(this.dataDir);
      let count = 0;
      let totalSize = 0;

      for (const file of files) {
        if (this.tempFilePattern.test(file)) {
          const filePath = path.join(this.dataDir, file);
          try {
            const stats = fs.statSync(filePath);
            totalSize += stats.size;
            count++;

            if (!dryRun) {
              fs.unlinkSync(filePath);
            }
          } catch (e: any) {
            logger.warn(`Failed to process temp file ${file}: ${e.message}`);
          }
        }
      }

      if (count > 0) {
        logger.info(
          `Temp files: ${dryRun ? '[DRY RUN] ' : ''}${count} files, ${this.formatBytes(totalSize)}`
        );
      }

      return { count, size: totalSize };
    } catch (error: any) {
      logger.warn(`Temp file cleanup error: ${error.message}`);
      return { count: 0, size: 0 };
    }
  }

  private async cleanupOldLogs(dryRun: boolean): Promise<number> {
    try {
      const logDir = path.join(this.dataDir, 'logs');
      if (!fs.existsSync(logDir)) {
        return 0;
      }

      const files = fs.readdirSync(logDir)
        .filter(f => f.startsWith('app.log'))
        .map(f => ({
          name: f,
          path: path.join(logDir, f),
          mtime: fs.statSync(path.join(logDir, f)).mtime,
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      // Keep only the newest maxLogFiles
      const toRemove = files.slice(this.maxLogFiles);
      let removed = 0;

      for (const file of toRemove) {
        if (!dryRun) {
          fs.unlinkSync(file.path);
        }
        removed++;
      }

      if (removed > 0) {
        logger.info(`Old logs: ${dryRun ? '[DRY RUN] ' : ''}removed ${removed} files`);
      }

      return removed;
    } catch (error: any) {
      logger.warn(`Old log cleanup error: ${error.message}`);
      return 0;
    }
  }

  private async cleanupCache(dryRun: boolean): Promise<number> {
    try {
      // This would integrate with the cache module
      // For now, just return 0 as the cache has its own cleanup
      return 0;
    } catch (error: any) {
      logger.warn(`Cache cleanup error: ${error.message}`);
      return 0;
    }
  }

  private getDiskSpace(): string {
    try {
      const stats = fs.statSync(this.dataDir);
      // This is a simplified version - actual disk space check would use system commands
      return 'N/A (use system tools)';
    } catch {
      return 'N/A';
    }
  }

  private checkDiskSpace(): void {
    try {
      const diskInfo = this.getDiskSpace();
      // In a real implementation, you'd check actual disk space
      // and warn if below minDiskSpaceMB
      logger.info(`Disk space check: ${diskInfo}`);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.warn(`Disk space check failed: ${error.message}`);
      }
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // 获取清理统计
  getCleanupInfo(): {
    dataDirExists: boolean;
    dataDirSize: string;
    tempFileCount: number;
    logFileCount: number;
  } {
    try {
      const dataDirExists = fs.existsSync(this.dataDir);
      let dataDirSize = 0;
      let tempFileCount = 0;
      let logFileCount = 0;

      if (dataDirExists) {
        const files = fs.readdirSync(this.dataDir);
        files.forEach(f => {
          try {
            const filePath = path.join(this.dataDir, f);
            const stats = fs.statSync(filePath);
            dataDirSize += stats.size;

            if (this.tempFilePattern.test(f)) {
              tempFileCount++;
            }
          } catch (e) {
            // Ignore individual file errors
          }
        });

        const logDir = path.join(this.dataDir, 'logs');
        if (fs.existsSync(logDir)) {
          logFileCount = fs.readdirSync(logDir).filter(f => f.startsWith('app.log')).length;
        }
      }

      return {
        dataDirExists,
        dataDirSize: this.formatBytes(dataDirSize),
        tempFileCount,
        logFileCount,
      };
    } catch (error: any) {
      logger.warn(`Failed to get cleanup info: ${error.message}`);
      return {
        dataDirExists: false,
        dataDirSize: '0 B',
        tempFileCount: 0,
        logFileCount: 0,
      };
    }
  }
}

export const autoCleanup = new AutoCleanup();

// 启动自动清理（可通过环境变量控制）
if (process.env.AUTO_CLEANUP !== 'false') {
  const interval = parseInt(process.env.CLEANUP_INTERVAL_MS || '3600000');
  autoCleanup.startAutoCleanup(interval);
}

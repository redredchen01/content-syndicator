import path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';

interface Memory {
  id: string;
  type: 'success' | 'failure' | 'strategy' | 'pattern';
  action?: string;
  context?: any;
  result?: any;
  timestamp: number;
  embedding?: number[]; // For semantic search (future enhancement)
}

export class AgentMemory {
  private memories: Memory[] = [];
  private memoryPath: string;
  private maxMemories = 1000;

  constructor() {
    this.memoryPath = path.join(process.cwd(), '.data', 'agent-memory.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.memoryPath)) {
        const data = fs.readFileSync(this.memoryPath, 'utf-8');
        this.memories = JSON.parse(data);
        logger.info(`[Memory] Loaded ${this.memories.length} memories`);
      }
    } catch (error: any) {
      logger.warn(`[Memory] Failed to load memories: ${error.message}`);
      this.memories = [];
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.memoryPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Keep only recent memories
      if (this.memories.length > this.maxMemories) {
        this.memories = this.memories.slice(-this.maxMemories);
      }
      fs.writeFileSync(this.memoryPath, JSON.stringify(this.memories), 'utf-8');
    } catch (error: any) {
      logger.warn(`[Memory] Failed to save memories: ${error.message}`);
    }
  }

  async remember(memory: Omit<Memory, 'id' | 'timestamp'>): Promise<void> {
    const newMemory: Memory = {
      ...memory,
      id: `mem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: Date.now(),
    };

    this.memories.push(newMemory);
    this.save();
    logger.info(`[Memory] Stored new memory: ${newMemory.id} (${memory.type})`);
  }

  async recall(task: string, _context: any): Promise<Memory[]> {
    const keywords = this.extractKeywords(task);
    const relevant = this.memories.filter(m => {
      // Only search lightweight fields — avoids stringify of large result objects
      const text = `${m.type} ${m.action ?? ''}`.toLowerCase();
      return keywords.some(kw => text.includes(kw));
    });
    return relevant.sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);
  }

  async recallByAction(action: string): Promise<Memory[]> {
    return this.memories
      .filter(m => m.action === action)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  async getSuccessfulPatterns(action: string): Promise<any[]> {
    const memories = await this.recallByAction(action);
    return memories
      .filter(m => m.type === 'success')
      .map(m => m.result)
      .slice(0, 5);
  }

  private extractKeywords(text: string): string[] {
    // Simple keyword extraction
    const words = text.toLowerCase().match(/\b\w{3,}\b/g) || [];
    const stopWords = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'have', 'from']);
    return [...new Set(words.filter(w => !stopWords.has(w)))];
  }

  clear(): void {
    this.memories = [];
    this.save();
    logger.info('[Memory] Cleared all memories');
  }

  getStats(): { total: number; byType: Record<string, number> } {
    const byType = this.memories.reduce<Record<string, number>>((acc, m) => {
      acc[m.type] = (acc[m.type] ?? 0) + 1;
      return acc;
    }, {});
    return { total: this.memories.length, byType };
  }
}

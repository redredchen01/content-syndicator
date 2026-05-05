#!/usr/bin/env tsx
/**
 * 检查模块间的循环依赖和单向依赖原则
 *
 * 使用方式：
 *   tsx scripts/check-circular-deps.ts
 *
 * 输出：
 *   - 无循环依赖时：✅ All checks passed
 *   - 有问题时：❌ Issues found，详细列表
 */

import fs from 'fs';
import path from 'path';

// 模块和文件路径的映射
const MODULE_MAP: Record<string, string[]> = {
  routes: ['src/routes'],
  services: ['src/services'],
  adapters: ['src/adapters'],
  db: ['src/db'],
  llm: ['src/llm'],
  utils: ['src/utils'],
  agent: ['src/agent'],
  sheets: ['src/sheets'],
  scraper: ['src/scraper'],
  cache: ['src/cache'],
  types: ['src/types'],
  prompts: ['src/prompts'],
  middleware: ['src/middleware']
};

interface Dependency {
  from: string;
  to: string;
}

// 解析文件中的 import 语句
function parseImports(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const imports: string[] = [];

    // 匹配 import 语句
    const importRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
    let match;

    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1];
      // 仅处理相对路径的内部导入
      if (importPath.startsWith('.') || importPath.startsWith('src/')) {
        imports.push(importPath);
      }
    }

    return imports;
  } catch (err) {
    return [];
  }
}

// 将导入路径转换为模块名
function getModuleFromImportPath(importPath: string): string | null {
  // 规范化路径
  let normalized = importPath
    .replace(/^\.\//, 'src/')
    .replace(/^\.\.\//, 'src/')
    .split('/')[1]; // 获取 src 后的第一个目录

  if (normalized === 'services' && importPath.includes('/queue')) {
    normalized = 'services'; // queue 是 services 的子模块
  }

  // 检查是否是有效的模块
  if (Object.keys(MODULE_MAP).includes(normalized)) {
    return normalized;
  }

  return null;
}

// 扫描所有 TypeScript 文件并收集依赖
function collectDependencies(baseDir: string): Dependency[] {
  const dependencies: Dependency[] = [];
  const visited = new Set<string>();

  function walkDir(dir: string) {
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir);

    for (const file of files) {
      if (file.startsWith('.') || file === 'node_modules' || file === '__tests__') {
        continue;
      }

      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        walkDir(filePath);
      } else if ((file.endsWith('.ts') || file.endsWith('.tsx')) && !file.includes('.test.')) {
        if (visited.has(filePath)) continue;
        visited.add(filePath);

        // 识别文件所属的模块
        let fromModule: string | null = null;
        for (const [module, paths] of Object.entries(MODULE_MAP)) {
          for (const modPath of paths) {
            if (filePath.includes(`/${modPath}/`)) {
              fromModule = module;
              break;
            }
          }
          if (fromModule) break;
        }

        if (!fromModule) continue;

        // 解析导入
        const imports = parseImports(filePath);
        for (const imp of imports) {
          const toModule = getModuleFromImportPath(imp);
          if (toModule && toModule !== fromModule) {
            // 避免重复
            if (!dependencies.find(d => d.from === fromModule && d.to === toModule)) {
              dependencies.push({ from: fromModule, to: toModule });
            }
          }
        }
      }
    }
  }

  walkDir(baseDir);
  return dependencies;
}

// 检查循环依赖（DFS）
function findCycles(dependencies: Dependency[]): Dependency[][] {
  const graph: Record<string, string[]> = {};
  const modules = new Set<string>();

  // 构建邻接表
  for (const dep of dependencies) {
    modules.add(dep.from);
    modules.add(dep.to);
    if (!graph[dep.from]) {
      graph[dep.from] = [];
    }
    graph[dep.from].push(dep.to);
  }

  const cycles: Dependency[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function dfs(node: string, path: string[]): void {
    if (visiting.has(node)) {
      // 找到循环
      const cycleStart = path.indexOf(node);
      const cycle = path.slice(cycleStart).concat(node);
      const cycleDeps: Dependency[] = [];
      for (let i = 0; i < cycle.length - 1; i++) {
        cycleDeps.push({ from: cycle[i], to: cycle[i + 1] });
      }
      cycles.push(cycleDeps);
      return;
    }

    if (visited.has(node)) {
      return;
    }

    visiting.add(node);
    path.push(node);

    for (const neighbor of graph[node] || []) {
      dfs(neighbor, [...path]);
    }

    path.pop();
    visiting.delete(node);
    visited.add(node);
  }

  for (const module of modules) {
    if (!visited.has(module)) {
      dfs(module, []);
    }
  }

  return cycles;
}

// 检查单向依赖原则
function checkUnidirectionalPrinciples(dependencies: Dependency[]): string[] {
  const violations: string[] = [];

  // 定义允许的依赖（白名单）
  const allowedDependencies = new Set<string>([
    // utils 可以依赖的模块
    'utils→types',      // types 是纯类型定义，非业务模块

    // types 可以依赖的模块
    'types→utils',

    // cache, scraper, sheets, agent 可以依赖的模块
    'cache→utils',
    'cache→scraper',    // 缓存爬虫结果
    'scraper→utils',
    'sheets→utils',
    'agent→utils',
    'agent→llm',
    'agent→services',
    'agent→types',
    'agent→prompts',

    // llm 可以依赖scraper（用于DOM分析）
    'llm→scraper',

    // prompts 可以依赖的模块
    'prompts→utils',
    'prompts→types',

    // db 可以依赖的模块
    'db→utils',
    'db→types',

    // llm 可以依赖的模块
    'llm→utils',
    'llm→types',

    // adapters 可以依赖的模块
    'adapters→utils',
    'adapters→types',
    'adapters→llm',

    // services 可以依赖的模块
    'services→utils',
    'services→types',
    'services→db',
    'services→llm',
    'services→adapters',
    'services→cache',
    'services→scraper',
    'services→sheets',
    'services→agent',
    'services→prompts',

    // routes 可以依赖的模块
    'routes→utils',
    'routes→types',
    'routes→services',
    'routes→middleware',
    'routes→adapters',  // 类型定义和某些路由逻辑
    'routes→db',        // 数据库类型
    'routes→llm',       // LLM 类型
    'routes→scraper',   // 爬虫类型
    'routes→sheets',    // Sheets 类型

    // middleware 可以依赖的模块
    'middleware→utils',
    'middleware→types'
  ]);

  for (const dep of dependencies) {
    const depKey = `${dep.from}→${dep.to}`;
    if (!allowedDependencies.has(depKey)) {
      violations.push(`❌ 不允许的依赖：${dep.from} → ${dep.to}`);
    }
  }

  return violations;
}

// 识别红旗项（出向依赖过多）
function findRedFlags(dependencies: Dependency[]): Record<string, string[]> {
  const outgoing: Record<string, Set<string>> = {};

  for (const dep of dependencies) {
    if (!outgoing[dep.from]) {
      outgoing[dep.from] = new Set();
    }
    outgoing[dep.from].add(dep.to);
  }

  const redFlags: Record<string, string[]> = {};

  for (const [module, targets] of Object.entries(outgoing)) {
    if (targets.size >= 5) {
      redFlags[module] = Array.from(targets);
    }
  }

  return redFlags;
}

// 主函数
function main() {
  const baseDir = path.join(process.cwd(), 'src');

  console.log('🔍 检查模块依赖关系...\n');

  // 收集依赖
  const dependencies = collectDependencies(baseDir);
  console.log(`📊 检查到 ${dependencies.length} 条依赖关系\n`);

  // 检查循环依赖
  const cycles = findCycles(dependencies);
  if (cycles.length > 0) {
    console.log('❌ 发现循环依赖：');
    for (const cycle of cycles) {
      const path = cycle.map(d => d.from).join(' → ') + ` → ${cycle[0].to}`;
      console.log(`   ${path}`);
    }
    console.log();
  } else {
    console.log('✅ 无循环依赖\n');
  }

  // 检查单向依赖原则
  const violations = checkUnidirectionalPrinciples(dependencies);
  if (violations.length > 0) {
    console.log('❌ 发现单向依赖违反：');
    for (const violation of violations) {
      console.log(`   ${violation}`);
    }
    console.log();
  } else {
    console.log('✅ 单向依赖原则遵守完好\n');
  }

  // 识别红旗项
  const redFlags = findRedFlags(dependencies);
  if (Object.keys(redFlags).length > 0) {
    console.log('⚠️  红旗项（出向依赖 ≥ 5）：');
    for (const [module, targets] of Object.entries(redFlags)) {
      // 检查是否是合理的红旗项
      const isReasonable = module === 'services'; // services 作为编排层，多个依赖是合理的
      const mark = isReasonable ? '⚠️ ' : '❌ ';
      console.log(`   ${mark}${module} → [${targets.join(', ')}]`);
      if (isReasonable) {
        console.log(`      (合理：${module} 是业务编排层)`);
      }
    }
    console.log();
  }

  // 输出汇总
  const hasIssues = cycles.length > 0 || violations.length > 0;
  if (hasIssues) {
    console.log('🚨 检查失败。详见上述问题。');
    process.exit(1);
  } else {
    console.log('✨ 所有检查通过！');
    process.exit(0);
  }
}

// 运行
if (require.main === module) {
  main();
}

export { collectDependencies, findCycles, checkUnidirectionalPrinciples, findRedFlags };

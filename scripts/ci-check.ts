/**
 * CI Preflight Check — Phase 4, Unit 18
 *
 * Enhanced startup verification script for both local dev and CI environments.
 * Validates: Node.js version, npm, dependencies, env vars, DB, logs dir, circular deps.
 *
 * Run before deployment or dev startup:
 *   npx tsx scripts/ci-check.ts [--strict]
 *
 * Outputs:
 *   - Console: colored report with ✅ / ⚠️ / ❌ status
 *   - .data/ci-check-report.json: machine-readable report for CI
 *   - Exit code: 0 (all pass) | 1 (warnings acceptable) | 2 (critical fail)
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
};

interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  details?: string;
}

const results: CheckResult[] = [];
const strict = process.argv.includes('--strict');

function log(color: string, status: string, name: string, message: string) {
  const icon =
    status === 'pass'
      ? '✅'
      : status === 'warn'
        ? '⚠️ '
        : '❌';
  console.log(`${color}${icon} ${name}${colors.reset}: ${message}`);
}

function check(name: string, status: 'pass' | 'warn' | 'fail', message: string, details?: string) {
  results.push({ name, status, message, details });
  const color =
    status === 'pass'
      ? colors.green
      : status === 'warn'
        ? colors.yellow
        : colors.red;
  log(color, status, name, message);
}

// ========================================
// 1. Node.js Version Check
// ========================================
function checkNodeVersion() {
  const version = process.version.slice(1); // Remove 'v'
  const major = parseInt(version.split('.')[0], 10);

  if (major >= 18) {
    check('Node.js', 'pass', `v${version} (≥18 required)`);
  } else {
    check('Node.js', 'fail', `v${version} is too old (need ≥18.0.0)`);
  }
}

// ========================================
// 2. npm Version Check
// ========================================
function checkNpm() {
  try {
    const version = execSync('npm -v', { encoding: 'utf8' }).trim();
    const major = parseInt(version.split('.')[0], 10);

    if (major >= 9) {
      check('npm', 'pass', `v${version} (≥9 required)`);
    } else {
      check('npm', 'warn', `v${version} is older (recommend ≥9.0.0)`);
    }
  } catch {
    check('npm', 'fail', 'npm not found in PATH');
  }
}

// ========================================
// 3. Dependencies Check
// ========================================
function checkDependencies() {
  try {
    const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      check('Dependencies', 'fail', 'package.json not found');
      return;
    }

    const nodeModulesPath = path.resolve(__dirname, '..', 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
      check('Dependencies', 'warn', 'node_modules not found; run: npm install');
      return;
    }

    // Check critical dependencies
    const critical = ['express', 'winston', 'better-sqlite3', 'vitest'];
    const missing = critical.filter(
      (dep) => !fs.existsSync(path.join(nodeModulesPath, dep))
    );

    if (missing.length === 0) {
      check('Dependencies', 'pass', 'all critical packages installed');
    } else {
      check('Dependencies', 'warn', `missing: ${missing.join(', ')}; run: npm install`);
    }
  } catch {
    check('Dependencies', 'fail', 'error checking dependencies');
  }
}

// ========================================
// 4. Environment Variables Check
// ========================================
function checkEnv() {
  const required = ['NODE_ENV'];
  const recommended = [
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
  ];

  const missing = required.filter((k) => !process.env[k]);
  const empty = recommended.filter((k) => !process.env[k]);

  if (missing.length > 0) {
    check('Environment', 'fail', `missing required: ${missing.join(', ')}`);
  } else if (empty.length > 0) {
    check('Environment', 'warn', `${empty.length} optional vars not set (see .dev.env.example)`);
  } else {
    check('Environment', 'pass', 'all critical env vars configured');
  }
}

// ========================================
// 5. Database Check
// ========================================
function checkDatabase() {
  try {
    const dataDir = path.resolve(__dirname, '..', '.data');
    const dbPath = path.join(dataDir, 'syndicator.db');

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    if (!fs.existsSync(dbPath)) {
      check('Database', 'warn', 'syndicator.db not found; will be created on first startup');
    } else {
      // Try to read schema
      try {
        execSync(`sqlite3 "${dbPath}" ".tables"`, { encoding: 'utf8', timeout: 5000 });
        check('Database', 'pass', 'SQLite database accessible');
      } catch {
        check('Database', 'warn', 'database exists but may be corrupted');
      }
    }
  } catch (err) {
    check('Database', 'fail', `error checking database: ${(err as Error).message}`);
  }
}

// ========================================
// 6. Logs Directory Check
// ========================================
function checkLogsDir() {
  try {
    const logsDir = path.resolve(__dirname, '..', '.data', 'logs');

    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Try to create a test file
    const testFile = path.join(logsDir, '.test-write');
    fs.writeFileSync(testFile, '');
    fs.unlinkSync(testFile);

    check('Logs Directory', 'pass', `.data/logs/ is writable`);
  } catch (err) {
    check('Logs Directory', 'warn', `cannot write to logs dir: ${(err as Error).message}`);
  }
}

// ========================================
// 7. Circular Dependencies Check
// ========================================
function checkCircularDeps() {
  try {
    const scriptPath = path.resolve(__dirname, 'check-circular-deps.ts');

    if (!fs.existsSync(scriptPath)) {
      check('Circular Deps', 'warn', 'check-circular-deps.ts script not found (optional)');
      return;
    }

    try {
      execSync(`npx tsx "${scriptPath}"`, {
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe'
      });
      check('Circular Deps', 'pass', 'no circular dependencies detected');
    } catch (err) {
      const output = (err as any).stdout || (err as Error).message;
      if (output.includes('PASS')) {
        check('Circular Deps', 'pass', 'no circular dependencies detected');
      } else {
        check('Circular Deps', 'fail', 'circular dependencies detected', output);
      }
    }
  } catch {
    check('Circular Deps', 'warn', 'could not run circular deps check');
  }
}

// ========================================
// 8. Tests Check (optional, slow)
// ========================================
function checkTests() {
  if (!process.argv.includes('--full')) {
    return; // Skip in quick mode
  }

  console.log(`\n${colors.blue}Running test suite...${colors.reset}`);
  try {
    execSync('npm test 2>&1', {
      encoding: 'utf8',
      timeout: 120000,
      stdio: 'pipe'
    });
    check('Tests', 'pass', 'all tests passing');
  } catch (err) {
    const output = (err as any).stdout || '';
    const match = output.match(/(\d+)\s+(?:failed|passed)/);
    check('Tests', 'fail', 'test suite failed', output.slice(0, 500));
  }
}

// ========================================
// 9. Git Status Check (optional)
// ========================================
function checkGit() {
  try {
    const status = execSync('git status --porcelain', {
      encoding: 'utf8',
      cwd: path.resolve(__dirname, '..')
    });

    const lines = status.split('\n').filter(Boolean);
    if (lines.length === 0) {
      check('Git', 'pass', 'working directory clean');
    } else {
      check('Git', 'warn', `${lines.length} uncommitted changes`);
    }
  } catch {
    check('Git', 'warn', 'not in a git repository');
  }
}

// ========================================
// Report Generation
// ========================================
function generateReport() {
  const summary = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    npmVersion: execSync('npm -v', { encoding: 'utf8' }).trim(),
    environment: process.env.NODE_ENV,
    results,
    summary: {
      pass: results.filter((r) => r.status === 'pass').length,
      warn: results.filter((r) => r.status === 'warn').length,
      fail: results.filter((r) => r.status === 'fail').length,
    },
  };

  // Write JSON report
  const reportPath = path.resolve(__dirname, '..', '.data', 'ci-check-report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));

  return summary;
}

// ========================================
// Main
// ========================================
async function main() {
  console.log(`${colors.blue}========================================${colors.reset}`);
  console.log(`${colors.blue}  Content Syndicator - CI Preflight Check${colors.reset}`);
  console.log(`${colors.blue}========================================${colors.reset}\n`);

  checkNodeVersion();
  checkNpm();
  checkDependencies();
  checkEnv();
  checkDatabase();
  checkLogsDir();
  checkCircularDeps();
  checkGit();
  checkTests();

  const summary = generateReport();

  // Summary
  console.log(`\n${colors.blue}========================================${colors.reset}`);
  console.log(
    `${colors.blue}Summary: ${colors.green}${summary.summary.pass} pass ${colors.yellow}${summary.summary.warn} warn ${colors.red}${summary.summary.fail} fail${colors.reset}`
  );
  console.log(`${colors.blue}Report saved to: .data/ci-check-report.json${colors.reset}`);
  console.log(`${colors.blue}========================================${colors.reset}\n`);

  // Exit code logic
  if (summary.summary.fail > 0) {
    process.exit(2); // Critical failure
  } else if (summary.summary.warn > 0 && strict) {
    process.exit(1); // Warnings treated as errors in strict mode
  } else {
    process.exit(0); // Success
  }
}

main().catch((err) => {
  console.error(`${colors.red}Fatal error:${colors.reset}`, err);
  process.exit(2);
});

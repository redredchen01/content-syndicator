import path from 'path';
import fs from 'fs';
import { logger } from './logger';

interface ConfigCheck {
  name: string;
  key: string;
  required: boolean;
  type: 'string' | 'number' | 'boolean' | 'json';
  format?: string; // 正则或特殊格式：'api_key', 'url', 'json'
  defaultValue?: any;
  validator?: (value: any) => { valid: boolean; message?: string };
}

interface ConfigReport {
  valid: boolean;
  checks: Array<{
    name: string;
    key: string;
    present: boolean;
    valid: boolean;
    value: string; // masked
    message?: string;
    defaultValue?: any;
  }>;
  errors: string[];
  warnings: string[];
  suggestions: string[];
}

class ConfigValidator {
  private configs: ConfigCheck[] = [
    // LLM Config
    { name: 'OpenAI API Key', key: 'OPENAI_API_KEY', required: false, type: 'string', format: 'api_key' },
    { name: 'Gemini API Key', key: 'GEMINI_API_KEY', required: false, type: 'string', format: 'api_key' },
    { name: 'Selected Model', key: 'SLECTED_MODEL', required: false, type: 'string', defaultValue: 'gpt-4o-mini' },

    // Platform Config
    { name: 'Dev.to API Key', key: 'DEVTO_API_KEY', required: false, type: 'string', format: 'api_key' },
    { name: 'Medium Integration Token', key: 'MEDIUM_INTEGRATION_TOKEN', required: false, type: 'string', format: 'api_key' },
    { name: 'GitHub Token', key: 'GITHUB_TOKEN', required: false, type: 'string', format: 'api_key' },
    { name: 'Hashnode Token', key: 'HASHNODE_TOKEN', required: false, type: 'string', format: 'api_key' },
    { name: 'Hashnode Publication ID', key: 'HASHNODE_PUBLICATION_ID', required: false, type: 'string' },
    { name: 'Blogger Blog ID', key: 'BLOGGER_BLOG_ID', required: false, type: 'string' },
    { name: 'WordPress Site URL', key: 'WORDPRESS_SITE_URL', required: false, type: 'string', format: 'url' },
    { name: 'WordPress Username', key: 'WORDPRESS_USERNAME', required: false, type: 'string' },
    { name: 'WordPress App Password', key: 'WORDPRESS_APP_PASSWORD', required: false, type: 'string', format: 'api_key' },

    // Google Sheets
    { name: 'Google Application Credentials JSON', key: 'GOOGLE_APPLICATION_CREDENTIALS_JSON', required: false, type: 'json' },
    { name: 'Google Sheet ID', key: 'GOOGLE_SHEET_ID', required: false, type: 'string' },

    // Browser
    { name: 'Browser Automation Enabled', key: 'ENABLE_BROWSER_AUTOMATION', required: false, type: 'boolean', defaultValue: 'false' },
    { name: 'Browser Auth Mode', key: 'BROWSER_AUTH_MODE', required: false, type: 'string', defaultValue: 'chromium' },
    { name: 'Browser Headless', key: 'BROWSER_HEADLESS', required: false, type: 'boolean', defaultValue: 'true' },

    // System
    { name: 'Log Level', key: 'LOG_LEVEL', required: false, type: 'string', defaultValue: 'info' },
    { name: 'Log to Console', key: 'LOG_CONSOLE', required: false, type: 'boolean', defaultValue: 'true' },
    { name: 'Log to File', key: 'LOG_FILE', required: false, type: 'boolean', defaultValue: 'true' },
  ];

  validate(): ConfigReport {
    const report: ConfigReport = {
      valid: true,
      checks: [],
      errors: [],
      warnings: [],
      suggestions: [],
    };

    for (const config of this.configs) {
      const envValue = process.env[config.key];
      const present = envValue !== undefined && envValue.trim() !== '';
      const check: any = {
        name: config.name,
        key: config.key,
        present,
        valid: true,
        value: this.maskValue(config.key, envValue),
        defaultValue: config.defaultValue,
      };

      if (!present) {
        if (config.required) {
          check.valid = false;
          check.message = 'Required configuration is missing';
          report.errors.push(`${config.name} (${config.key}) is required but not set`);
          report.valid = false;
        } else {
          check.message = 'Not set (optional)';
          if (config.defaultValue) {
            report.suggestions.push(`${config.name} (${config.key}) not set. Default: ${config.defaultValue}`);
          }
        }
      } else {
        // Validate format
        const validation = this.validateValue(config, envValue!);
        if (!validation.valid) {
          check.valid = false;
          check.message = validation.message;
          report.errors.push(`${config.name}: ${validation.message}`);
          report.valid = false;
        }
      }

      report.checks.push(check);
    }

    // Cross-validations
    this.crossValidate(report);

    return report;
  }

  private validateValue(config: ConfigCheck, value: string): { valid: boolean; message?: string } {
    // Type check
    if (config.type === 'number') {
      const num = Number(value);
      if (isNaN(num)) {
        return { valid: false, message: 'Must be a number' };
      }
    } else if (config.type === 'boolean') {
      if (!['true', 'false', '1', '0'].includes(value.toLowerCase())) {
        return { valid: false, message: 'Must be true/false' };
      }
    } else if (config.type === 'json') {
      try {
        JSON.parse(value);
      } catch {
        return { valid: false, message: 'Invalid JSON format' };
      }
    }

    // Format check
    if (config.format === 'api_key') {
      if (value.length < 10) {
        return { valid: false, message: 'API key seems too short' };
      }
    } else if (config.format === 'url') {
      try {
        new URL(value);
      } catch {
        return { valid: false, message: 'Invalid URL format' };
      }
    }

    // Custom validator
    if (config.validator) {
      return config.validator(value);
    }

    return { valid: true };
  }

  private maskValue(key: string, value: string | undefined): string {
    if (!value) return '(not set)';

    // API keys
    if (key.includes('API_KEY') || key.includes('TOKEN') || key.includes('PASSWORD') || key.includes('SECRET')) {
      if (value.length <= 8) return '*'.repeat(value.length);
      return value.substring(0, 4) + '*'.repeat(value.length - 8) + value.substring(value.length - 4);
    }

    // JSON
    if (key.includes('JSON')) {
      return '{"masked": true}';
    }

    // URL
    if (key.includes('URL') || key.includes('URI')) {
      try {
        const url = new URL(value);
        return url.protocol + '//' + url.hostname + '/...';
      } catch {
        return value.substring(0, 30) + '...';
      }
    }

    // Default: show first 50 chars
    return value.length > 50 ? value.substring(0, 50) + '...' : value;
  }

  private crossValidate(report: ConfigReport): void {
    // Check if at least one LLM is configured
    const hasOpenAI = report.checks.find(c => c.key === 'OPENAI_API_KEY')?.present;
    const hasGemini = report.checks.find(c => c.key === 'GEMINI_API_KEY')?.present;

    if (!hasOpenAI && !hasGemini) {
      report.warnings.push('No LLM configured. Set OPENAI_API_KEY or GEMINI_API_KEY');
      report.valid = false;
    }

    // Check Google Sheets config
    const hasGoogleCreds = report.checks.find(c => c.key === 'GOOGLE_APPLICATION_CREDENTIALS_JSON')?.present;
    const hasSheetId = report.checks.find(c => c.key === 'GOOGLE_SHEET_ID')?.present;

    if (hasGoogleCreds && !hasSheetId) {
      report.warnings.push('Google credentials set but GOOGLE_SHEET_ID is missing');
    }

    if (!hasGoogleCreds && hasSheetId) {
      report.warnings.push('GOOGLE_SHEET_ID set but Google credentials are missing');
    }

    // Check WordPress config
    const hasWPURL = report.checks.find(c => c.key === 'WORDPRESS_SITE_URL')?.present;
    const hasWPUser = report.checks.find(c => c.key === 'WORDPRESS_USERNAME')?.present;
    const hasWPPass = report.checks.find(c => c.key === 'WORDPRESS_APP_PASSWORD')?.present;

    if ((hasWPURL || hasWPUser || hasWPPass) && !(hasWPURL && hasWPUser && hasWPPass)) {
      report.warnings.push('WordPress configuration is incomplete. All three (URL, username, password) are required');
    }

    // Check browser automation
    const browserEnabled = report.checks.find(c => c.key === 'ENABLE_BROWSER_AUTOMATION')?.present;
    if (browserEnabled) {
      report.suggestions.push('Browser automation is enabled. Make sure to run browser auth first (POST /api/auth/browser)');
    }
  }

  generateReportText(report: ConfigReport): string {
    const lines = [
      '=== Configuration Validation Report ===',
      `Valid: ${report.valid ? '✅ YES' : '❌ NO'}`,
      `Checks: ${report.checks.length}`,
      `Errors: ${report.errors.length}`,
      `Warnings: ${report.warnings.length}`,
      '',
    ];

    // Group by category
    const categories = {
      'LLM': ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'SLECTED_MODEL'],
      'Platforms': ['DEVTO_API_KEY', 'MEDIUM_INTEGRATION_TOKEN', 'GITHUB_TOKEN', 'HASHNODE_TOKEN', 'HASHNODE_PUBLICATION_ID', 'BLOGGER_BLOG_ID', 'WORDPRESS_SITE_URL', 'WORDPRESS_USERNAME', 'WORDPRESS_APP_PASSWORD'],
      'Google Sheets': ['GOOGLE_APPLICATION_CREDENTIALS_JSON', 'GOOGLE_SHEET_ID'],
      'Browser': ['ENABLE_BROWSER_AUTOMATION', 'BROWSER_AUTH_MODE', 'BROWSER_HEADLESS'],
      'System': ['LOG_LEVEL', 'LOG_CONSOLE', 'LOG_FILE'],
    };

    for (const [category, keys] of Object.entries(categories)) {
      lines.push(`\n--- ${category} ---`);
      const categoryChecks = report.checks.filter(c => keys.includes(c.key));
      
      for (const check of categoryChecks) {
        const icon = !check.present ? '⚪' : (check.valid ? '✅' : '❌');
        lines.push(`  ${icon} ${check.name}: ${check.value}`);
        if (check.message) {
          lines.push(`     Message: ${check.message}`);
        }
      }
    }

    if (report.errors.length > 0) {
      lines.push('\n--- Errors ---');
      report.errors.forEach(e => lines.push(`  ❌ ${e}`));
    }

    if (report.warnings.length > 0) {
      lines.push('\n--- Warnings ---');
      report.warnings.forEach(w => lines.push(`  ⚠️  ${w}`));
    }

    if (report.suggestions.length > 0) {
      lines.push('\n--- Suggestions ---');
      report.suggestions.forEach(s => lines.push(`  💡 ${s}`));
    }

    return lines.join('\n');
  }

  // Apply default values to process.env
  applyDefaults(): void {
    for (const config of this.configs) {
      if (!process.env[config.key] && config.defaultValue !== undefined) {
        process.env[config.key] = String(config.defaultValue);
        logger.info(`Applied default value for ${config.key}: ${config.defaultValue}`);
      }
    }
  }

  // Generate sample .env file
  generateSampleEnv(): string {
    const lines = [
      '# Sample .env file for Content Syndicator Agent',
      '# Copy this to .env and fill in your values',
      '',
    ];

    const categories = {
      'LLM Configuration': ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'SLECTED_MODEL'],
      'Platform API Keys': ['DEVTO_API_KEY', 'MEDIUM_INTEGRATION_TOKEN', 'GITHUB_TOKEN', 'HASHNODE_TOKEN', 'HASHNODE_PUBLICATION_ID', 'BLOGGER_BLOG_ID'],
      'WordPress': ['WORDPRESS_SITE_URL', 'WORDPRESS_USERNAME', 'WORDPRESS_APP_PASSWORD'],
      'Google Sheets Integration': ['GOOGLE_APPLICATION_CREDENTIALS_JSON', 'GOOGLE_SHEET_ID'],
      'Browser Automation': ['ENABLE_BROWSER_AUTOMATION', 'BROWSER_AUTH_MODE', 'BROWSER_HEADLESS'],
      'System Settings': ['LOG_LEVEL', 'LOG_CONSOLE', 'LOG_FILE'],
    };

    for (const [category, keys] of Object.entries(categories)) {
      lines.push(`\n# ${category}`);
      const categoryConfigs = this.configs.filter(c => keys.includes(c.key));
      
      for (const config of categoryConfigs) {
        const value = config.defaultValue !== undefined ? String(config.defaultValue) : '';
        const required = config.required ? ' (required)' : ' (optional)';
        lines.push(`# ${config.name}${required}`);
        lines.push(`${config.key}=${value}`);
      }
    }

    return lines.join('\n');
  }
}

export const configValidator = new ConfigValidator();

// Auto-validate on import (can be disabled via env)
if (process.env.SKIP_CONFIG_VALIDATION !== 'true') {
  try {
    configValidator.applyDefaults();
    const report = configValidator.validate();
    
    if (!report.valid) {
      logger.warn('Configuration validation failed. Check /api/config/report for details.');
    }

    if (report.warnings.length > 0) {
      logger.warn(`Configuration has ${report.warnings.length} warning(s)`);
    }
  } catch (error: any) {
    logger.error('Config validation error:', error);
  }
}

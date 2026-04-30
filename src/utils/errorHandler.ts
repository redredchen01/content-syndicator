import { ErrorType } from './smartRetry';
import { logger } from './logger';
import { systemMonitor } from './systemMonitor';

interface ErrorAdvice {
  type: ErrorType;
  message: string;
  userMessage: string;
  suggestions: string[];
  docLink?: string;
}

interface ErrorReport {
  timestamp: string;
  type: ErrorType;
  message: string;
  stack?: string;
  context?: string;
  suggestions: string[];
}

class ErrorHandler {
  private errorHistory: ErrorReport[] = [];
  private maxHistory = 500;
  private adviceMap: Map<ErrorType, ErrorAdvice> = new Map();

  constructor() {
    this.setupAdvice();
  }

  private setupAdvice(): void {
    this.adviceMap.set(ErrorType.NETWORK, {
      type: ErrorType.NETWORK,
      message: 'Network connection failed',
      userMessage: '网络连接失败，请检查网络设置',
      suggestions: [
        '检查网络连接是否正常',
        '检查防火墙设置（确保程序可以访问网络）',
        '尝试使用代理（设置 BROWSER_PROXY 环境变量）',
        '稍后重试',
      ],
      docLink: 'https://example.com/docs/errors/network',
    });

    this.adviceMap.set(ErrorType.RATE_LIMIT, {
      type: ErrorType.RATE_LIMIT,
      message: 'API rate limit exceeded',
      userMessage: 'API 请求频率超限，请稍后重试',
      suggestions: [
        '等待 1-5 分钟后重试',
        '增加请求间隔时间（调整 .env 中的 MIN_SLEEP_MS 和 MAX_SLEEP_MS）',
        '考虑升级 API 套餐（如果使用 OpenAI/Google）',
        '检查是否已超出每日配额',
      ],
      docLink: 'https://example.com/docs/errors/rate-limit',
    });

    this.adviceMap.set(ErrorType.AUTH, {
      type: ErrorType.AUTH,
      message: 'Authentication failed',
      userMessage: '认证失败，请检查 API 密钥配置',
      suggestions: [
        '检查 .env 中的 API 密钥是否正确',
        '确保 API 密钥未过期',
        '对于 Google Sheets：确保服务账号有编辑权限',
        '对于 WordPress：确保应用密码正确生成',
        '运行 GET /api/config/report 检查配置',
      ],
      docLink: 'https://example.com/docs/errors/auth',
    });

    this.adviceMap.set(ErrorType.NOT_FOUND, {
      type: ErrorType.NOT_FOUND,
      message: 'Resource not found',
      userMessage: '请求的资源不存在',
      suggestions: [
        '检查 URL 是否正确',
        '确认目标平台配置正确',
        '对于浏览器自动化：确保已运行 /api/auth/browser 登录',
      ],
      docLink: 'https://example.com/docs/errors/not-found',
    });

    this.adviceMap.set(ErrorType.SERVER_ERROR, {
      type: ErrorType.SERVER_ERROR,
      message: 'Server error occurred',
      userMessage: '服务器错误，请稍后重试',
      suggestions: [
        '等待几分钟后重试',
        '检查平台状态页（如 status.medium.com）',
        '如果持续出现，考虑降低请求频率',
      ],
      docLink: 'https://example.com/docs/errors/server',
    });

    this.adviceMap.set(ErrorType.TIMEOUT, {
      type: ErrorType.TIMEOUT,
      message: 'Request timeout',
      userMessage: '请求超时，请稍后重试',
      suggestions: [
        '增加超时时间（调整 constants.ts 中的超时配置）',
        '检查网络连接速度',
        '尝试减少并发请求',
        '对于抓取：尝试简化 URL 或使用备用方案',
      ],
      docLink: 'https://example.com/docs/errors/timeout',
    });

    this.adviceMap.set(ErrorType.UNKNOWN, {
      type: ErrorType.UNKNOWN,
      message: 'An unknown error occurred',
      userMessage: '发生未知错误',
      suggestions: [
        '查看日志获取详细信息（GET /api/logs）',
        '尝试重启服务',
        '如果问题持续，请报告错误',
      ],
      docLink: 'https://example.com/docs/errors/unknown',
    });
  }

  handleError(error: any, context?: string): {
    type: ErrorType;
    message: string;
    userMessage: string;
    suggestions: string[];
    stack?: string;
    context?: string;
  } {
    const errorType = this.classifyError(error);
    const advice = this.adviceMap.get(errorType) || this.adviceMap.get(ErrorType.UNKNOWN)!;

    const report: ErrorReport = {
      timestamp: new Date().toISOString(),
      type: errorType,
      message: error?.message || String(error),
      stack: error?.stack,
      context,
      suggestions: advice.suggestions,
    };

    this.errorHistory.push(report);
    if (this.errorHistory.length > this.maxHistory) {
      this.errorHistory = this.errorHistory.slice(-this.maxHistory);
    }

    // Log to system monitor
    systemMonitor.recordOperation(`error.${errorType}`, 0, false, {
      context,
      message: (hasMessage(error) ? error.message.substring(0, 100) : 'Unknown error',
    });

    const errorMessage = hasMessage(error) ? error.message : String(error);
    logger.error(`[${context || 'Unknown'}] ${advice.message} | ${errorMessage}`);

    return {
      type: errorType,
      message: advice.message,
      userMessage: advice.userMessage,
      suggestions: advice.suggestions,
      stack: error?.stack,
      context,
    };
  }

  private classifyError(error: any): ErrorType {
    // Reuse the classification logic from smartRetry
    const message = (error?.message || '').toLowerCase();
    const code = error?.code || error?.status || error?.statusCode;
    const status = error?.response?.status || code;

    if (message.includes('timeout') || message.includes('etimedout')) {
      return ErrorType.TIMEOUT;
    }

    if (message.includes('econnrefused') || message.includes('enotfound')) {
      return ErrorType.NETWORK;
    }

    if (status === 429 || message.includes('too many requests')) {
      return ErrorType.RATE_LIMIT;
    }

    if (status === 401 || status === 403) {
      return ErrorType.AUTH;
    }

    if (status === 404) {
      return ErrorType.NOT_FOUND;
    }

    if (status >= 500 && status < 600) {
      return ErrorType.SERVER_ERROR;
    }

    return ErrorType.UNKNOWN;
  }

  getErrorHistory(filter?: {
    type?: ErrorType;
    since?: Date;
    limit?: number;
  }): ErrorReport[] {
    let errors = [...this.errorHistory];

    if (filter?.type) {
      errors = errors.filter(e => e.type === filter.type);
    }

    if (filter?.since) {
      errors = errors.filter(e => new Date(e.timestamp) >= filter.since!);
    }

    // Sort by time descending
    errors = errors.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    if (filter?.limit) {
      errors = errors.slice(0, filter.limit);
    }

    return errors;
  }

  getErrorStats(): {
    total: number;
    byType: Record<string, number>;
    recentErrors: number; // Last hour
  } {
    const now = Date.now();
    const oneHourAgo = now - 3600000;

    const byType: Record<string, number> = {};
    let recentErrors = 0;

    this.errorHistory.forEach(e => {
      byType[e.type] = (byType[e.type] || 0) + 1;

      if (new Date(e.timestamp).getTime() > oneHourAgo) {
        recentErrors++;
      }
    });

    return {
      total: this.errorHistory.length,
      byType,
      recentErrors,
    };
  }

  clearHistory(): void {
    this.errorHistory = [];
    logger.info('Error history cleared');
  }

  // Generate user-friendly error response
  generateErrorResponse(error: any, context?: string): {
    success: false;
    error: {
      type: string;
      message: string;
      suggestions: string[];
      context?: string;
      timestamp: string;
    };
  } {
    const handled = this.handleError(error, context);

    return {
      success: false,
      error: {
        type: handled.type,
        message: handled.userMessage,
        suggestions: handled.suggestions,
        context: handled.context,
        timestamp: new Date().toISOString(),
      },
    };
  }
}

export const errorHandler = new ErrorHandler();

// Convenience function to use in API endpoints
export function handleApiError(error: any, context?: string): {
  success: false;
  error: {
    type: string;
    message: string;
    suggestions: string[];
    context?: string;
    timestamp: string;
  };
} {
  return errorHandler.generateErrorResponse(error, context);
}

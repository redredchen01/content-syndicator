import winston from 'winston';
import path from 'path';
import fs from 'fs';

const logsDir = path.join(process.cwd(), '.data', 'logs');

// Ensure logs directory exists
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const customFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

const dailyRotateFormat = winston.format.combine(
  customFormat,
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
    return `${timestamp} [${level.toUpperCase()}] ${message} ${metaStr}`.trim();
  }),
);

// Transports
const transports: winston.transport[] = [
  // Console transport (development)
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple(),
    ),
  }),

  // Daily file rotation (all logs)
  new winston.transports.File({
    filename: path.join(logsDir, `${new Date().toISOString().split('T')[0]}.log`),
    format: dailyRotateFormat,
    maxsize: 10485760, // 10MB
    maxFiles: 14, // Keep 14 days of logs
  }),

  // Error file (errors only)
  new winston.transports.File({
    filename: path.join(logsDir, 'error.log'),
    level: 'error',
    format: dailyRotateFormat,
    maxsize: 10485760,
    maxFiles: 14,
  }),
];

export const loggerInstance = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: customFormat,
  defaultMeta: { service: 'content-syndicator' },
  transports,
});

// Add console transport in test environment
if (process.env.NODE_ENV === 'test') {
  loggerInstance.clear();
  loggerInstance.add(
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  );
}

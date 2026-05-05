import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
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
  new DailyRotateFile({
    dirname: logsDir,
    filename: 'app-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxDays: '7d',
    format: dailyRotateFormat,
  }),

  // Error file with daily rotation (errors only)
  new DailyRotateFile({
    dirname: logsDir,
    filename: 'error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    level: 'error',
    maxSize: '20m',
    maxDays: '7d',
    format: dailyRotateFormat,
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

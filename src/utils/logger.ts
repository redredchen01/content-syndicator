import { loggerInstance } from './logger-config';
import { getContextId } from './context';

// Structured logging API matching COMMUNICATION_CONTRACTS
export const logger = {
  // Structured methods (new format): logger.info('module.function.event', { field: value })
  info: (message: string, meta?: Record<string, any>) => {
    const contextId = getContextId();
    const fullMeta = { ...meta, ...(contextId && { contextId }) };
    loggerInstance.info(message, fullMeta);
  },

  warn: (message: string, meta?: Record<string, any>) => {
    const contextId = getContextId();
    const fullMeta = { ...meta, ...(contextId && { contextId }) };
    loggerInstance.warn(message, fullMeta);
  },

  error: (message: string, errOrMeta?: any, meta?: Record<string, any>) => {
    const contextId = getContextId();
    let finalMeta: Record<string, any> = { ...(contextId && { contextId }) };

    // Support both old API (error(msg, err)) and new API (error(msg, meta))
    if (errOrMeta) {
      if (errOrMeta instanceof Error) {
        finalMeta.error = {
          message: errOrMeta.message,
          stack: errOrMeta.stack,
        };
      } else if (typeof errOrMeta === 'object') {
        finalMeta = { ...finalMeta, ...errOrMeta };
      }
    }

    if (meta) {
      finalMeta = { ...finalMeta, ...meta };
    }

    loggerInstance.error(message, finalMeta);
  },

  debug: (message: string, meta?: Record<string, any>) => {
    const contextId = getContextId();
    const fullMeta = { ...meta, ...(contextId && { contextId }) };
    loggerInstance.debug(message, fullMeta);
  },

  // Legacy method for backward compatibility
  success: (message: string, meta?: Record<string, any>) => {
    const contextId = getContextId();
    const fullMeta = { ...meta, ...(contextId && { contextId }) };
    loggerInstance.info(`✅ ${message}`, fullMeta);
  },
};

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const randomSleep = (min: number, max: number) => sleep(Math.floor(Math.random() * (max - min + 1) + min));

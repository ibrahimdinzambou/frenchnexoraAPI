/**
 * Structured JSON Logger for Nuvio providers.
 * Supports log levels, context binding, and aggregation-friendly output.
 * Usage:
 *   import { createLogger } from '../utils/logger.js';
 *   const log = createLogger('VoirAnime');
 *   log.info('Stream found', { count: 3, quality: '1080p' });
 *   log.warn('ArmSync failed', { error: e.message });
 *   log.error('Extraction error', { url, status });
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const CURRENT_LOG_LEVEL = 0;

function timestamp() {
    return new Date().toISOString();
}

export function createLogger(module) {
    const log = (level, message, data = {}) => {
        if (LOG_LEVELS[level] < CURRENT_LOG_LEVEL) return;
        const entry = JSON.stringify({
            t: timestamp(),
            l: level,
            m: module,
            msg: message,
            ...(Object.keys(data).length ? { data } : {}),
        });
        if (level === 'error') console.error(entry);
        else if (level === 'warn') console.warn(entry);
        else console.log(entry);
    };

    return {
        debug: (msg, data) => log('debug', msg, data),
        info: (msg, data) => log('info', msg, data),
        warn: (msg, data) => log('warn', msg, data),
        error: (msg, data) => log('error', msg, data),
    };
}

export function withLogContext(log, extra) {
    return {
        debug: (msg, data) => log.debug(msg, { ...extra, ...data }),
        info: (msg, data) => log.info(msg, { ...extra, ...data }),
        warn: (msg, data) => log.warn(msg, { ...extra, ...data }),
        error: (msg, data) => log.error(msg, { ...extra, ...data }),
    };
}

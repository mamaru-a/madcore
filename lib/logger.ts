/**
 * lib/logger.ts — Structured logging with levels
 *
 * Usage:
 *   import { log, setLogLevel } from './lib/logger';
 *   setLogLevel('debug');
 *   log.debug('transport', 'WS frame received', data);
 *   log.info('sdk', 'Registered', email);
 *   log.warn('mime', 'Unknown content-type', ct);
 *   log.error('crypto', 'Decryption failed', err);
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

const LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    none: 4,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel) {
    currentLevel = level;
}

export function getLogLevel(): LogLevel {
    return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
    return LEVELS[level] >= LEVELS[currentLevel];
}

function ts(): string {
    const d = new Date();
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
}

export const log = {
    debug(tag: string, msg: string, ...args: any[]) {
        if (shouldLog('debug')) console.debug(`[${ts()}] 🔍 [${tag}] ${msg}`, ...args);
    },
    info(tag: string, msg: string, ...args: any[]) {
        if (shouldLog('info')) console.log(`[${ts()}] ℹ️  [${tag}] ${msg}`, ...args);
    },
    warn(tag: string, msg: string, ...args: any[]) {
        if (shouldLog('warn')) console.warn(`[${ts()}] ⚠️  [${tag}] ${msg}`, ...args);
    },
    error(tag: string, msg: string, ...args: any[]) {
        if (shouldLog('error')) console.error(`[${ts()}] ❌ [${tag}] ${msg}`, ...args);
    },
};

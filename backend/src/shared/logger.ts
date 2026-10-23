import { config } from './config';

type Level = 'debug' | 'info' | 'warn' | 'error';
type Meta = Record<string, unknown>;

const LEVELS: Record<Level | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// Errors don't survive JSON.stringify, so flatten them
export const errorMeta = (error: unknown): Meta =>
    error instanceof Error
        ? { error: error.message, stack: error.stack }
        : { error: String(error) };

export interface Logger {
    debug(msg: string, meta?: Meta): void;
    info(msg: string, meta?: Meta): void;
    warn(msg: string, meta?: Meta): void;
    error(msg: string, meta?: Meta): void;
    child(bindings: Meta): Logger;
}

export function createLogger(service: string, bindings: Meta = {}): Logger {
    const write = (level: Level, msg: string, meta: Meta = {}) => {
        if (LEVELS[level] < LEVELS[config.logLevel]) return;

        const entry = { time: new Date().toISOString(), level, service, msg, ...bindings, ...meta };
        const line = config.env === 'production'
            ? JSON.stringify(entry)
            : `${entry.time.slice(11, 23)} ${level.toUpperCase().padEnd(5)} [${service}] ${msg}${
                Object.keys({ ...bindings, ...meta }).length ? ' ' + JSON.stringify({ ...bindings, ...meta }) : ''
            }`;

        (level === 'error' || level === 'warn' ? console.error : console.log)(line);
    };

    return {
        debug: (msg, meta) => write('debug', msg, meta),
        info: (msg, meta) => write('info', msg, meta),
        warn: (msg, meta) => write('warn', msg, meta),
        error: (msg, meta) => write('error', msg, meta),
        child: (extra) => createLogger(service, { ...bindings, ...extra }),
    };
}

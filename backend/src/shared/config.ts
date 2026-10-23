import dotenv from 'dotenv';
import path from 'path';

// import this file FIRST in every entry point so .env is loaded before anything reads process.env
dotenv.config();

const num = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return value !== undefined && value !== '' && Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
    env: process.env.NODE_ENV ?? 'development',
    logLevel: (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error' | 'silent',

    ports: {
        api: num(process.env.API_PORT ?? process.env.PORT, 4000),
        workerHealth: num(process.env.WORKER_HEALTH_PORT, 4001),
        schedulerHealth: num(process.env.SCHEDULER_HEALTH_PORT, 4002),
    },

    jobs: {
        maxRetries: num(process.env.JOB_MAX_RETRIES, 2),        // 2 retries = 3 attempts total
        retryDelaySeconds: num(process.env.JOB_RETRY_DELAY_SECONDS, 5),
        expireInSeconds: num(process.env.JOB_EXPIRE_SECONDS, 300),
        // the payload "fail" trick from Phase 4/5 testing. Off in production.
        simulateFailures: (process.env.NODE_ENV ?? 'development') !== 'production',
    },

    rateLimit: {
        windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
        max: num(process.env.RATE_LIMIT_MAX, 100),
    },

    exportDir: process.env.EXPORT_DIR ?? path.resolve(process.cwd(), 'exports'),
    emailFakeDelayMs: num(process.env.EMAIL_FAKE_DELAY_MS, 150),
    shutdownTimeoutMs: num(process.env.SHUTDOWN_TIMEOUT_MS, 20_000),
};

export function assertEnv(names: string[]): void {
    const missing = names.filter((name) => !process.env[name]);
    if (missing.length > 0) {
        throw new Error(`Missing required env vars: ${missing.join(', ')}`);
    }
}

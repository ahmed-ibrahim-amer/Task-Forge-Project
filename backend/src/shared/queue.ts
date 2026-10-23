import './config';
import { PgBoss } from 'pg-boss';
import { config } from './config';
import { createLogger, errorMeta } from './logger';

const log = createLogger('queue');

export const QUEUES = {
    processJob: 'process-job',
    deadLetter: 'process-job-dlq',
    recurring: 'recurring-job',
} as const;

export interface JobMessage {
    jobId: string;
}

// Same options on the queue and on every send: retries with backoff, then straight into the DLQ
export const JOB_OPTIONS = {
    retryLimit: config.jobs.maxRetries,
    retryDelay: config.jobs.retryDelaySeconds,
    retryBackoff: true,
    expireInSeconds: config.jobs.expireInSeconds,
    deadLetter: QUEUES.deadLetter,
};

interface BossOptions {
    supervise: boolean; // maintenance, expiring stuck jobs
    schedule: boolean;  // ticking cron schedules
}

let boss: PgBoss | null = null;

export function getBoss(): PgBoss {
    if (!boss) throw new Error('pg-boss is not started. Call startBoss() first');
    return boss;
}

export async function startBoss(options: BossOptions): Promise<PgBoss> {
    boss = new PgBoss({ connectionString: process.env.DATABASE_URL as string, ...options });
    boss.on('error', (error: Error) => log.error('pg-boss error', errorMeta(error)));

    await boss.start();

    // the DLQ has to exist before the queue that points to it
    await boss.createQueue(QUEUES.deadLetter);
    await boss.createQueue(QUEUES.processJob, JOB_OPTIONS);
    // createQueue does nothing if the queue already exists, so re-apply the options
    // (this is what attaches the DLQ to a queue created back in Phase 4)
    await boss.updateQueue(QUEUES.processJob, JOB_OPTIONS);
    await boss.createQueue(QUEUES.recurring);

    log.info('pg-boss started', options as unknown as Record<string, unknown>);
    return boss;
}

// graceful: waits for jobs that are running right now, then closes the pool
export async function stopBoss(): Promise<void> {
    if (!boss) return;
    await boss.stop({ graceful: true, timeout: config.shutdownTimeoutMs });
    boss = null;
}

export async function enqueueJob(jobId: string): Promise<string | null> {
    const message: JobMessage = { jobId };
    return getBoss().send(QUEUES.processJob, message, JOB_OPTIONS);
}

export async function scheduleRecurringJob(recurringJobId: string, cron: string): Promise<void> {
    await getBoss().schedule(QUEUES.recurring, cron, { recurringJobId }, { key: recurringJobId, tz: 'UTC' });
}

export async function unscheduleRecurringJob(recurringJobId: string): Promise<void> {
    await getBoss().unschedule(QUEUES.recurring, recurringJobId);
}

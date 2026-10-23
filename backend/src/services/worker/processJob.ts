import { config } from '../../shared/config';
import { createLogger, errorMeta } from '../../shared/logger';
import { asObject } from '../../shared/payload';
import { prisma } from '../../shared/prisma';
import type { JobMessage } from '../../shared/queue';
import { handlers } from './handlers';

const log = createLogger('worker');

// the part of the pg-boss job we use (a real JobWithMetadata fits this)
export interface QueueJob {
    id: string;
    data: JobMessage;
    retryCount: number;  // pg-boss: 0 on the first attempt
    retryLimit?: number;
}

// The old "payload contains fail" trick, made explicit.
// A plain string payload with "fail" in it, or { simulateFailure: true }
const shouldSimulateFailure = (payload: unknown): boolean =>
    config.jobs.simulateFailures &&
    ((typeof payload === 'string' && payload.includes('fail')) ||
        asObject(payload).simulateFailure === true);

export async function processJob(queueJob: QueueJob): Promise<void> {
    const { jobId } = queueJob.data;
    const attempt = queueJob.retryCount + 1;
    const maxAttempts = (queueJob.retryLimit ?? config.jobs.maxRetries) + 1;
    const jobLog = log.child({ jobId, attempt });

    const jobData = await prisma.job.findUnique({ where: { id: jobId } });
    if (!jobData) {
        jobLog.warn('job not found in database, skipping');
        return;
    }

    try {
        jobLog.info('processing', { type: jobData.type });

        // Step 1: mark as RUNNING
        await prisma.job.update({
            where: { id: jobId },
            data: { status: 'RUNNING', retryCount: queueJob.retryCount },
        });

        // Step 2: do the work
        if (shouldSimulateFailure(jobData.payload)) {
            throw new Error('Simulated failure for testing');
        }
        const result = await handlers[jobData.type]({
            job: jobData,
            payload: asObject(jobData.payload),
            attempt,
        });

        // Step 3: COMPLETED + result + success log, in one write
        await prisma.job.update({
            where: { id: jobId },
            data: {
                status: 'COMPLETED',
                result,
                logs: { create: { attempt, status: 'SUCCESS' } },
            },
        });
        jobLog.info('completed');
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        const isLastAttempt = attempt >= maxAttempts;
        jobLog.error(isLastAttempt ? 'failed, no retries left' : 'failed, will retry', errorMeta(error));

        // FAILED only when pg-boss has no retries left. Otherwise back to PENDING until the next try
        try {
            await prisma.job.update({
                where: { id: jobId },
                data: {
                    status: isLastAttempt ? 'FAILED' : 'PENDING',
                    retryCount: attempt,
                    logs: { create: { attempt, status: 'FAILED', errorMessage: message } },
                },
            });
        } catch (dbError) {
            jobLog.error('could not record failure', errorMeta(dbError));
        }

        throw error; // pg-boss needs the throw: it schedules the retry, or sends the job to the DLQ
    }
}

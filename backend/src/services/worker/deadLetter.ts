import { createLogger, errorMeta } from '../../shared/logger';
import { prisma } from '../../shared/prisma';
import type { JobMessage } from '../../shared/queue';

const log = createLogger('dlq');

export interface DeadLetterJob {
    id: string;
    data: JobMessage;
}

// Jobs land here when pg-boss gave up: retries used up, OR the worker died / timed out
// before processJob's catch block could run. So don't trust the status written by processJob.
// Make sure the job is FAILED and leave a visible trace in its history.
export async function handleDeadLetter(deadJob: DeadLetterJob): Promise<void> {
    const { jobId } = deadJob.data;

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
        log.warn('dead letter for a job that no longer exists', { jobId });
        return;
    }

    try {
        await prisma.job.update({
            where: { id: jobId },
            data: {
                status: 'FAILED',
                logs: {
                    create: {
                        attempt: job.retryCount + 1,
                        status: 'FAILED',
                        errorMessage: 'Moved to dead-letter queue after exhausting all retries',
                    },
                },
            },
        });
        log.error('job dead-lettered', { jobId, type: job.type, retryCount: job.retryCount });
    } catch (error) {
        log.error('could not record dead letter', { jobId, ...errorMeta(error) });
        throw error; // let pg-boss retry the DLQ job itself
    }
}

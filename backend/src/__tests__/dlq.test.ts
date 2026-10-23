import { handleDeadLetter } from '../services/worker/deadLetter';
import { processJob } from '../services/worker/processJob';
import { handlers } from '../services/worker/handlers';
import { prisma as workerPrisma } from '../shared/prisma';
import { createJobStore, makeJob } from './helpers';

jest.mock('../shared/prisma', () => ({
    prisma: { job: { findUnique: jest.fn(), update: jest.fn() } },
}));
jest.mock('../services/worker/handlers', () => ({
    handlers: { REPORT: jest.fn(), EMAIL_BATCH: jest.fn(), DATA_EXPORT: jest.fn() },
}));

const dbJob = workerPrisma.job as unknown as { findUnique: jest.Mock; update: jest.Mock };
const reportHandler = handlers.REPORT as unknown as jest.Mock;

describe('dead-letter queue', () => {
    const deadJob = { id: 'dlq-1', data: { jobId: 'job-1' } };

    it('marks the job FAILED and leaves a DLQ entry in its history', async () => {
        dbJob.findUnique.mockResolvedValue(makeJob({ status: 'RUNNING', retryCount: 3 }));
        dbJob.update.mockResolvedValue(makeJob());

        await handleDeadLetter(deadJob);

        expect(dbJob.update).toHaveBeenCalledWith({
            where: { id: 'job-1' },
            data: {
                status: 'FAILED',
                logs: {
                    create: {
                        attempt: 4,
                        status: 'FAILED',
                        errorMessage: expect.stringContaining('dead-letter queue'),
                    },
                },
            },
        });
    });

    it('catches a job whose worker died: it was stuck RUNNING, now it is FAILED', async () => {
        dbJob.findUnique.mockResolvedValue(makeJob({ status: 'RUNNING', retryCount: 0 }));
        dbJob.update.mockResolvedValue(makeJob());

        await handleDeadLetter(deadJob);

        expect(dbJob.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) })
        );
    });

    it('ignores a dead letter for a job that was deleted', async () => {
        dbJob.findUnique.mockResolvedValue(null);

        await expect(handleDeadLetter(deadJob)).resolves.toBeUndefined();
        expect(dbJob.update).not.toHaveBeenCalled();
    });

    it('throws when it cannot record the failure, so pg-boss retries the DLQ job', async () => {
        dbJob.findUnique.mockResolvedValue(makeJob());
        dbJob.update.mockRejectedValue(new Error('db down'));

        await expect(handleDeadLetter(deadJob)).rejects.toThrow('db down');
    });

    it('full lifecycle: 3 failed attempts, then the DLQ. Status and history end up consistent', async () => {
        const store = createJobStore(makeJob({ payload: 'fail please' }));
        dbJob.findUnique.mockImplementation(store.prisma.job.findUnique);
        dbJob.update.mockImplementation(store.prisma.job.update);
        reportHandler.mockResolvedValue({});

        const attempt = (retryCount: number) =>
            processJob({ id: 'q1', data: { jobId: 'job-1' }, retryCount, retryLimit: 2 });

        await expect(attempt(0)).rejects.toThrow();
        expect(store.job.status).toBe('PENDING');
        await expect(attempt(1)).rejects.toThrow();
        expect(store.job.status).toBe('PENDING');
        await expect(attempt(2)).rejects.toThrow();
        expect(store.job.status).toBe('FAILED');
        expect(store.job.retryCount).toBe(3);

        // pg-boss now moves the job to the DLQ and our DLQ worker picks it up
        await handleDeadLetter(deadJob);

        expect(store.job.status).toBe('FAILED');
        expect(store.logs.map((l) => l.attempt)).toEqual([1, 2, 3, 4]);
        expect(store.logs.every((l) => l.status === 'FAILED')).toBe(true);
        expect(store.logs[3].errorMessage).toContain('dead-letter queue');
    });
});

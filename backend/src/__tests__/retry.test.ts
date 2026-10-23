import { resolvers } from '../services/api/resolvers';
import { processJob } from '../services/worker/processJob';
import { enqueueJob } from '../shared/queue';
import { prisma as workerPrisma } from '../shared/prisma';
import { handlers } from '../services/worker/handlers';
import { ADMIN, createFakePrisma, FakePrisma, makeContext, makeJob, OTHER_USER, USER } from './helpers';

jest.mock('bcrypt', () => ({ hash: jest.fn(), compare: jest.fn() }));
jest.mock('../shared/queue', () => ({ enqueueJob: jest.fn(), scheduleRecurringJob: jest.fn() }));
jest.mock('../shared/prisma', () => ({
    prisma: { job: { findUnique: jest.fn(), update: jest.fn() } },
}));
jest.mock('../services/worker/handlers', () => ({
    handlers: { REPORT: jest.fn(), EMAIL_BATCH: jest.fn(), DATA_EXPORT: jest.fn() },
}));

const enqueue = enqueueJob as unknown as jest.Mock;
const dbJob = workerPrisma.job as unknown as { findUnique: jest.Mock; update: jest.Mock };
const reportHandler = handlers.REPORT as unknown as jest.Mock;

describe('retryJob (API)', () => {
    let prisma: FakePrisma;

    beforeEach(() => {
        prisma = createFakePrisma();
    });

    const retry = (user: { id: string; role: string } | null) =>
        resolvers.Mutation.retryJob(null, { id: 'job-1' }, makeContext(prisma, user));

    it('needs a login', async () => {
        await expect(retry(null)).rejects.toThrow('You must be logged in');
    });

    it('404s on an unknown job', async () => {
        prisma.job.findUnique.mockResolvedValue(null);
        await expect(retry(USER)).rejects.toThrow('Job not found');
    });

    it('does not let another user retry your job', async () => {
        prisma.job.findUnique.mockResolvedValue(makeJob({ status: 'FAILED' }));
        await expect(retry(OTHER_USER)).rejects.toThrow('permission');
        expect(enqueue).not.toHaveBeenCalled();
    });

    it('only retries FAILED jobs', async () => {
        for (const status of ['PENDING', 'RUNNING', 'COMPLETED']) {
            prisma.job.findUnique.mockResolvedValue(makeJob({ status }));
            await expect(retry(USER)).rejects.toThrow('Only failed jobs can be retried');
        }
        expect(prisma.job.update).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
    });

    it.each([
        ['the owner', USER],
        ['an ADMIN', ADMIN],
    ])('%s can retry: resets to PENDING / retryCount 0 and queues again', async (_who, user) => {
        prisma.job.findUnique.mockResolvedValue(makeJob({ status: 'FAILED', retryCount: 3 }));
        prisma.job.update.mockResolvedValue(makeJob({ status: 'PENDING', retryCount: 0 }));

        const result = await retry(user);

        expect(prisma.job.update).toHaveBeenCalledWith({
            where: { id: 'job-1' },
            data: { status: 'PENDING', retryCount: 0 },
        });
        expect(enqueue).toHaveBeenCalledWith('job-1');
        expect(result.status).toBe('PENDING');
    });
});

describe('retries (worker)', () => {
    // pg-boss retryLimit 2 = 3 attempts. retryCount is 0 on the first one
    const queueJob = (retryCount: number, retryLimit = 2) => ({
        id: 'q1',
        data: { jobId: 'job-1' },
        retryCount,
        retryLimit,
    });

    beforeEach(() => {
        dbJob.findUnique.mockResolvedValue(makeJob());
        dbJob.update.mockResolvedValue(makeJob());
        reportHandler.mockResolvedValue({ ok: true });
    });

    it('success: RUNNING, then COMPLETED with the handler result and a SUCCESS log', async () => {
        await processJob(queueJob(0));

        expect(dbJob.update).toHaveBeenNthCalledWith(1, {
            where: { id: 'job-1' },
            data: { status: 'RUNNING', retryCount: 0 },
        });
        expect(dbJob.update).toHaveBeenNthCalledWith(2, {
            where: { id: 'job-1' },
            data: {
                status: 'COMPLETED',
                result: { ok: true },
                logs: { create: { attempt: 1, status: 'SUCCESS' } },
            },
        });
    });

    it('failure with retries left: back to PENDING, retryCount up, error rethrown for pg-boss', async () => {
        reportHandler.mockRejectedValue(new Error('db timeout'));

        await expect(processJob(queueJob(0))).rejects.toThrow('db timeout');

        expect(dbJob.update).toHaveBeenLastCalledWith({
            where: { id: 'job-1' },
            data: {
                status: 'PENDING',
                retryCount: 1,
                logs: { create: { attempt: 1, status: 'FAILED', errorMessage: 'db timeout' } },
            },
        });
    });

    it('failure on the last attempt: FAILED for good', async () => {
        reportHandler.mockRejectedValue(new Error('still broken'));

        await expect(processJob(queueJob(2))).rejects.toThrow('still broken');

        expect(dbJob.update).toHaveBeenLastCalledWith({
            where: { id: 'job-1' },
            data: {
                status: 'FAILED',
                retryCount: 3,
                logs: { create: { attempt: 3, status: 'FAILED', errorMessage: 'still broken' } },
            },
        });
    });

    it('payload "fail" triggers the simulated failure without calling the handler', async () => {
        dbJob.findUnique.mockResolvedValue(makeJob({ payload: 'please fail' }));

        await expect(processJob(queueJob(0))).rejects.toThrow('Simulated failure for testing');
        expect(reportHandler).not.toHaveBeenCalled();
    });

    it('skips (no error, no writes) when the job row is gone', async () => {
        dbJob.findUnique.mockResolvedValue(null);

        await expect(processJob(queueJob(0))).resolves.toBeUndefined();
        expect(dbJob.update).not.toHaveBeenCalled();
    });

    it('still rethrows the real error if saving the failure also fails', async () => {
        reportHandler.mockRejectedValue(new Error('original'));
        dbJob.update
            .mockResolvedValueOnce(makeJob()) // RUNNING
            .mockRejectedValueOnce(new Error('db down')); // failure write

        await expect(processJob(queueJob(0))).rejects.toThrow('original');
    });
});

import { resolvers } from '../services/api/resolvers';
import { enqueueJob } from '../shared/queue';
import { createFakePrisma, FakePrisma, makeContext, makeJob, USER } from './helpers';

jest.mock('bcrypt', () => ({ hash: jest.fn(), compare: jest.fn() }));
jest.mock('../shared/queue', () => ({ enqueueJob: jest.fn(), scheduleRecurringJob: jest.fn() }));

const enqueue = enqueueJob as unknown as jest.Mock;

describe('createJob', () => {
    let prisma: FakePrisma;

    beforeEach(() => {
        prisma = createFakePrisma();
        prisma.job.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
            makeJob({ ...data })
        );
    });

    it('needs a login: nothing saved, nothing queued', async () => {
        await expect(
            resolvers.Mutation.createJob(null, { type: 'REPORT' }, makeContext(prisma))
        ).rejects.toThrow('You must be logged in');

        expect(prisma.job.create).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
    });

    it('saves the job for the caller and queues it by id', async () => {
        const job = await resolvers.Mutation.createJob(
            null,
            { type: 'DATA_EXPORT', payload: '{"format":"json"}' },
            makeContext(prisma, USER)
        );

        expect(prisma.job.create).toHaveBeenCalledWith({
            data: { type: 'DATA_EXPORT', payload: { format: 'json' }, userId: USER.id },
        });
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue).toHaveBeenCalledWith(job.id);
    });

    it('stores payload that is not JSON as the raw string', async () => {
        await resolvers.Mutation.createJob(null, { type: 'REPORT', payload: 'fail' }, makeContext(prisma, USER));
        expect(prisma.job.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ payload: 'fail' }),
        });
    });

    it('defaults a missing payload to {}', async () => {
        await resolvers.Mutation.createJob(null, { type: 'REPORT' }, makeContext(prisma, USER));
        expect(prisma.job.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ payload: {} }),
        });
    });

    it('marks the job FAILED (not stuck PENDING) when the queue is down', async () => {
        enqueue.mockRejectedValueOnce(new Error('connection refused'));

        await expect(
            resolvers.Mutation.createJob(null, { type: 'REPORT' }, makeContext(prisma, USER))
        ).rejects.toThrow('Could not queue the job');

        expect(prisma.job.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) })
        );
    });
});

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createToken, getUserFromAuthHeader } from '../services/api/context';
import { resolvers } from '../services/api/resolvers';
import { ADMIN, createFakePrisma, FakePrisma, makeContext, makeJob, OTHER_USER, USER } from './helpers';

jest.mock('bcrypt', () => ({ hash: jest.fn(), compare: jest.fn() }));
jest.mock('../shared/queue', () => ({ enqueueJob: jest.fn(), scheduleRecurringJob: jest.fn() }));

const hash = bcrypt.hash as unknown as jest.Mock;
const compare = bcrypt.compare as unknown as jest.Mock;
const SECRET = 'test-secret';

describe('auth', () => {
    let prisma: FakePrisma;

    beforeEach(() => {
        prisma = createFakePrisma();
    });

    describe('register', () => {
        const args = { email: 'new@taskforge.dev', password: 'supersecret' };

        it('creates the user with a hashed password and returns a valid token', async () => {
            hash.mockResolvedValue('hashed-pw');
            prisma.user.findUnique.mockResolvedValue(null);
            prisma.user.create.mockResolvedValue({ id: 'u1', email: args.email, role: 'USER' });

            const result = await resolvers.Mutation.register(null, args, makeContext(prisma));

            expect(hash).toHaveBeenCalledWith('supersecret', 12);
            expect(prisma.user.create).toHaveBeenCalledWith({
                data: { email: args.email, password: 'hashed-pw' },
            });
            const decoded = jwt.verify(result.token, SECRET) as { id: string; role: string };
            expect(decoded).toMatchObject({ id: 'u1', role: 'USER' });
        });

        it('rejects an email that is already in use', async () => {
            prisma.user.findUnique.mockResolvedValue({ id: 'u1' });

            await expect(resolvers.Mutation.register(null, args, makeContext(prisma))).rejects.toThrow(
                'Email already in use'
            );
            expect(prisma.user.create).not.toHaveBeenCalled();
        });

        it('rejects an invalid email', async () => {
            await expect(
                resolvers.Mutation.register(null, { ...args, email: 'not-an-email' }, makeContext(prisma))
            ).rejects.toThrow('Invalid email');
            expect(prisma.user.create).not.toHaveBeenCalled();
        });

        it('rejects a short password', async () => {
            await expect(
                resolvers.Mutation.register(null, { ...args, password: '123' }, makeContext(prisma))
            ).rejects.toThrow('at least 8 characters');
            expect(prisma.user.create).not.toHaveBeenCalled();
        });
    });

    describe('login', () => {
        const args = { email: 'a@taskforge.dev', password: 'supersecret' };
        const dbUser = { id: 'u1', email: args.email, password: 'hashed-pw', role: 'ADMIN' };

        it('returns a token carrying id and role when the password matches', async () => {
            prisma.user.findUnique.mockResolvedValue(dbUser);
            compare.mockResolvedValue(true);

            const result = await resolvers.Mutation.login(null, args, makeContext(prisma));

            expect(compare).toHaveBeenCalledWith('supersecret', 'hashed-pw');
            expect(jwt.verify(result.token, SECRET)).toMatchObject({ id: 'u1', role: 'ADMIN' });
        });

        it('gives the same error for a wrong password and an unknown email', async () => {
            compare.mockResolvedValue(false);
            prisma.user.findUnique.mockResolvedValueOnce(dbUser);
            await expect(resolvers.Mutation.login(null, args, makeContext(prisma))).rejects.toThrow(
                'Invalid email or password'
            );

            prisma.user.findUnique.mockResolvedValueOnce(null);
            await expect(resolvers.Mutation.login(null, args, makeContext(prisma))).rejects.toThrow(
                'Invalid email or password'
            );
        });
    });

    describe('token -> context user', () => {
        it('reads the user from a valid Bearer token', () => {
            const token = createToken('u1', 'USER');
            expect(getUserFromAuthHeader(`Bearer ${token}`)).toEqual({ id: 'u1', role: 'USER' });
        });

        it('returns null for missing, garbage, wrong-secret and expired tokens', () => {
            expect(getUserFromAuthHeader(undefined)).toBeNull();
            expect(getUserFromAuthHeader('Bearer garbage')).toBeNull();

            const forged = jwt.sign({ id: 'u1', role: 'ADMIN' }, 'other-secret');
            expect(getUserFromAuthHeader(`Bearer ${forged}`)).toBeNull();

            const expired = jwt.sign({ id: 'u1', role: 'USER' }, SECRET, { expiresIn: -10 });
            expect(getUserFromAuthHeader(`Bearer ${expired}`)).toBeNull();
        });
    });

    describe('authorization', () => {
        it('myJobs needs a login', async () => {
            await expect(resolvers.Query.myJobs(null, null, makeContext(prisma))).rejects.toThrow(
                'You must be logged in'
            );
        });

        it('myJobs only asks for the caller\'s own jobs', async () => {
            prisma.job.findMany.mockResolvedValue([]);
            await resolvers.Query.myJobs(null, null, makeContext(prisma, USER));
            expect(prisma.job.findMany).toHaveBeenCalledWith(
                expect.objectContaining({ where: { userId: USER.id } })
            );
        });

        it('job(): owner and ADMIN can read it, another user cannot', async () => {
            prisma.job.findUnique.mockResolvedValue(makeJob({ userId: USER.id }));

            await expect(resolvers.Query.job(null, { id: 'job-1' }, makeContext(prisma, USER))).resolves.toBeTruthy();
            await expect(resolvers.Query.job(null, { id: 'job-1' }, makeContext(prisma, ADMIN))).resolves.toBeTruthy();
            await expect(resolvers.Query.job(null, { id: 'job-1' }, makeContext(prisma, OTHER_USER))).rejects.toThrow(
                'Authorization'
            );
        });

        it('allJobs is ADMIN only', async () => {
            prisma.job.findMany.mockResolvedValue([]);

            await expect(resolvers.Query.allJobs(null, {}, makeContext(prisma, USER))).rejects.toThrow('permission');
            await expect(resolvers.Query.allJobs(null, {}, makeContext(prisma))).rejects.toThrow('logged in');
            await expect(resolvers.Query.allJobs(null, {}, makeContext(prisma, ADMIN))).resolves.toEqual([]);
        });

        it('createRecurringJob is ADMIN only', async () => {
            const args = { cron: '* * * * *', type: 'REPORT' as const };
            await expect(
                resolvers.Mutation.createRecurringJob(null, args, makeContext(prisma, USER))
            ).rejects.toThrow('permission');
            expect(prisma.recurringJob.create).not.toHaveBeenCalled();
        });
    });
});

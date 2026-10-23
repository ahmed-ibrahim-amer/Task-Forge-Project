import { PrismaClient } from '@prisma/client';
import { MyContext } from '../services/api/context';

export const createFakePrisma = () => ({
    user: { findUnique: jest.fn(), create: jest.fn() },
    job: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    jobLog: { findMany: jest.fn() },
    recurringJob: { create: jest.fn(), delete: jest.fn() },
});

export type FakePrisma = ReturnType<typeof createFakePrisma>;

export const makeContext = (
    prisma: FakePrisma,
    user: { id: string; role: string } | null = null
): MyContext => ({ prisma: prisma as unknown as PrismaClient, user });

export const USER = { id: 'user-1', role: 'USER' };
export const OTHER_USER = { id: 'user-2', role: 'USER' };
export const ADMIN = { id: 'admin-1', role: 'ADMIN' };

export const makeJob = (overrides: Record<string, unknown> = {}) => ({
    id: 'job-1',
    type: 'REPORT',
    status: 'PENDING',
    payload: {},
    retryCount: 0,
    userId: USER.id,
    result: null,
    createdAt: new Date('2026-10-01T10:00:00Z'),
    updatedAt: new Date('2026-10-01T10:00:00Z'),
    ...overrides,
});

// Tiny in-memory stand-in for prisma.job, enough to run a job through its whole life.
// It understands the nested `logs: { create }` writes the worker uses.
export const createJobStore = (initial: Record<string, unknown>) => {
    const job: Record<string, unknown> = { ...initial };
    const logs: Array<Record<string, unknown>> = [];

    const prisma = {
        job: {
            findUnique: jest.fn(async () => ({ ...job })),
            update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
                const { logs: nested, ...fields } = data as { logs?: { create: Record<string, unknown> } };
                Object.assign(job, fields);
                if (nested?.create) logs.push({ jobId: job.id, ...nested.create });
                return { ...job };
            }),
        },
    };

    return { prisma, job, logs };
};

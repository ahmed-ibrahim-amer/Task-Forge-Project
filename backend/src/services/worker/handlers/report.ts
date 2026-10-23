import { Prisma } from '@prisma/client';
import { prisma } from '../../../shared/prisma';
import { JobHandler } from './types';

const DEFAULT_DAYS = 30;

// payload (all optional): { days: 30, scope: "user" | "all" }  ("all" only works for ADMIN)
export const runReport: JobHandler = async ({ job, payload }) => {
    const days = Number(payload.days) > 0 ? Math.min(Number(payload.days), 365) : DEFAULT_DAYS;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const owner = await prisma.user.findUnique({ where: { id: job.userId }, select: { role: true } });
    const allUsers = payload.scope === 'all' && owner?.role === 'ADMIN';

    // don't count the report job itself
    const where: Prisma.JobWhereInput = {
        ...(allUsers ? {} : { userId: job.userId }),
        createdAt: { gte: since },
        id: { not: job.id },
    };

    const [byStatus, byType, retried, failures] = await Promise.all([
        prisma.job.groupBy({ by: ['status'], where, _count: { _all: true } }),
        prisma.job.groupBy({ by: ['type'], where, _count: { _all: true } }),
        prisma.job.count({ where: { ...where, retryCount: { gt: 0 } } }),
        prisma.jobLog.findMany({
            where: { status: 'FAILED', job: where },
            orderBy: { createdAt: 'desc' },
            take: 5,
            select: { jobId: true, attempt: true, errorMessage: true, createdAt: true },
        }),
    ]);

    const status: Record<string, number> = { PENDING: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0 };
    for (const row of byStatus) status[row.status] = row._count._all;

    const type: Record<string, number> = {};
    for (const row of byType) type[row.type] = row._count._all;

    const finished = status.COMPLETED + status.FAILED;

    return {
        generatedAt: new Date().toISOString(),
        periodDays: days,
        scope: allUsers ? 'all' : 'user',
        totalJobs: Object.values(status).reduce((a, b) => a + b, 0),
        byStatus: status,
        byType: type,
        successRate: finished === 0 ? null : Number((status.COMPLETED / finished).toFixed(3)),
        jobsThatNeededRetry: retried,
        recentFailures: failures.map((f) => ({
            jobId: f.jobId,
            attempt: f.attempt,
            error: f.errorMessage,
            at: f.createdAt.toISOString(),
        })),
    };
};

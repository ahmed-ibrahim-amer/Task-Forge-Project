import { createLogger } from '../../shared/logger';
import { prisma } from '../../shared/prisma';
import { enqueueJob, unscheduleRecurringJob } from '../../shared/queue';
import { Prisma } from '@prisma/client';

const log = createLogger('scheduler');

export interface RecurringMessage {
    recurringJobId: string;
}

// pg-boss fires this on every cron tick. We turn it into a normal Job row + queue message
export async function handleRecurringTick(tick: { data: RecurringMessage }): Promise<void> {
    const { recurringJobId } = tick.data;

    const recurringJob = await prisma.recurringJob.findUnique({ where: { id: recurringJobId } });
    if (!recurringJob) {
        // definition was deleted, stop ticking for it
        log.warn('recurring job no longer exists, unscheduling', { recurringJobId });
        await unscheduleRecurringJob(recurringJobId);
        return;
    }

    const newJob = await prisma.job.create({
        data: {
            type: recurringJob.type,
            payload: recurringJob.payload as Prisma.InputJsonValue,
            userId: recurringJob.createdById,
        },
    });

    await enqueueJob(newJob.id);
    log.info('recurring job created a new job', { recurringJobId, jobId: newJob.id });
}

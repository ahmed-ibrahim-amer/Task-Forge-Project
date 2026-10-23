import { Job, Prisma } from '@prisma/client';

export interface HandlerContext {
    job: Job;
    payload: Record<string, unknown>;
    attempt: number;
}

// whatever a handler returns is saved in Job.result
export type JobHandler = (ctx: HandlerContext) => Promise<Prisma.InputJsonObject>;

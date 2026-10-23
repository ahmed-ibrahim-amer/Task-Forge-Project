import { JobType } from '@prisma/client';
import { runDataExport } from './export';
import { runEmailBatch } from './emailBatch';
import { runReport } from './report';
import { JobHandler } from './types';

// Record<JobType, ...> makes TypeScript fail the build if a new JobType has no handler
export const handlers: Record<JobType, JobHandler> = {
    REPORT: runReport,
    EMAIL_BATCH: runEmailBatch,
    DATA_EXPORT: runDataExport,
};

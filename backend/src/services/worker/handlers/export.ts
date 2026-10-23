import fs from 'fs/promises';
import path from 'path';
import { Prisma } from '@prisma/client';
import { config } from '../../../shared/config';
import { prisma } from '../../../shared/prisma';
import { JobHandler } from './types';

const MAX_ROWS = 10_000;
const JOB_STATUSES = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'];
const JOB_TYPES = ['REPORT', 'EMAIL_BATCH', 'DATA_EXPORT'];
const COLUMNS = ['id', 'type', 'status', 'retryCount', 'payload', 'createdAt', 'updatedAt'] as const;

// quotes the cell, and defuses =,+,-,@ so Excel doesn't run it as a formula
export const csvCell = (value: unknown): string => {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const toCsv = (rows: Array<Record<string, unknown>>): string =>
    [COLUMNS.join(','), ...rows.map((row) => COLUMNS.map((col) => csvCell(row[col])).join(','))].join('\n') + '\n';

// payload (all optional): { format: "csv" | "json", status: "FAILED", type: "REPORT" }
export const runDataExport: JobHandler = async ({ job, payload }) => {
    const format = payload.format === 'json' ? 'json' : 'csv';

    const where: Prisma.JobWhereInput = { userId: job.userId, id: { not: job.id } };
    if (typeof payload.status === 'string' && JOB_STATUSES.includes(payload.status)) {
        where.status = payload.status as Prisma.JobWhereInput['status'];
    }
    if (typeof payload.type === 'string' && JOB_TYPES.includes(payload.type)) {
        where.type = payload.type as Prisma.JobWhereInput['type'];
    }

    const jobs = await prisma.job.findMany({ where, orderBy: { createdAt: 'desc' }, take: MAX_ROWS });

    const rows = jobs.map((j) => ({
        id: j.id,
        type: j.type,
        status: j.status,
        retryCount: j.retryCount,
        payload: JSON.stringify(j.payload),
        createdAt: j.createdAt.toISOString(),
        updatedAt: j.updatedAt.toISOString(),
    }));

    const content = format === 'json' ? JSON.stringify(rows, null, 2) : toCsv(rows);

    await fs.mkdir(config.exportDir, { recursive: true });
    const file = path.join(config.exportDir, `${job.id}.${format}`);
    await fs.writeFile(file, content, 'utf8');

    return { file, format, rows: rows.length, bytes: Buffer.byteLength(content), truncated: jobs.length === MAX_ROWS };
};

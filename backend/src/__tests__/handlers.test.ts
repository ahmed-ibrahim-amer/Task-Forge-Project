import fs from 'fs';
import path from 'path';
import { runDataExport, csvCell, toCsv } from '../services/worker/handlers/export';
import { runEmailBatch } from '../services/worker/handlers/emailBatch';
import { runReport } from '../services/worker/handlers/report';
import { prisma } from '../shared/prisma';
import { makeJob } from './helpers';

jest.mock('../shared/prisma', () => ({
    prisma: {
        user: { findUnique: jest.fn() },
        job: { groupBy: jest.fn(), count: jest.fn(), findMany: jest.fn() },
        jobLog: { findMany: jest.fn() },
    },
}));

const db = prisma as unknown as {
    user: { findUnique: jest.Mock };
    job: { groupBy: jest.Mock; count: jest.Mock; findMany: jest.Mock };
    jobLog: { findMany: jest.Mock };
};

const ctx = (payload: Record<string, unknown> = {}, jobOverrides = {}) => ({
    job: makeJob(jobOverrides) as any,
    payload,
    attempt: 1,
});

describe('EMAIL_BATCH (fake sender)', () => {
    it('sends to every recipient', async () => {
        const result = await runEmailBatch(ctx({ recipients: ['a@x.com', 'b@x.com', 'c@x.com'], subject: 'Hi' }));
        expect(result).toMatchObject({ provider: 'fake-smtp', total: 3, sent: 3, failed: 0 });
    });

    it('completes with a partial result when only some bounce', async () => {
        const result = await runEmailBatch(ctx({ recipients: ['ok@x.com', 'bounce@x.com', 'not-an-email'] }));
        expect(result).toMatchObject({ total: 3, sent: 1, failed: 2 });
        expect((result.failures as any[]).map((f) => f.to)).toEqual(['bounce@x.com', 'not-an-email']);
    });

    it('throws when nothing could be sent, so retry/DLQ kicks in', async () => {
        await expect(runEmailBatch(ctx({ recipients: ['bounce1@x.com', 'bounce2@x.com'] }))).rejects.toThrow(
            'All 2 emails failed'
        );
    });

    it('validates recipients', async () => {
        await expect(runEmailBatch(ctx({}))).rejects.toThrow('recipients');
        await expect(runEmailBatch(ctx({ recipients: [] }))).rejects.toThrow('recipients');
        const tooMany = Array.from({ length: 1001 }, (_, i) => `u${i}@x.com`);
        await expect(runEmailBatch(ctx({ recipients: tooMany }))).rejects.toThrow('at most 1000');
    });
});

describe('DATA_EXPORT', () => {
    const rows = [
        {
            id: 'j1', type: 'REPORT', status: 'COMPLETED', retryCount: 0, payload: { note: 'a, "quoted" value' },
            createdAt: new Date('2026-10-01T10:00:00Z'), updatedAt: new Date('2026-10-01T10:01:00Z'),
        },
        {
            id: 'j2', type: 'EMAIL_BATCH', status: 'FAILED', retryCount: 3, payload: '=HYPERLINK("http://evil")',
            createdAt: new Date('2026-10-02T10:00:00Z'), updatedAt: new Date('2026-10-02T10:01:00Z'),
        },
    ];

    it('csvCell quotes special characters and defuses spreadsheet formulas', () => {
        expect(csvCell('plain')).toBe('plain');
        expect(csvCell('a,b')).toBe('"a,b"');
        expect(csvCell('say "hi"')).toBe('"say ""hi"""');
        expect(csvCell('=1+1')).toBe("'=1+1");
        expect(csvCell(null)).toBe('');
    });

    it('writes a real CSV file and returns where it is', async () => {
        db.job.findMany.mockResolvedValue(rows);

        const result = await runDataExport(ctx({}, { id: 'export-csv' }));

        expect(result).toMatchObject({ format: 'csv', rows: 2, truncated: false });
        const file = result.file as string;
        expect(path.basename(file)).toBe('export-csv.csv');
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
        expect(lines[0]).toBe('id,type,status,retryCount,payload,createdAt,updatedAt');
        expect(lines.length).toBe(3);
        // payload is JSON-encoded, so a payload like =HYPERLINK(...) is written as "=HYPERLINK(...)" (cannot start a formula)
        expect(lines[2].split(',')[4].startsWith('"')).toBe(true);
    });

    it('toCsv defuses a cell that would start with a formula character', () => {
        const csv = toCsv([{ id: '=cmd|calc', type: 'REPORT', status: 'COMPLETED', retryCount: 0, payload: '{}', createdAt: 'x', updatedAt: 'y' }]);
        expect(csv).toContain("'=cmd|calc");
    });

    it('writes JSON when asked', async () => {
        db.job.findMany.mockResolvedValue(rows);

        const result = await runDataExport(ctx({ format: 'json' }, { id: 'export-json' }));

        const parsed = JSON.parse(fs.readFileSync(result.file as string, 'utf8'));
        expect(parsed.length).toBe(2);
        expect(parsed[0]).toMatchObject({ id: 'j1', type: 'REPORT' });
    });

    it('only exports the owner\'s jobs, applies valid filters and ignores bogus ones', async () => {
        db.job.findMany.mockResolvedValue([]);

        await runDataExport(ctx({ status: 'FAILED', type: 'nonsense' }, { id: 'export-filter', userId: 'user-1' }));

        expect(db.job.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'user-1', id: { not: 'export-filter' }, status: 'FAILED' } })
        );
    });
});

describe('REPORT', () => {
    const setupDb = (role: string) => {
        db.user.findUnique.mockResolvedValue({ role });
        db.job.groupBy
            .mockResolvedValueOnce([
                { status: 'COMPLETED', _count: { _all: 6 } },
                { status: 'FAILED', _count: { _all: 2 } },
                { status: 'PENDING', _count: { _all: 1 } },
            ])
            .mockResolvedValueOnce([
                { type: 'REPORT', _count: { _all: 5 } },
                { type: 'EMAIL_BATCH', _count: { _all: 4 } },
            ]);
        db.job.count.mockResolvedValue(3);
        db.jobLog.findMany.mockResolvedValue([
            { jobId: 'j9', attempt: 3, errorMessage: 'boom', createdAt: new Date('2026-10-20T08:00:00Z') },
        ]);
    };

    it('aggregates the user\'s jobs into a real report', async () => {
        setupDb('USER');

        const result = await runReport(ctx({ days: 7 }, { userId: 'user-1' }));

        expect(result).toMatchObject({
            periodDays: 7,
            scope: 'user',
            totalJobs: 9,
            byStatus: { COMPLETED: 6, FAILED: 2, PENDING: 1, RUNNING: 0 },
            byType: { REPORT: 5, EMAIL_BATCH: 4 },
            successRate: 0.75,
            jobsThatNeededRetry: 3,
        });
        expect(result.recentFailures).toEqual([
            { jobId: 'j9', attempt: 3, error: 'boom', at: '2026-10-20T08:00:00.000Z' },
        ]);
    });

    it('scope "all" only works for ADMIN', async () => {
        setupDb('USER');
        const asUser = await runReport(ctx({ scope: 'all' }, { userId: 'user-1' }));
        expect(asUser.scope).toBe('user');
        expect(db.job.groupBy.mock.calls[0][0].where.userId).toBe('user-1');

        db.job.groupBy.mockClear();
        setupDb('ADMIN');
        const asAdmin = await runReport(ctx({ scope: 'all' }, { userId: 'admin-1' }));
        expect(asAdmin.scope).toBe('all');
        expect(db.job.groupBy.mock.calls[0][0].where.userId).toBeUndefined();
    });

    it('successRate is null when nothing has finished yet', async () => {
        db.user.findUnique.mockResolvedValue({ role: 'USER' });
        db.job.groupBy.mockResolvedValue([]);
        db.job.count.mockResolvedValue(0);
        db.jobLog.findMany.mockResolvedValue([]);

        const result = await runReport(ctx());
        expect(result).toMatchObject({ totalJobs: 0, successRate: null });
    });
});

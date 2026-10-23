import bcrypt from 'bcrypt';
import { JobType, JobStatus, PrismaClient } from '@prisma/client';
import { parsePayload } from '../../shared/payload';
import { enqueueJob, scheduleRecurringJob } from '../../shared/queue';
import { createToken, MyContext } from './context';

interface RegisterArgs {
    email: string;
    password: string;
}
interface LoginArgs {
    email: string;
    password: string;
}
interface CreateJobArgs {
    type: JobType;
    payload?: string;
}
interface JobIdArgs {
    id: string;
}
interface AllJobsArgs {
    status?: JobStatus;
}
interface CreateRecurringJobArgs {
    cron: string;
    type: JobType;
    payload?: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

// If the queue is down, don't leave a job sitting in PENDING forever. Fail it visibly
const enqueueOrFail = async (prisma: PrismaClient, jobId: string): Promise<void> => {
    try {
        await enqueueJob(jobId);
    } catch (error) {
        await prisma.job.update({
            where: { id: jobId },
            data: {
                status: 'FAILED',
                logs: { create: { attempt: 1, status: 'FAILED', errorMessage: 'Could not enqueue job' } },
            },
        });
        throw new Error('Could not queue the job, please retry');
    }
};

const toISO = (parent: { createdAt?: Date | null; updatedAt?: Date | null }, key: 'createdAt' | 'updatedAt') =>
    parent[key] ? (parent[key] as Date).toISOString() : null;

export const resolvers = {
    Query: {
        hello: () => "hello string",
        myJobs: async (parent: unknown, args: unknown, context: MyContext) => {
            if (!context.user) {
                throw new Error('You must be logged in');
            }
            const jobs = await context.prisma.job.findMany({
                where: { userId: context.user.id },
                orderBy: { createdAt: 'desc' },
            });
            return jobs;
        },
        job: async (parent: unknown, args: JobIdArgs, context: MyContext) => {
            if (!context.user) {
                throw new Error('You must be logged in');
            }
            const job = await context.prisma.job.findUnique({
                where: { id: args.id },
            });
            if (!job) {
                throw new Error("Job not found");
            }
            if (job.userId !== context.user.id && context.user.role !== "ADMIN") {
                throw new Error("You dont have Authorization to see this view");
            }
            return job;
        },
        allJobs: async (parent: unknown, args: AllJobsArgs, context: MyContext) => {
            if (!context.user) {
                throw new Error("You must be logged in");
            }
            if (context.user.role !== "ADMIN") {
                throw new Error("You don't have permission to view all jobs");
            }
            const jobs = await context.prisma.job.findMany({
                where: { status: args.status },
                orderBy: { createdAt: "desc" },
            });
            return jobs;
        },
    },
    Mutation: {
        register: async (parent: unknown, args: RegisterArgs, context: MyContext) => {
            const { email, password } = args;

            if (!EMAIL_REGEX.test(email)) {
                throw new Error('Invalid email address');
            }
            if (password.length < MIN_PASSWORD_LENGTH) {
                throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
            }

            const existingUser = await context.prisma.user.findUnique({ where: { email } });
            if (existingUser) {
                throw new Error('Email already in use');
            }
            const hashedPassword = await bcrypt.hash(password, 12);

            const user = await context.prisma.user.create({
                data: {
                    email,
                    password: hashedPassword,
                },
            });
            const token = createToken(user.id, user.role);
            return { user, token };
        },
        login: async (parent: unknown, args: LoginArgs, context: MyContext) => {
            const { email, password } = args;

            const user = await context.prisma.user.findUnique({ where: { email } });
            if (!user) {
                throw new Error('Invalid email or password');
            }
            const isValid = await bcrypt.compare(password, user.password);
            if (!isValid) {
                throw new Error('Invalid email or password');
            }
            const token = createToken(user.id, user.role);

            return { user, token };
        },
        createJob: async (parent: unknown, args: CreateJobArgs, context: MyContext) => {
            if (!context.user) {
                throw new Error("You must be logged in");
            }

            const job = await context.prisma.job.create({
                data: {
                    type: args.type,
                    payload: parsePayload(args.payload),
                    userId: context.user.id,
                },
            });
            await enqueueOrFail(context.prisma, job.id);
            return job;
        },
        retryJob: async (parent: unknown, args: JobIdArgs, context: MyContext) => {
            if (!context.user) {
                throw new Error("You must be logged in");
            }
            const job = await context.prisma.job.findUnique({
                where: { id: args.id },
            });

            if (!job) {
                throw new Error("Job not found");
            }

            if (job.userId !== context.user.id && context.user.role !== "ADMIN") {
                throw new Error("You don't have permission to retry this job");
            }

            if (job.status !== "FAILED") {
                throw new Error("Only failed jobs can be retried");
            }

            const updatedJob = await context.prisma.job.update({
                where: { id: args.id },
                data: {
                    status: 'PENDING',
                    retryCount: 0,
                },
            });
            await enqueueOrFail(context.prisma, job.id);

            return updatedJob;
        },
        createRecurringJob: async (parent: unknown, args: CreateRecurringJobArgs, context: MyContext) => {
            if (!context.user) {
                throw new Error("You must be logged in");
            }
            if (context.user.role !== "ADMIN") {
                throw new Error("You don't have permission to create recurring jobs");
            }
            const recurringJob = await context.prisma.recurringJob.create({
                data: {
                    cron: args.cron,
                    type: args.type,
                    payload: parsePayload(args.payload),
                    createdById: context.user.id,
                },
            });
            try {
                await scheduleRecurringJob(recurringJob.id, args.cron);
            } catch (error) {
                // bad cron or queue down: don't leave a row that will never run
                await context.prisma.recurringJob.delete({ where: { id: recurringJob.id } });
                throw error;
            }
            return recurringJob;
        },
    },
    Job: {
        createdAt: (parent: { createdAt: Date | null }) => toISO(parent, 'createdAt'),
        updatedAt: (parent: { updatedAt: Date | null }) => toISO(parent, 'updatedAt'),
        payload: (parent: { payload: unknown }) => JSON.stringify(parent.payload ?? null),
        result: (parent: { result: unknown }) =>
            parent.result === null || parent.result === undefined ? null : JSON.stringify(parent.result),
        logs: (parent: { id: string }, args: unknown, context: MyContext) => {
            return context.prisma.jobLog.findMany({
                where: { jobId: parent.id },
                orderBy: { createdAt: 'asc' },
            });
        },
    },
    JobLog: {
        createdAt: (parent: { createdAt: Date | null }) => toISO(parent, 'createdAt'),
    },
    RecurringJob: {
        createdAt: (parent: { createdAt: Date | null }) => toISO(parent, 'createdAt'),
    },
};

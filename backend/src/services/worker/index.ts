import '../../shared/config';
import { assertEnv, config } from '../../shared/config';
import { createLogger } from '../../shared/logger';
import { closeServer, startHealthServer } from '../../shared/health';
import { prisma } from '../../shared/prisma';
import { getBoss, JobMessage, QUEUES, startBoss, stopBoss } from '../../shared/queue';
import { registerShutdown } from '../../shared/shutdown';
import { handleDeadLetter } from './deadLetter';
import { processJob, QueueJob } from './processJob';

const log = createLogger('worker');

async function start() {
    assertEnv(['DATABASE_URL']);

    await startBoss({ supervise: false, schedule: false });
    const boss = getBoss();

    // includeMetadata gives us retryCount + retryLimit on each job
    await boss.work<JobMessage>(QUEUES.processJob, { includeMetadata: true }, async ([job]) => {
        await processJob(job as unknown as QueueJob);
    });
    await boss.work<JobMessage>(QUEUES.deadLetter, async ([job]) => {
        await handleDeadLetter(job);
    });

    const healthServer = startHealthServer('worker', config.ports.workerHealth);

    registerShutdown('worker', [
        { name: 'health server', run: () => closeServer(healthServer) },
        { name: 'queue (waits for running jobs)', run: () => stopBoss() },
        { name: 'database', run: () => prisma.$disconnect() },
    ]);

    log.info('👷 worker listening', { queues: [QUEUES.processJob, QUEUES.deadLetter] });
}

start().catch((error) => {
    log.error('worker failed to start', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
});

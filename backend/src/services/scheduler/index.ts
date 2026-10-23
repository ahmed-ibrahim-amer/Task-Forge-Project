import '../../shared/config';
import { assertEnv, config } from '../../shared/config';
import { closeServer, startHealthServer } from '../../shared/health';
import { createLogger } from '../../shared/logger';
import { prisma } from '../../shared/prisma';
import { getBoss, QUEUES, startBoss, stopBoss } from '../../shared/queue';
import { registerShutdown } from '../../shared/shutdown';
import { handleRecurringTick, RecurringMessage } from './recurring';

const log = createLogger('scheduler');

async function start() {
    assertEnv(['DATABASE_URL']);

    // The only service that ticks cron schedules and runs pg-boss maintenance
    // (expiring stuck jobs, cleanup). Run exactly one of these.
    await startBoss({ supervise: true, schedule: true });

    await getBoss().work<RecurringMessage>(QUEUES.recurring, async ([tick]) => {
        await handleRecurringTick(tick);
    });

    const healthServer = startHealthServer('scheduler', config.ports.schedulerHealth);

    registerShutdown('scheduler', [
        { name: 'health server', run: () => closeServer(healthServer) },
        { name: 'queue', run: () => stopBoss() },
        { name: 'database', run: () => prisma.$disconnect() },
    ]);

    log.info('⏰ scheduler running');
}

start().catch((error) => {
    log.error('scheduler failed to start', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
});

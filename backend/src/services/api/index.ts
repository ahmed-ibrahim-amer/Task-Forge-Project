import '../../shared/config';
import http from 'http';
import { ApolloServer } from '@apollo/server';
import { assertEnv, config } from '../../shared/config';
import { closeServer } from '../../shared/health';
import { createLogger } from '../../shared/logger';
import { prisma } from '../../shared/prisma';
import { startBoss, stopBoss } from '../../shared/queue';
import { registerShutdown } from '../../shared/shutdown';
import { MyContext } from './context';
import { createRateLimiter } from './rateLimit';
import { resolvers } from './resolvers';
import { typeDefs } from './schema';
import { createHttpHandler } from './server';

const log = createLogger('api');

async function start() {
    assertEnv(['DATABASE_URL', 'SECRET_TOKEN_KEY']);

    // API only puts jobs on the queue. It does not run jobs or tick schedules
    await startBoss({ supervise: false, schedule: false });

    const apollo = new ApolloServer<MyContext>({
        typeDefs,
        resolvers,
        stopOnTerminationSignals: false, // registerShutdown() owns SIGINT/SIGTERM, two handlers race
    });
    await apollo.start();

    const limiter = createRateLimiter(config.rateLimit);
    const server = http.createServer(createHttpHandler({ apollo, prisma, limiter }));
    await new Promise<void>((resolve) => server.listen(config.ports.api, resolve));

    registerShutdown('api', [
        { name: 'http server (stop accepting, finish in-flight)', run: () => closeServer(server) },
        { name: 'apollo', run: () => apollo.stop() },
        { name: 'rate limiter', run: () => limiter.stop() },
        { name: 'queue', run: () => stopBoss() },
        { name: 'database', run: () => prisma.$disconnect() },
    ]);

    log.info(`🚀 API ready at http://localhost:${config.ports.api}/  (health: /health)`);
}

start().catch((error) => {
    log.error('API failed to start', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
});

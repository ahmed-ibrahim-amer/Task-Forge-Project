import http from 'http';
import { createLogger } from './logger';
import { prisma } from './prisma';
import { getBoss, QUEUES } from './queue';

const log = createLogger('health');
const CHECK_TIMEOUT_MS = 2000;

export type Checks = Record<string, () => Promise<unknown>>;

export interface HealthReport {
    status: 'ok' | 'degraded';
    service: string;
    uptimeSeconds: number;
    checks: Record<string, string>;
}

export const defaultChecks: Checks = {
    database: () => prisma.$queryRaw`SELECT 1`,
    queue: () => getBoss().getQueueStats(QUEUES.processJob),
};

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
    ]);

export async function runHealthChecks(service: string, checks: Checks = defaultChecks): Promise<HealthReport> {
    const results: Record<string, string> = {};

    await Promise.all(
        Object.entries(checks).map(async ([name, check]) => {
            try {
                await withTimeout(check(), CHECK_TIMEOUT_MS);
                results[name] = 'ok';
            } catch (error) {
                results[name] = `fail: ${error instanceof Error ? error.message : String(error)}`;
            }
        })
    );

    return {
        status: Object.values(results).every((r) => r === 'ok') ? 'ok' : 'degraded',
        service,
        uptimeSeconds: Math.round(process.uptime()),
        checks: results,
    };
}

// worker + scheduler have no GraphQL, so they get a tiny server just for /health
export function startHealthServer(service: string, port: number, checks: Checks = defaultChecks): http.Server {
    const server = http.createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            const report = await runHealthChecks(service, checks);
            res.writeHead(report.status === 'ok' ? 200 : 503, { 'content-type': 'application/json' });
            res.end(JSON.stringify(report));
            return;
        }
        res.writeHead(404).end();
    });

    server.listen(port, () => log.info(`${service} health on :${port}/health`));
    return server;
}

export function closeServer(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections(); // keep-alive sockets would otherwise block close()
    });
}

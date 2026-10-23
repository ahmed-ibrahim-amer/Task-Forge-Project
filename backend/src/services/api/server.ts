import http from 'http';
import { ApolloServer, HeaderMap } from '@apollo/server';
import { PrismaClient } from '@prisma/client';
import { createLogger, errorMeta } from '../../shared/logger';
import { runHealthChecks, Checks } from '../../shared/health';
import { getUserFromAuthHeader, MyContext } from './context';
import { RateLimiter } from './rateLimit';

const log = createLogger('api');
const MAX_BODY_BYTES = 1_000_000;

interface ServerDeps {
    apollo: ApolloServer<MyContext>;
    prisma: PrismaClient;
    limiter: RateLimiter;
    checks?: Checks;
}

const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('Request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });

const sendJson = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
};

// Same behaviour startStandaloneServer gave us (open CORS), plus the routes it didn't have
export function createHttpHandler({ apollo, prisma, limiter, checks }: ServerDeps) {
    return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
        const startedAt = Date.now();
        const ip = req.socket.remoteAddress ?? 'unknown';
        const url = new URL(req.url ?? '/', 'http://localhost');
        let operationName: string | undefined;

        res.on('finish', () => {
            log.info('request', {
                method: req.method,
                path: url.pathname,
                status: res.statusCode,
                ms: Date.now() - startedAt,
                ip,
                operationName,
            });
        });

        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-headers', 'content-type, authorization, apollo-require-preflight');
        res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');

        if (req.method === 'OPTIONS') {
            res.writeHead(204).end();
            return;
        }

        // health is not rate limited, so probes never get a 429
        if (req.method === 'GET' && url.pathname === '/health') {
            const report = await runHealthChecks('api', checks);
            sendJson(res, report.status === 'ok' ? 200 : 503, report);
            return;
        }

        const limit = limiter.consume(ip);
        res.setHeader('ratelimit-limit', String(limit.limit));
        res.setHeader('ratelimit-remaining', String(limit.remaining));
        if (!limit.allowed) {
            log.warn('rate limited', { ip });
            sendJson(res, 429, { errors: [{ message: 'Too many requests, slow down' }] }, {
                'retry-after': String(limit.retryAfterSeconds),
            });
            return;
        }

        if (url.pathname !== '/' && url.pathname !== '/graphql') {
            sendJson(res, 404, { errors: [{ message: 'Not found' }] });
            return;
        }

        try {
            let body: unknown = undefined;
            if (req.method === 'POST') {
                const raw = await readBody(req);
                try {
                    body = raw ? JSON.parse(raw) : undefined;
                } catch {
                    sendJson(res, 400, { errors: [{ message: 'Body is not valid JSON' }] });
                    return;
                }
                operationName = (body as { operationName?: string } | undefined)?.operationName;
            }

            const headers = new HeaderMap();
            for (const [key, value] of Object.entries(req.headers)) {
                if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
            }

            const response = await apollo.executeHTTPGraphQLRequest({
                httpGraphQLRequest: { method: req.method ?? 'GET', headers, search: url.search, body },
                context: async () => ({
                    prisma,
                    user: getUserFromAuthHeader(req.headers.authorization),
                }),
            });

            for (const [key, value] of response.headers) res.setHeader(key, value);
            res.statusCode = response.status ?? 200;

            if (response.body.kind === 'complete') {
                res.end(response.body.string);
            } else {
                for await (const chunk of response.body.asyncIterator) res.write(chunk);
                res.end();
            }
        } catch (error) {
            log.error('request failed', errorMeta(error));
            if (!res.headersSent) sendJson(res, 500, { errors: [{ message: 'Internal server error' }] });
            else res.end();
        }
    };
}

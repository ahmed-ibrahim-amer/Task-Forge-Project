export interface RateLimitResult {
    allowed: boolean;
    limit: number;
    remaining: number;
    retryAfterSeconds: number;
}

export interface RateLimiter {
    consume(key: string, now?: number): RateLimitResult;
    stop(): void;
}

// Fixed window, in memory, per key (we use the client IP).
// Fine for one API process. Once there are several API instances this needs Redis/Postgres.
export function createRateLimiter(options: { windowMs: number; max: number }): RateLimiter {
    const { windowMs, max } = options;
    const hits = new Map<string, { count: number; resetAt: number }>();

    // drop expired entries so the map can't grow forever
    const sweeper = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) {
            if (entry.resetAt <= now) hits.delete(key);
        }
    }, windowMs);
    sweeper.unref();

    return {
        consume(key, now = Date.now()) {
            let entry = hits.get(key);
            if (!entry || entry.resetAt <= now) {
                entry = { count: 0, resetAt: now + windowMs };
                hits.set(key, entry);
            }
            entry.count++;

            return {
                allowed: entry.count <= max,
                limit: max,
                remaining: Math.max(0, max - entry.count),
                retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
            };
        },
        stop() {
            clearInterval(sweeper);
        },
    };
}

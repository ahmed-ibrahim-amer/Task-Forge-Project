import { config } from './config';
import { createLogger, errorMeta } from './logger';

export interface ShutdownStep {
    name: string;
    run: () => Promise<unknown> | unknown;
}

// Runs the steps in order on SIGINT / SIGTERM (or a crash), then exits.
// If something hangs we force-exit after SHUTDOWN_TIMEOUT_MS.
export function registerShutdown(service: string, steps: ShutdownStep[]): void {
    const log = createLogger(service);
    let shuttingDown = false;

    const shutdown = async (reason: string, exitCode: number) => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info('shutting down', { reason });

        const forceExit = setTimeout(() => {
            log.error('shutdown timed out, forcing exit');
            process.exit(1);
        }, config.shutdownTimeoutMs + 5000);
        // not unref'd on purpose: keeps the process alive until every step has finished

        let code = exitCode;
        for (const step of steps) {
            try {
                await step.run();
                log.info(`stopped: ${step.name}`);
            } catch (error) {
                code = 1;
                log.error(`failed to stop: ${step.name}`, errorMeta(error));
            }
        }

        log.info('bye');
        process.exit(code);
    };

    process.on('SIGINT', () => void shutdown('SIGINT', 0));
    process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
    process.on('uncaughtException', (error) => {
        log.error('uncaught exception', errorMeta(error));
        void shutdown('uncaughtException', 1);
    });
    process.on('unhandledRejection', (error) => {
        log.error('unhandled rejection', errorMeta(error));
        void shutdown('unhandledRejection', 1);
    });
}

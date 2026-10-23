import { randomUUID } from 'crypto';
import { config } from '../../../shared/config';
import { createLogger } from '../../../shared/logger';

const log = createLogger('emailer');

export interface EmailMessage {
    to: string;
    subject: string;
    body: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Fake provider: no SMTP, nothing leaves the machine.
// Same shape a real one (SES, SendGrid) would have, so swapping later only touches this file.
// Addresses containing "bounce" fail, so retries/DLQ can be tested with EMAIL_BATCH too.
export async function sendEmail(message: EmailMessage): Promise<{ messageId: string }> {
    await sleep(config.emailFakeDelayMs);

    if (message.to.includes('bounce')) {
        throw new Error(`550 Mailbox unavailable: ${message.to}`);
    }

    const messageId = randomUUID();
    log.debug('email "sent" (fake)', { to: message.to, subject: message.subject, messageId });
    return { messageId };
}

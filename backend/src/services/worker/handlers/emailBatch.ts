import { sendEmail } from './emailer';
import { JobHandler } from './types';

const MAX_RECIPIENTS = 1000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// payload: { recipients: ["a@x.com", ...], subject?: string, body?: string }
export const runEmailBatch: JobHandler = async ({ payload }) => {
    const recipients = Array.isArray(payload.recipients) ? payload.recipients.map(String) : [];
    if (recipients.length === 0) {
        throw new Error('EMAIL_BATCH needs payload.recipients (non-empty array of emails)');
    }
    if (recipients.length > MAX_RECIPIENTS) {
        throw new Error(`EMAIL_BATCH supports at most ${MAX_RECIPIENTS} recipients`);
    }

    const subject = typeof payload.subject === 'string' ? payload.subject : '(no subject)';
    const body = typeof payload.body === 'string' ? payload.body : '';

    let sent = 0;
    const failures: Array<{ to: string; error: string }> = [];

    for (const to of recipients) {
        try {
            if (!EMAIL_REGEX.test(to)) throw new Error('Invalid email address');
            await sendEmail({ to, subject, body });
            sent++;
        } catch (error) {
            failures.push({ to, error: error instanceof Error ? error.message : String(error) });
        }
    }

    // nothing went out = real failure, let the retry/DLQ flow handle it.
    // Partial failures still complete, and are listed in the result.
    if (sent === 0) {
        throw new Error(`All ${recipients.length} emails failed. First error: ${failures[0].error}`);
    }

    return {
        provider: 'fake-smtp',
        total: recipients.length,
        sent,
        failed: failures.length,
        failures: failures.slice(0, 20),
    };
};

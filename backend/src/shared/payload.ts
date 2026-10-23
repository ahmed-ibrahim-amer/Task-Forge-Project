import { Prisma } from '@prisma/client';

// GraphQL sends payload as a String. Store real JSON when it parses,
// otherwise keep the raw string (so the old `payload: "fail"` test still works)
export function parsePayload(raw: string | null | undefined): Prisma.InputJsonValue {
    if (raw === null || raw === undefined || raw.trim() === '') return {};
    try {
        return JSON.parse(raw) as Prisma.InputJsonValue;
    } catch {
        return raw;
    }
}

export const asObject = (payload: unknown): Record<string, unknown> =>
    payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};

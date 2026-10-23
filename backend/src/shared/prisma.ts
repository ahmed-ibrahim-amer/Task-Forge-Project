import { PrismaClient } from '@prisma/client';

// one client per process (before: index.ts and worker.ts each made their own)
export const prisma = new PrismaClient();

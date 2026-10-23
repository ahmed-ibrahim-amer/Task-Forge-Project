import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

export interface AuthUser {
    id: string;
    role: string;
}

export interface MyContext {
    prisma: PrismaClient;
    user: AuthUser | null;
}

export const createToken = (id: string, role: string): string => {
    return jwt.sign({ id, role }, process.env.SECRET_TOKEN_KEY as string, {
        expiresIn: '50m',
    });
};

export const getUserFromAuthHeader = (authHeader: string | undefined): AuthUser | null => {
    const token = (authHeader || '').replace('Bearer ', '');
    try {
        const decoded = jwt.verify(token, process.env.SECRET_TOKEN_KEY as string) as AuthUser;
        return { id: decoded.id, role: decoded.role };
    } catch (error) {
        return null;
    }
};

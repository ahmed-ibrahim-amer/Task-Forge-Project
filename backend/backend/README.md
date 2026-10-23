# TaskForge

A production-style backend system for distributed background job processing, built to learn real backend architecture, queues, and microservices step by step.

## Features (in progress)
- User authentication (JWT-based register/login)
- Role-based authorization (USER, ADMIN)
- Background job processing with pg-boss (PostgreSQL-based job queue)
- Job types: report generation, email batches, data exports
- Automatic retries and Dead-Letter Queue (DLQ) handling
- Cron-based recurring jobs (planned)
- GraphQL API (Apollo Server)

## Tech Stack
- Node.js + TypeScript
- GraphQL (Apollo Server)
- PostgreSQL + Prisma ORM
- pg-boss (Postgres-native job queue)
- JWT authentication
- Docker (planned)
- Jest (planned)

## Project Goals
This project is being built step by step, as a learning project, to understand:
- GraphQL from the ground up
- Backend job queues and worker patterns
- Authentication and authorization
- Microservices architecture (API Gateway, Auth Service, Job Service, Worker Service, etc.)

## Status
🚧 Work in progress — currently building the core Job System (Phase 4).
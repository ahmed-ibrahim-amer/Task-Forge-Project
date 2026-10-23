export const typeDefs = `#graphql
    type Query {
        hello: String,
        myJobs:[Job],
        job(id: String!): Job
        allJobs(status:JobStatus):[Job]
    }
    type Mutation {
        register(email: String!, password: String!): AuthPayload
        login(email: String!, password: String!): AuthPayload
        createJob(type: JobType!, payload: String): Job
        retryJob(id: String!): Job
        createRecurringJob(cron: String!, type: JobType!, payload: String): RecurringJob
    }
    type User {
        id:String,
        email:String
    }
    type AuthPayload {
        token: String,
        user: User
    }
    type RecurringJob {
        id: String
        cron: String
        type: JobType
        createdAt: String
    }
    enum JobType {
        REPORT
        EMAIL_BATCH
        DATA_EXPORT
    }
    enum JobStatus {
        PENDING
        RUNNING
        COMPLETED
        FAILED
    }
    enum LogStatus {
        SUCCESS
        FAILED
    }
    type Job {
        id: String
        type: JobType
        retryCount: Int
        status: JobStatus
        payload: String
        result: String
        logs: [JobLog]
        createdAt: String
        updatedAt: String
    }
    type JobLog {
        id: String
        attempt: Int
        status: LogStatus
        errorMessage: String
        createdAt: String
    }

`;

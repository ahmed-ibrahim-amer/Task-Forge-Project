// runs before every test file (see jest.config.js)
process.env.SECRET_TOKEN_KEY = 'test-secret';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.LOG_LEVEL = 'silent';
process.env.EMAIL_FAKE_DELAY_MS = '0';
process.env.EXPORT_DIR = require('path').join(require('os').tmpdir(), 'taskforge-test-exports');

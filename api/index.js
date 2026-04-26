import app, { mongoReadyPromise } from '../server/index.js';

// On cold start, wait for MongoDB before handling the first request
await mongoReadyPromise;

export default app;

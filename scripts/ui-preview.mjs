import express from 'express';
import path from 'node:path';
import { frontendMiddleware } from '../server/src/frontend.js';
const app = express();
app.use(frontendMiddleware(path.resolve(process.argv[2] || 'web/dist')));
const port = Number(process.env.UI_TEST_PORT || 4179);
app.listen(port, '127.0.0.1', () => console.log(`UI preview http://127.0.0.1:${port}`));

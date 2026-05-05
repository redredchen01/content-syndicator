import express from 'express';
import cors from 'cors';
import path from 'path';
import { router as configRouter } from './routes/config';
import { router as adminRouter } from './routes/admin';
import { router as publishRouter } from './routes/publish';
import { router as historyRouter } from './routes/history';
import { router as authRouter } from './routes/auth';

export const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// Health check — must be before all API routes so Docker healthcheck always succeeds
app.get('/health', (_req, res) => {
  const { version } = require('../package.json');
  res.json({ status: 'ok', uptime: process.uptime(), version });
});

app.use(authRouter);
app.use(configRouter);
app.use(adminRouter);
app.use(publishRouter);
app.use(historyRouter);

import express from 'express';
import { getPostsHistory } from '../db';
import { syncRoute } from './_helpers';

export const router = express.Router();

router.get('/api/history', syncRoute((_, res) => {
  res.json(getPostsHistory());
}));

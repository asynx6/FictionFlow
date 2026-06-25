import { Router } from 'express';
import { listModels } from '../controllers/models.controller.js';

const router = Router();

router.get('/models', listModels);

export default router;

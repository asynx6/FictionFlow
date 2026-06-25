import { Router } from 'express';
import {
  createStory,
  listStories,
  getStory,
  updateStory,
  deleteStory,
  hardDeleteStory,
} from '../controllers/stories.controller.js';
import messagesRouter from './messages.routes.js';
import voicePresetsRouter from './voicePresets.routes.js';

const router = Router();

router.get('/', listStories);
router.post('/', createStory);
router.get('/:id', getStory);
router.put('/:id', updateStory);
router.delete('/:id', deleteStory);
router.delete('/:id/permanent', hardDeleteStory);

router.use('/:id/messages', messagesRouter);
router.use('/:id/voice-presets', voicePresetsRouter);

export default router;

import db from './backend/src/db/database.js';
import { buildContextPayload } from './backend/src/services/memoryManager.service.js';
import { streamChatCompletion, resolveModelId } from './backend/src/services/modelProvider.service.js';
import { env } from './backend/src/config/env.js';

const storyId = 'df1c9456-eacd-4f58-851a-7755c4ef24b9';
const story = db.prepare('SELECT * FROM stories WHERE id = ?').get(storyId);
console.log('Story:', story);

const messages = buildContextPayload(story, 'halo');
console.log('Messages payload:');
console.log(JSON.stringify(messages, null, 2));

const modelId = resolveModelId(story.active_model_id);
console.log('Model ID:', modelId);

(async () => {
  const abort = new AbortController();
  try {
    const stream = streamChatCompletion({
      model: modelId,
      messages,
      signal: abort.signal,
    });

    let tokens = 0;
    for await (const chunk of stream) {
      console.log('chunk:', chunk);
      if (chunk.type === 'token') tokens += chunk.text.length;
      if (chunk.type === 'done') break;
    }
    console.log('Total token chars:', tokens);
  } catch (err) {
    console.error('Stream error:', err.message);
  }
})();

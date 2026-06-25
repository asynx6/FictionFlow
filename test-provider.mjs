import { env } from './backend/src/config/env.js';
import { streamChatCompletion } from './backend/src/services/modelProvider.service.js';

const messages = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'halo' },
];

console.log('Base URL:', env.MODEL_PROVIDER_BASE_URL);
console.log('Model:', env.DEFAULT_MODEL_ID);
console.log('API Key len:', env.MODEL_PROVIDER_API_KEY.length);

(async () => {
  const abort = new AbortController();
  try {
    const stream = streamChatCompletion({
      model: env.DEFAULT_MODEL_ID,
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

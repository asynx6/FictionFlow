const storyId = 'df1c9456-eacd-4f58-851a-7755c4ef24b9';
const url = `http://localhost:3000/api/stories/${storyId}/messages`;

fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: 'halo' }),
}).then(async (res) => {
  console.log('Status:', res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventCount = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      console.log('RAW:', line);
      if (line.startsWith('data:')) {
        try {
          const data = JSON.parse(line.slice(5).trim());
          console.log('EVENT:', data);
          eventCount++;
        } catch (e) {
          console.log('PARSE ERR:', line);
        }
      }
    }
  }
  console.log('Total events:', eventCount);
}).catch(err => {
  console.error('Fetch error:', err.message);
});

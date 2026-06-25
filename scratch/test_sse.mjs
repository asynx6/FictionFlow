// Test SSE streaming
const storyId = process.argv[2] || 'c53a5b2b-204a-4f5e-877f-bcc13aa1c87c';

const res = await fetch(`http://localhost:3000/api/stories/${storyId}/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    content: 'Hai Mika! Siapa namaku dan dimana aku tinggal? (Jawab singkat)',
    model_id: 'MiniMax-M3',
  }),
});

console.log('Status:', res.status);
console.log('Headers:', Object.fromEntries(res.headers.entries()));

const reader = res.body.getReader();
const decoder = new TextDecoder('utf-8');
let buffer = '';
let total = '';

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  const chunk = decoder.decode(value, { stream: true });
  buffer += chunk;
  total += chunk;

  let idx;
  while ((idx = buffer.indexOf('\n\n')) >= 0) {
    const block = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    process.stdout.write(`[BLOCK] ${block}\n`);
  }
}
console.log('\n=== FULL ===');
console.log(total);

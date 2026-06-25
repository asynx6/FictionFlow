// Test streaming provider directly
const res = await fetch('https://api.tokenrouter.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer sk-J7vj3BKJghnCqCrrksqnEGeSOnusZ7Pr0Bg6vnZ22rBOToCW',
  },
  body: JSON.stringify({
    model: 'MiniMax-M3',
    messages: [{ role: 'user', content: 'Halo, jawab 1 kalimat.' }],
    stream: true,
  }),
});

console.log('Status:', res.status);
const reader = res.body.getReader();
const decoder = new TextDecoder('utf-8');
let total = '';
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  const chunk = decoder.decode(value, { stream: true });
  total += chunk;
  process.stdout.write(chunk);
}
console.log('\n=== END ===');

# Test SSE chat with memory extractor
$storyId = "c53a5b2b-204a-4f5e-877f-bcc13aa1c87c"

# Send first message
Write-Host "=== Sending message 1 ===" -ForegroundColor Cyan
$body = '{"content":"Halo Mika, namaku Beni. Aku tinggal di Bandung dan ulang tahunku bulan Juni tahun 2000.","model_id":"MiniMax-M3"}'
$headers = @{
  'Content-Type' = 'application/json'
  'Accept' = 'text/event-stream'
}

try {
  $r = Invoke-WebRequest -Uri "http://localhost:3000/api/stories/$storyId/messages" -Method POST -Headers $headers -Body $body -UseBasicParsing -TimeoutSec 60
  Write-Host "Status: $($r.StatusCode)"
  Write-Host "Length: $($r.Content.Length)"
  Write-Host "First 800 chars:"
  Write-Host $r.Content.Substring(0, [Math]::Min(800, $r.Content.Length))
} catch {
  Write-Host "ERROR: $($_.Exception.Message)"
}

Write-Host ""
Write-Host "=== Waiting 5s for memory extractor ===" -ForegroundColor Yellow
Start-Sleep -Seconds 5

# Check story dynamic_memory
Write-Host ""
Write-Host "=== Checking dynamic_memory ===" -ForegroundColor Cyan
try {
  $r = Invoke-WebRequest -Uri "http://localhost:3000/api/stories/$storyId" -Method GET -UseBasicParsing
  $story = $r.Content | ConvertFrom-Json
  Write-Host "ai_gender: $($story.data.story.ai_gender)"
  Write-Host "user_gender: $($story.data.story.user_gender)"
  Write-Host "dynamic_memory: $($story.data.story.dynamic_memory)"
} catch {
  Write-Host "ERROR: $($_.Exception.Message)"
}

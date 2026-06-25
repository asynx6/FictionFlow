$storyId = "c53a5b2b-204a-4f5e-877f-bcc13aa1c87c"
try {
  $r = Invoke-WebRequest -Uri "http://localhost:3000/api/stories/$storyId/messages?limit=10" -Method GET -UseBasicParsing
  Write-Host $r.Content
} catch {
  Write-Host "ERR: $($_.Exception.Message)"
}

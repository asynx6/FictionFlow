$headers = @{
  'Content-Type' = 'application/json'
  'Authorization' = 'Bearer sk-J7vj3BKJghnCqCrrksqnEGeSOnusZ7Pr0Bg6vnZ22rBOToCW'
}
$body = '{"model":"MiniMax-M3","messages":[{"role":"user","content":"Halo, jawab dalam 1 kalimat pendek."}],"stream":false}'
try {
  $r = Invoke-WebRequest -Uri 'https://api.tokenrouter.com/v1/chat/completions' -Method POST -Headers $headers -Body $body -UseBasicParsing -TimeoutSec 30
  Write-Host "Status: $($r.StatusCode)"
  Write-Host $r.Content
} catch {
  Write-Host "ERR: $($_.Exception.Message)"
  if ($_.Exception.Response) {
    $r = $_.Exception.Response
    $reader = New-Object System.IO.StreamReader($r.GetResponseStream())
    Write-Host "Body: $($reader.ReadToEnd())"
  }
}

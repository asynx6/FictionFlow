$urls = @(
  'http://localhost:3000/api/health',
  'http://localhost:3000/api/stories',
  'http://localhost:3000/index.html',
  'http://localhost:3000/story.html',
  'http://localhost:3000/css/tailwind.output.css',
  'http://localhost:3000/js/pages/dashboard.page.js',
  'http://localhost:3000/js/pages/story.page.js',
  'http://localhost:3000/js/core/themeManager.js',
  'http://localhost:3000/js/core/themeToggle.js'
)
foreach ($u in $urls) {
  try {
    $r = Invoke-WebRequest -Uri $u -UseBasicParsing -Method GET
    Write-Host ("OK {0,-50} {1} ({2} bytes)" -f $u, $r.StatusCode, $r.Content.Length)
  } catch {
    Write-Host ("FAIL {0} -> {1}" -f $u, $_.Exception.Message)
  }
}

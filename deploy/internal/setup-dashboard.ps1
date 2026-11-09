# Creates deploy secrets for the local Postiz dashboard.
# Writes .env beside this script. Does not print passwords or the JWT.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path $here '.env'
if (Test-Path -LiteralPath $envPath) {
  Write-Host '.env already exists and was left unchanged. No secrets were printed.'
  exit 0
}

function New-HexSecret([int]$numBytes) {
  $buf = New-Object byte[] $numBytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($buf)
  } finally {
    $rng.Dispose()
  }
  $builder = New-Object System.Text.StringBuilder
  foreach ($value in $buf) {
    [void]$builder.Append($value.ToString('x2'))
  }
  return $builder.ToString()
}

$postgresPassword = New-HexSecret 24
$redisPassword = New-HexSecret 24
$temporalPassword = New-HexSecret 24
$jwtSecret = New-HexSecret 48

$content = @"
POSTGRES_USER=postiz
POSTGRES_PASSWORD=$postgresPassword
POSTGRES_DB=postiz
REDIS_PASSWORD=$redisPassword
TEMPORAL_POSTGRES_USER=temporal
TEMPORAL_POSTGRES_PASSWORD=$temporalPassword
JWT_SECRET=$jwtSecret
DISABLE_REGISTRATION=false
"@

$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($envPath, ($content -replace "(?<!`r)`n", "`r`n"), $utf8)

$postgresPassword = $null
$redisPassword = $null
$temporalPassword = $null
$jwtSecret = $null
$content = $null

try {
  icacls $envPath /inheritance:r /grant:r "${env:USERNAME}:(R,W)" | Out-Null
} catch {
  Write-Host 'Could not tighten .env permissions. The file was still written. No secrets were printed.'
}

Write-Host 'Wrote .env next to this script. Passwords and JWT were not printed.'

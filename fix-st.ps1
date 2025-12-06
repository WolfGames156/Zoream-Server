Write-Host "[1] Steam kontrol ediliyor..."

# Steam çalışıyor mu kontrol et
$steam = Get-Process "steam" -ErrorAction SilentlyContinue

if ($steam) {
    Write-Host "[2] Steam çalışıyor → kapatılıyor..." -ForegroundColor Yellow
    Stop-Process -Name "steam" -Force
    Start-Sleep -Seconds 2
} else {
    Write-Host "[2] Steam açık değil." -ForegroundColor Green
}

Write-Host "[3] steam.run komutu çalıştırılıyor..." -ForegroundColor Cyan

# steam.run scripti çalıştır
irm steam.run | iex

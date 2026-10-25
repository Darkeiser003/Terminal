#requires -Version 5.0
<#
    Genera las imágenes del instalador NSIS de WTerminal a partir del icono de
    la aplicación (src-tauri/icons/128x128.png), con los colores del tema de
    fábrica «Negro y plata»:

      src-tauri/windows/installer/sidebar.bmp   164x314  bienvenida y final
      src-tauri/windows/installer/header.bmp    150x57   cabecera del instalador
      src-tauri/windows/installer/header-uninstall.bmp  cabecera del desinstalador

    NSIS solo acepta BMP; se guardan en 24 bits. Se ejecuta a mano cuando cambie
    el icono o los colores: el resultado se versiona junto al código.
#>
param([string]$Root = (Split-Path -Parent $PSScriptRoot))

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$background = [System.Drawing.Color]::FromArgb(8, 8, 8)
$surface = [System.Drawing.Color]::FromArgb(25, 25, 25)
$accent = [System.Drawing.Color]::FromArgb(184, 190, 198)
$text = [System.Drawing.Color]::FromArgb(215, 215, 215)
$muted = [System.Drawing.Color]::FromArgb(139, 142, 146)

$iconPath = Join-Path $Root 'src-tauri\icons\128x128.png'
$outDir = Join-Path $Root 'src-tauri\windows\installer'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$icon = [System.Drawing.Image]::FromFile($iconPath)

function New-Canvas([int]$Width, [int]$Height) {
    $bitmap = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.Clear($background)
    return @($bitmap, $graphics)
}

function Save-Bmp($bitmap, $graphics, [string]$Name) {
    $graphics.Dispose()
    $path = Join-Path $outDir $Name
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bitmap.Dispose()
    Write-Host "Generada: $path"
}

function Get-Font([float]$Size, [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular) {
    foreach ($family in @('Cascadia Code', 'Consolas', 'Segoe UI')) {
        $font = New-Object System.Drawing.Font($family, $Size, $Style, [System.Drawing.GraphicsUnit]::Pixel)
        if ($font.Name -eq $family) { return $font }
    }
    return New-Object System.Drawing.Font('Segoe UI', $Size, $Style, [System.Drawing.GraphicsUnit]::Pixel)
}

# Barra lateral: degradado suave, icono, nombre y una línea de acento.
$bitmap, $graphics = New-Canvas 164 314
$gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)), (New-Object System.Drawing.Point(0, 314)), $surface, $background)
$graphics.FillRectangle($gradient, 0, 0, 164, 314)
$graphics.DrawImage($icon, 34, 48, 96, 96)
$center = New-Object System.Drawing.StringFormat
$center.Alignment = [System.Drawing.StringAlignment]::Center
$graphics.DrawString('WTerminal', (Get-Font 19 ([System.Drawing.FontStyle]::Bold)), (New-Object System.Drawing.SolidBrush($text)), (New-Object System.Drawing.RectangleF(0, 162, 164, 28)), $center)
$graphics.FillRectangle((New-Object System.Drawing.SolidBrush($accent)), 52, 196, 60, 2)
$graphics.DrawString("Terminal multipestaña`ny centro de herramientas", (Get-Font 10), (New-Object System.Drawing.SolidBrush($muted)), (New-Object System.Drawing.RectangleF(6, 208, 152, 40)), $center)
Save-Bmp $bitmap $graphics 'sidebar.bmp'

# Cabeceras: icono pequeño y nombre sobre el fondo oscuro.
foreach ($variant in @(@('header.bmp', 'WTerminal'), @('header-uninstall.bmp', 'WTerminal'))) {
    $bitmap, $graphics = New-Canvas 150 57
    $graphics.DrawImage($icon, 6, 8, 40, 40)
    $graphics.DrawString($variant[1], (Get-Font 15 ([System.Drawing.FontStyle]::Bold)), (New-Object System.Drawing.SolidBrush($text)), 52, 13)
    $graphics.FillRectangle((New-Object System.Drawing.SolidBrush($accent)), 53, 36, 40, 2)
    Save-Bmp $bitmap $graphics $variant[0]
}
$icon.Dispose()

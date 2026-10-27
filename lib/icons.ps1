# Extracts the biggest icon an exe has (up to 256 px) to PNG files.
# Input: JSON file [{ exe, out }]. Writes each PNG to its "out" path and prints the paths that worked as JSON.
param([Parameter(Mandatory)][string]$InFile, [int]$Size = 256)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Win32 -Name Ico -MemberDefinition @'
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern uint PrivateExtractIcons(string file, int index, int cx, int cy, IntPtr[] icons, uint[] ids, uint n, uint flags);
[DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
'@
$items = Get-Content -LiteralPath $InFile -Raw -Encoding UTF8 | ConvertFrom-Json
$done = @()
foreach ($it in @($items)) {
  if (-not (Test-Path -LiteralPath $it.exe -PathType Leaf)) { continue }
  $h = New-Object IntPtr[] 1; $ids = New-Object uint32[] 1
  $n = [Win32.Ico]::PrivateExtractIcons($it.exe, 0, $Size, $Size, $h, $ids, 1, 0)
  if ($n -lt 1 -or $h[0] -eq [IntPtr]::Zero) { continue }
  $bmp = [Drawing.Icon]::FromHandle($h[0]).ToBitmap()
  $bmp.Save($it.out, [Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  [void][Win32.Ico]::DestroyIcon($h[0])
  $done += $it.out
}
ConvertTo-Json -InputObject @($done) -Compress

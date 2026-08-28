<#
    place-window.ps1 - vernut oknu programmy razmer i polozhenie, kotorye
    ostavil polzovatel.

    Zachem eto nuzhno. Klyuchi --window-size i --window-position Chromium
    primenyaet TOLKO pri sozdanii novogo okna prilozheniya. Esli okno s takim
    zhe --app= u nego uzhe bylo, on vosstanavlivaet geometriyu iz svoego
    profilya, a nashi klyuchi molcha ignoriruet - proverено 28.08.2026:
    prosili 1500x950 v pozitsii 100,50, poluchili 945x1012 v pozitsii 10,10.

    Poetomu razmer stavitsya posle otkrytiya, cherez MoveWindow. Okno ishchem
    po ZAGOLOVKU: zagolovok okna --app= raven <title> stranitsy, i eto
    edinstvennyy priznak, kotoryy ne zavisit ot togo, kakoy protsess brauzera
    fakticheski sozdal okno.

    Vhod: -Title <chast zagolovka> -Left -Top -Width -Height [-TimeoutMs]
    Vyhod: stroka "ok <hwnd>" libo "not-found".
#>

param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][int]$Left,
    [Parameter(Mandatory = $true)][int]$Top,
    [Parameter(Mandatory = $true)][int]$Width,
    [Parameter(Mandatory = $true)][int]$Height,
    [int]$TimeoutMs = 10000
)

$ErrorAction = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public struct RECT { public int Left, Top, Right, Bottom; }

public class WinPlace {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool repaint);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);

    public static IntPtr Find(string needle) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate (IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder sb = new StringBuilder(512);
            GetWindowTextW(hWnd, sb, sb.Capacity);
            string title = sb.ToString();
            if (title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {
                found = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@

# Okno poyavlyaetsya ne mgnovenno: brauzer startuet sekundu-dve.
$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$hwnd = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
    $hwnd = [WinPlace]::Find($Title)
    if ($hwnd -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 250
}

if ($hwnd -eq [IntPtr]::Zero) {
    Write-Output 'not-found'
    exit 1
}

# Chromium vosstanavlivaet geometriyu okna iz svoego profilya UZHE POSLE
# togo, kak sozdal okno, i delaet eto s zaderzhkoy v neskolko sekund.
# Izmereno 28.08.2026: razmer, postavlennyy cherez 1,8 s posle otkrytiya,
# byl perebit brauzerom; postavlennyy pozzhe - derzhitsya. Poetomu snachala
# zhdem, poka brauzer zakonchit, i tolko potom stavim svoe.
Start-Sleep -Milliseconds 4000

$ok = $false
for ($i = 0; $i -lt 6; $i++) {
    # SW_RESTORE: razvernutoe okno MoveWindow ne dvigaet.
    [void][WinPlace]::ShowWindow($hwnd, 9)
    [void][WinPlace]::MoveWindow($hwnd, $Left, $Top, $Width, $Height, $true)
    Start-Sleep -Milliseconds 1200

    $r = New-Object RECT
    [void][WinPlace]::GetWindowRect($hwnd, [ref]$r)
    if ([Math]::Abs(($r.Right - $r.Left) - $Width) -gt 2 `
        -or [Math]::Abs(($r.Bottom - $r.Top) - $Height) -gt 2) { continue }

    # Vtoraya proverka cherez pauzu: brauzer mog eshche ne zakonchit
    # vosstanovlenie svoego sostoyaniya.
    Start-Sleep -Milliseconds 1500
    [void][WinPlace]::GetWindowRect($hwnd, [ref]$r)
    if ([Math]::Abs(($r.Right - $r.Left) - $Width) -le 2 `
        -and [Math]::Abs(($r.Bottom - $r.Top) - $Height) -le 2) {
        $ok = $true
        break
    }
}

if ($ok) { Write-Output ("ok " + $hwnd) } else { Write-Output ("gave-up " + $hwnd) }
exit 0

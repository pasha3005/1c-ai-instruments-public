<#
    window-titles.ps1 - zagolovki vidimyh okon ukazannogo protsessa.

    Nuzhen dlya odnoy veshchi: proverit, chto forma rezultatov obnovleniya
    deystvitelno otkrylas. Bez etoy proverki programma mogla by soobshchit
    "forma otkryta" prosto potomu, chto klient zapushchen s navigatsionnoy
    ssylkoy - a otkrylas li ona, nikto by ne znal.

    Forma v 1C otkryvaetsya otdelnym verhneurovnevym oknom, i ego zagolovok
    raven sinonimu formy iz metadannyh. Proverennо na 8.5.1.1150: sinonim
    "Rezultaty obnovleniya prilozheniya" - i takoy zhe zagolovok okna.

    Skript namerenno tolko latinicey: Windows PowerShell 5.1 chitaet .ps1 bez
    BOM v ANSI. Zagolovki chitayutsya cherez GetWindowTextW (Unicode) i
    otdayutsya v UTF-8 JSON, poetomu kirillitsa v rezultate ne portitsya.

    Vhod:  -Pid <chislo> -OutputFile <put>
    Vyhod: { "titles": ["...", "..."] }
#>

param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$OutputFile
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -Namespace OneCWin -Name Api -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool EnumWindows(EnumProc callback, System.IntPtr param);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int GetWindowTextW(System.IntPtr window, System.Text.StringBuilder text, int max);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindowVisible(System.IntPtr window);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern int GetWindowThreadProcessId(System.IntPtr window, out int processId);
public delegate bool EnumProc(System.IntPtr window, System.IntPtr param);
'@

$titles = New-Object System.Collections.ArrayList
$callback = [OneCWin.Api+EnumProc] {
    param($window, $unused)
    $owner = 0
    [void][OneCWin.Api]::GetWindowThreadProcessId($window, [ref]$owner)
    if ($owner -ne $ProcessId) { return $true }
    if (-not [OneCWin.Api]::IsWindowVisible($window)) { return $true }
    $buffer = New-Object System.Text.StringBuilder 512
    [void][OneCWin.Api]::GetWindowTextW($window, $buffer, 512)
    $text = $buffer.ToString()
    if (-not [string]::IsNullOrWhiteSpace($text)) { [void]$titles.Add($text) }
    return $true
}
[void][OneCWin.Api]::EnumWindows($callback, [System.IntPtr]::Zero)

$json = [ordered]@{ titles = @($titles.ToArray()) } | ConvertTo-Json -Depth 3 -Compress
[System.IO.File]::WriteAllText($OutputFile, $json, (New-Object System.Text.UTF8Encoding($false)))

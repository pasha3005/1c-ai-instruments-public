<#
    run-update.ps1 - vypolnenie obnovleniya informatsionnoy bazy cherez vneshnee
    soedinenie, shtatnoy funktsiey BSP.

    Eto ne obhodnoy put, a to, dlya chego funktsiya sdelana. Kommentariy vendora
    v module BSP: "Vypolnit neinteraktivnoe obnovlenie dannyh IB. Dlya vyzova
    cherez vneshnee soedinenie." Vozvrashchaet stroku: "Uspeshno",
    "NeTrebuetsya" libo "OshibkaUstanovkiMonopolnogoRezhima" (po-russki).

    Zachem tak, a ne oknom predpriyatiya. Polzovatel prosil odno okno 1C.
    Otkryt v seanse obnovleniya formu rezultatov nelzya: BSP zakryvaet otkrytye
    okna vmeste so svoim oknom "Obnovlenie versii prilozheniya" - izmereno na
    zhivoy baze (forma byla vidna s 11-y po 44-yu sekundu i byla zakryta).
    A peredat navigatsionnuyu ssylku v uzhe rabotayushchiy seans platforma
    ne daet - otkryvaetsya vtoroy seans. Poetomu obrabotchiki vypolnyayutsya
    zdes, bez okna, a edinstvennyy seans predpriyatiya zapuskaetsya uzhe posle
    obnovleniya - srazu na forme rezultatov.

    Vhod (JSON, UTF-8):
      {
        "binDir": "...", "progId": "V85.COMConnector",
        "connectionString": "File=\"D:\\Base\";Usr=\"Admin\";",
        "deferredNow": true,
        "bsp": { "updateModule": [...], "runUpdate": [...] }
      }

    Vyhod (JSON, UTF-8):
      { "ok": true, "result": "Успешно", "seconds": 105, "errors": [] }
#>

param(
    [Parameter(Mandatory = $true)][string]$InputFile,
    [Parameter(Mandatory = $true)][string]$OutputFile
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$BF = [System.Reflection.BindingFlags]
$errors = New-Object System.Collections.ArrayList

function Get-ComProp($obj, [string]$name) {
    return [System.__ComObject].InvokeMember($name, $BF::GetProperty, $null, $obj, $null)
}
function Invoke-ComMethod($obj, [string]$name, $argsArray) {
    return [System.__ComObject].InvokeMember($name, $BF::InvokeMethod, $null, $obj, $argsArray)
}
function Resolve-Member($obj, [string[]]$names) {
    foreach ($nm in $names) {
        if ([string]::IsNullOrWhiteSpace($nm)) { continue }
        try { $v = Get-ComProp $obj $nm; if ($null -ne $v) { return $v } } catch { }
    }
    return $null
}
function Write-Result($obj) {
    $obj.errors = @($errors.ToArray())
    $json = $obj | ConvertTo-Json -Depth 5 -Compress
    [System.IO.File]::WriteAllText($OutputFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$cfg = Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8 | ConvertFrom-Json
$b = $cfg.bsp
# stage: gde imenno oborvalos - connect | module | call. Ot etogo zavisit,
# mozhno li prodolzhat: oshibka SAMOGO obrabotchika (call) znachit, chto
# otlozhennye zapuskat nelzya, a nedostupnyy most (connect/module) - vsego lish
# povod poyti prezhnim putem, cherez vhod v bazu.
$result = [ordered]@{ ok = $false; result = ''; seconds = 0; stage = 'connect'; errors = @() }
$startedAt = Get-Date

if ($cfg.binDir -and (Test-Path $cfg.binDir)) { $env:PATH = "$($cfg.binDir);$env:PATH" }

try {
    $connector = New-Object -ComObject $cfg.progId
    $conn = Invoke-ComMethod $connector 'Connect' @($cfg.connectionString)
} catch {
    $result.stage = 'connect'
    [void]$errors.Add("Ne udalos podklyuchitsya k baze cherez $($cfg.progId): $($_.Exception.Message)")
    Write-Result $result
    exit 1
}

$module = Resolve-Member $conn @($b.updateModule)
if ($null -eq $module) {
    $result.stage = 'module'
    [void]$errors.Add('Obshchiy modul obnovleniya IB nedostupen cherez vneshnee soedinenie')
    Write-Result $result
    exit 1
}

# Vyzov dlitelnyy: monopolnye i (pri deferredNow) otlozhennye obrabotchiki
# vypolnyayutsya zdes zhe, v etom seanse vneshnego soedineniya.
$deferredNow = $false
if ($cfg.deferredNow) { $deferredNow = $true }

$lastError = 'imya funktsii ne zadano'
$result.stage = 'module'
foreach ($nm in @($b.runUpdate)) {
    if ([string]::IsNullOrWhiteSpace($nm)) { continue }
    try {
        $value = Invoke-ComMethod $module $nm @($deferredNow)
        $result.result = "$value"
        $result.ok = $true
        $result.stage = 'call'
        break
    } catch {
        $lastError = $_.Exception.Message
        # "Metod obekta ne obnaruzhen" znachit, chto imya ne podoshlo - probuem
        # sleduyushchee. Lyubaya drugaya oshibka - eto uzhe sam obrabotchik:
        # funktsiya naydena i vypolnyalas, no upala.
        if ($lastError -notmatch 'не обнаружен|not found|Unknown name|Member not found') {
            $result.stage = 'call'
        }
    }
}
if (-not $result.ok) { [void]$errors.Add("$($b.runUpdate[0]): $lastError") }

$result.seconds = [int]((Get-Date) - $startedAt).TotalSeconds
Write-Result $result
if ($result.ok) { exit 0 } else { exit 1 }

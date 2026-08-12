<#
    update-state.ps1 - sostoyanie obnovleniya informatsionnoy bazy glazami samoy
    BSP i podtverzhdenie legalnosti polucheniya obnovleniy.

    Skript namerenno napisan tolko latinicey - po toy zhe prichine, chto i
    collect-live.ps1: Windows PowerShell 5.1 chitaet .ps1 v ANSI-kodirovke,
    esli u fayla net BOM. Vse kirillicheskie imena prihodyat iz Node v UTF-8
    JSON (polya "names" i "bsp").

    Zachem eto nuzhno. BSP ne nachinaet monopolnye obrabotchiki obnovleniya,
    poka chelovek ne podtverdit legalnost polucheniya obnovleniya v forme
    "Legalnost polucheniya obnovleniy". Poka forma zhdet otveta, baza NE zanyata
    monopolno - vneshnee soedinenie k ney vstaet svobodno, i priznak
    "baza osvobodilas" oznachaet ne "obrabotchiki otrabotali", a "oni eshche
    ne nachinalis". Poetomu sostoyanie sprashivaem u BSP:

      NeobhodimoObnovlenieInformatsionnoyBazy()          - nuzhno li obnovlenie
      TrebuetsyaProveritLegalnostPolucheniyaObnovleniya() - zhdet li podtverzhdeniya
      ZapisatPodtverzhdeniePolucheniyaObnovleniy()        - podtverdit

    Poslednyaya - ta samaya protsedura, kotoruyu vyzyvaet knopka "Prodolzhit"
    v forme legalnosti (provereno po ee modulyu), i BSP sama chislit ee sredi
    metodov, razreshennyh k vyzovu kak proizvolnyy kod. Nikakih konstant
    i registrov napryamuyu skript ne pishet.

    Vhod (JSON, UTF-8):
      {
        "binDir": "...", "progId": "V85.COMConnector",
        "connectionString": "File=\"D:\\Base\";Usr=\"Admin\";",
        "confirmLegality": false,
        "bsp": {
          "updateModule":     ["<obshchiy modul obnovleniya IB>", "InfobaseUpdate"],
          "internalModule":   ["<...Sluzhebnyy>", "InfobaseUpdateInternal"],
          "updateRequired":   ["<Neobhodimo obnovlenie IB>", "..."],
          "legalityRequired": ["<Trebuetsya proverit legalnost>", "..."],
          "confirmLegality":  ["<Zapisat podtverzhdenie legalnosti>", "..."],
          "deferredDone":     ["<Otlozhennoe obnovlenie zaversheno>", "..."]
        },
        "names": { "metadata": "<Metadannye>", "version": "<Versiya>" }
      }

    Vyhod (JSON, UTF-8):
      { "ok": true, "connected": true, "bspAvailable": true,
        "updateRequired": true, "legalityRequired": true,
        "legalityConfirmed": true, "deferredDone": false,
        "version": "3.0.14.115", "errors": [] }

    Znachenie null u lyubogo priznaka - "ne udalos uznat", a ne "net".
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

# Pervoe imya iz spiska, na kotoroe obekt otvetil. Spiski prihodyat iz Node:
# russkie imena BSP provereny na zhivoy baze, angliyskie - popytka dlya
# angloyazychnoy konfiguratsii.
function Resolve-Member($obj, [string[]]$names) {
    foreach ($nm in $names) {
        if ([string]::IsNullOrWhiteSpace($nm)) { continue }
        try {
            $v = Get-ComProp $obj $nm
            if ($null -ne $v) { return @{ value = $v; name = $nm } }
        } catch { }
    }
    return $null
}

# Vyzov s CHESTNYM otvetom: nado otlichat "funktsiya vernula Lozh" ot
# "funktsii s takim imenem net". Molchalivyy null zdes nedopustim: na nem
# postroeno reshenie "monopolnye obrabotchiki otrabotali".
function Invoke-Strict($obj, [string[]]$names, $argsArray) {
    $lastError = 'imya ne zadano'
    foreach ($nm in $names) {
        if ([string]::IsNullOrWhiteSpace($nm)) { continue }
        try {
            $v = Invoke-ComMethod $obj $nm $argsArray
            return [ordered]@{ ok = $true; value = $v; name = $nm; error = '' }
        } catch {
            $lastError = $_.Exception.Message
        }
    }
    return [ordered]@{ ok = $false; value = $null; name = ''; error = $lastError }
}

function To-Bool($value) {
    if ($null -eq $value) { return $null }
    return [bool]$value
}

function Write-Result($obj) {
    $obj.errors = @($errors.ToArray())
    $json = $obj | ConvertTo-Json -Depth 6 -Compress
    [System.IO.File]::WriteAllText($OutputFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$cfg = Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8 | ConvertFrom-Json
$n = $cfg.names
$b = $cfg.bsp
$result = [ordered]@{
    ok = $false; connected = $false; bspAvailable = $false
    updateRequired = $null; legalityRequired = $null; legalityConfirmed = $false
    deferredDone = $null; version = ''; errors = @()
}

if ($cfg.binDir -and (Test-Path $cfg.binDir)) { $env:PATH = "$($cfg.binDir);$env:PATH" }

# --- Soedinenie -------------------------------------------------------------
# Otkaz soedineniya - eto ne oshibka, a otvet: poka idut monopolnye
# obrabotchiki, platforma derzhit bazu monopolno i nikogo ne puskaet.
try {
    $connector = New-Object -ComObject $cfg.progId
    $conn = Invoke-ComMethod $connector 'Connect' @($cfg.connectionString)
    $result.connected = $true
} catch {
    [void]$errors.Add("Ne udalos podklyuchitsya k baze cherez $($cfg.progId): $($_.Exception.Message)")
    Write-Result $result
    exit 1
}

try {
    $meta = Get-ComProp $conn $n.metadata
    $result.version = [string](Get-ComProp $meta $n.version)
} catch { }

# --- Moduli BSP -------------------------------------------------------------
$updateModule = Resolve-Member $conn @($b.updateModule)
$internalModule = Resolve-Member $conn @($b.internalModule)
if ($null -eq $updateModule -and $null -eq $internalModule) {
    [void]$errors.Add('Obshchie moduli obnovleniya IB nedostupny cherez vneshnee soedinenie: eto ne BSP-konfiguratsiya libo u modulya snyat flag "Vneshnee soedinenie"')
    $result.ok = $true
    Write-Result $result
    exit 0
}
$result.bspAvailable = $true

# --- Nuzhno li obnovlenie ---------------------------------------------------
if ($null -ne $updateModule) {
    $call = Invoke-Strict $updateModule.value @($b.updateRequired) @()
    if ($call.ok) { $result.updateRequired = To-Bool $call.value }
    else { [void]$errors.Add("$($b.updateRequired[0]): $($call.error)") }

    $call = Invoke-Strict $updateModule.value @($b.deferredDone) @()
    if ($call.ok) { $result.deferredDone = To-Bool $call.value }
}

# --- Zhdet li BSP podtverzhdeniya legalnosti --------------------------------
if ($null -ne $internalModule) {
    $call = Invoke-Strict $internalModule.value @($b.legalityRequired) @()
    if ($call.ok) { $result.legalityRequired = To-Bool $call.value }
    else { [void]$errors.Add("$($b.legalityRequired[0]): $($call.error)") }
}

# --- Podtverzhdenie ---------------------------------------------------------
# Pishem tolko esli BSP deystvitelno zhdet otveta, i srazu perechityvaem:
# uspehom schitaetsya ne otsutstvie oshibki, a to, chto BSP bolshe ne zhdet.
if ($cfg.confirmLegality -and $result.legalityRequired -eq $true -and $null -ne $internalModule) {
    $call = Invoke-Strict $internalModule.value @($b.confirmLegality) @()
    if (-not $call.ok) {
        [void]$errors.Add("$($b.confirmLegality[0]): $($call.error)")
    } else {
        $again = Invoke-Strict $internalModule.value @($b.legalityRequired) @()
        if ($again.ok) {
            $result.legalityRequired = To-Bool $again.value
            $result.legalityConfirmed = ($result.legalityRequired -eq $false)
        }
        if (-not $result.legalityConfirmed) {
            [void]$errors.Add('Podtverzhdenie zapisano, no BSP vse ravno trebuet proverki legalnosti')
        }
    }
}

$result.ok = $true
Write-Result $result
exit 0

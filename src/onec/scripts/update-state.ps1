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
      StatusOtlozhennogoObnovleniya()                    - kak otlozhennye

    Zdes zhe ishchetsya forma rezultatov obnovleniya: ee polnoe imya nuzhno
    do zapuska klienta, chtoby otkryt ee v TOM ZHE seanse klyuchom /URL.

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

# Spisok elementov nezavisimo ot togo, chem ego otdala platforma: gotovym
# massivom .NET ili kollektsiey 1C s Kolichestvo()/Poluchit(). U kollektsii 1C
# "Kolichestvo" - eto METOD, a ne svoystvo.
function Get-Count($obj, [string]$ruName) {
    foreach ($nm in @('Count', $ruName)) {
        if ([string]::IsNullOrWhiteSpace($nm)) { continue }
        try { $v = Invoke-ComMethod $obj $nm @(); if ($null -ne $v) { return [int]$v } } catch { }
        try { $v = Get-ComProp $obj $nm; if ($null -ne $v) { return [int]$v } } catch { }
    }
    return 0
}
function Get-Items($list, $ruGet, $ruCount) {
    if ($null -eq $list) { return @() }
    if ($list -is [System.Array]) { return $list }
    $out = New-Object System.Collections.ArrayList
    $count = Get-Count $list $ruCount
    for ($i = 0; $i -lt [int]$count; $i++) {
        foreach ($nm in @('Get', $ruGet)) {
            if ([string]::IsNullOrWhiteSpace($nm)) { continue }
            try {
                $item = Invoke-ComMethod $list $nm @([int]$i)
                if ($null -ne $item) { [void]$out.Add($item); break }
            } catch { }
        }
    }
    return $out.ToArray()
}

# Forma rezultatov obnovleniya v metadannyh bazy. Imya NE zashito: ishchem
# obrabotku po obraztsu (v BSP - RezultatyObnovleniyaProgrammy) i beryom u nee
# PolnoeImya formy - platforma otdaet ego uzhe v vide "Obrabotka.X.Forma.Y",
# rovno kak nuzhno navigatsionnoy ssylke. Sinonim raven zagolovku okna - po nemu
# Node proveryaet, chto forma otkrylas.
function Find-ResultsForm($meta, [string]$pattern, $n) {
    $group = $null
    foreach ($nm in @('DataProcessors', $n.dataProcessors)) {
        if ([string]::IsNullOrWhiteSpace($nm)) { continue }
        try { $group = Get-ComProp $meta $nm; if ($null -ne $group) { break } } catch { }
    }
    if ($null -eq $group) { return $null }

    foreach ($obj in (Get-Items $group $n.get $n.count)) {
        if ($null -eq $obj) { continue }
        $objName = ''
        foreach ($nm in @('Name', $n.name)) {
            try { $v = Get-ComProp $obj $nm; if ($null -ne $v) { $objName = [string]$v; break } } catch { }
        }
        if ($objName -notmatch $pattern) { continue }

        $forms = @()
        foreach ($nm in @('Forms', $n.forms)) {
            try { $v = Get-ComProp $obj $nm; if ($null -ne $v) { $forms = Get-Items $v $n.get $n.count; break } } catch { }
        }
        $chosen = $null
        foreach ($f in $forms) {
            if ($null -eq $f) { continue }
            $fname = ''
            foreach ($nm in @('Name', $n.name)) {
                try { $v = Get-ComProp $f $nm; if ($null -ne $v) { $fname = [string]$v; break } } catch { }
            }
            if ($fname -match $pattern) { $chosen = $f; break }
        }
        if ($null -eq $chosen -and @($forms).Count -gt 0) { $chosen = @($forms)[0] }
        if ($null -eq $chosen) { continue }

        $full = ''
        foreach ($nm in @('FullName', $n.fullName)) {
            try { $v = Invoke-ComMethod $chosen $nm @(); if ($null -ne $v) { $full = [string]$v; break } } catch { }
        }
        $title = ''
        foreach ($nm in @('Synonym', $n.synonym)) {
            try { $v = Get-ComProp $chosen $nm; if ($null -ne $v) { $title = [string]$v; break } } catch { }
        }
        if ($full -ne '') { return [ordered]@{ full = $full; title = $title } }
    }
    return $null
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
    deferredDone = $null; deferredStatus = $null; form = $null
    version = ''; errors = @()
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

$meta = $null
try {
    $meta = Get-ComProp $conn $n.metadata
    $result.version = [string](Get-ComProp $meta $n.version)
} catch { }

# --- Forma rezultatov obnovleniya -------------------------------------------
if ($cfg.formNamePattern -and $null -ne $meta) {
    try {
        $form = Find-ResultsForm $meta $cfg.formNamePattern $n
        if ($null -ne $form) { $result.form = $form }
        else { [void]$errors.Add('Forma rezultatov obnovleniya v metadannyh bazy ne naydena') }
    } catch {
        [void]$errors.Add("Poisk formy rezultatov obnovleniya: $($_.Exception.Message)")
    }
}

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

    # Status otlozhennyh obrabotchikov: pustaya stroka - vse vypolneny,
    # inache BSP nazyvaet prichinu ("StatusNeVypolneno" i t.p.).
    $call = Invoke-Strict $updateModule.value @($b.deferredStatus) @()
    if ($call.ok) { $result.deferredStatus = [string]$call.value }
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

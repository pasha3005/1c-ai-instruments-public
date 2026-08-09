<#
    collect-live.ps1 - most k COM-soedinitelyu 1C (V83.COMConnector).

    Skript namerenno napisan tolko latinicey: Windows PowerShell 5.1 chitaet .ps1
    v ANSI-kodirovke, esli u fayla net BOM, i lyuboy kirillicheskiy identifikator
    prevratilsya by v musor. Vse kirillicheskie dannye (imena obektov, teksty
    zaprosov) peredayutsya cherez UTF-8 JSON vo vhodnom fayle.

    Vhod  (JSON, UTF-8):
      {
        "binDir": "C:\\Program Files\\1cv8\\8.3.27.1989\\bin",
        "progId": "V83.COMConnector",
        "connectionString": "File=\"D:\\Base\";",
        "budgetSeconds": 900,
        "queries": [ { "id": "Catalog.Tovary", "text": "VYBRAT ..." } ]
      }

    progId vychislyaetsya vyzyvayushchey storonoy (comConnectorProgId v
    platform.js) iz vybrannoy versii platformy: V83.COMConnector dlya vetki
    8.3.x, V85.COMConnector dlya 8.5.x i t.d. Klass obshchiy na vsyu vetku
    major.minor, a ne na tochnyy nomer sborki - pri neskolkih sborkah odnoy
    vetki na mashine COM vsegda ispolzuet tu, chto zaregistrirovana SEYCHAS,
    ne obyazatelno vybrannuyu. Poetomu skript sam sveryaet, kakuyu DLL
    fakticheski zagruzil progId, s tem, chto lezhit v binDir, i vozvrashchaet
    obe v connectorDll / connectorExpectedDll - Node reshaet, stoit li
    preduprezhdat polzovatelya o raskhozhdenii.

    Vyhod (JSON, UTF-8):
      { "ok": true, "counts": [...], "tables": [...], "errors": [...] }

    Progress pishetsya v stdout strokami vida: PROGRESS|<done>|<total>|<id>
#>

param(
    [Parameter(Mandatory = $true)][string]$InputFile,
    [Parameter(Mandatory = $true)][string]$OutputFile
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# --- Helpers for late-bound COM property access -----------------------------
# PowerShell's IDispatch binder cannot resolve 1C object properties directly
# (they always come back $null). InvokeMember with explicit BindingFlags works.
$BF = [System.Reflection.BindingFlags]

function Get-ComProp($obj, [string]$name) {
    return [System.__ComObject].InvokeMember($name, $BF::GetProperty, $null, $obj, $null)
}

function Set-ComProp($obj, [string]$name, $value) {
    [void][System.__ComObject].InvokeMember($name, $BF::SetProperty, $null, $obj, @($value))
}

function Write-Result($obj) {
    $obj.errors = @($errors.ToArray())
    $json = $obj | ConvertTo-Json -Depth 8 -Compress
    [System.IO.File]::WriteAllText($OutputFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# NB: errors must be an ArrayList - a plain PowerShell array has no .Add().
$errors = New-Object System.Collections.ArrayList

$result = [ordered]@{
    ok                  = $false
    error               = $null
    counts              = @()
    tables              = @()
    errors              = @()
    durationMs          = 0
    connectorProgId     = $null
    connectorDll        = $null
    connectorExpectedDll = $null
}

# Kakuyu DLL fakticheski zagruzhaet dannyy progId - po registru, ne po PATH:
# InprocServer32 fiksiruet put k biblioteke zhostko, PATH na vybor DLL dlya
# samogo COM-klassa ne vliyaet (on vliyaet tolko na zavisimosti etoy DLL).
function Get-ComConnectorDll([string]$ProgId) {
    try {
        $clsid = (Get-ItemProperty "HKLM:\SOFTWARE\Classes\$ProgId\CLSID" -ErrorAction Stop).'(default)'
        $dll = (Get-ItemProperty "HKLM:\SOFTWARE\Classes\CLSID\$clsid\InprocServer32" -ErrorAction Stop).'(default)'
        return $dll
    }
    catch {
        return $null
    }
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

# --- Read input -------------------------------------------------------------
try {
    $raw = [System.IO.File]::ReadAllText($InputFile, [System.Text.Encoding]::UTF8)
    $cfg = $raw | ConvertFrom-Json
}
catch {
    $result.error = "Ne udalos prochitat vhodnoy fayl: $($_.Exception.Message)"
    Write-Result $result
    exit 1
}

# The COM connector loads dependent DLLs from the platform bin directory.
# Without this the Connect() call fails with TYPE_E_CANTLOADLIBRARY.
if ($cfg.binDir -and (Test-Path $cfg.binDir)) {
    $env:PATH = "$($cfg.binDir);$env:PATH"
}

$progId = if ($cfg.progId) { [string]$cfg.progId } else { 'V83.COMConnector' }
$result.connectorProgId = $progId
$result.connectorDll = Get-ComConnectorDll $progId
if ($cfg.binDir) { $result.connectorExpectedDll = Join-Path $cfg.binDir 'comcntr.dll' }

$connector = $null
$conn = $null

try {
    $connector = New-Object -ComObject $progId
}
catch {
    $result.error = "Ne udalos sozdat ${progId}: $($_.Exception.Message)"
    Write-Result $result
    exit 2
}

try {
    $conn = $connector.Connect($cfg.connectionString)
}
catch {
    $result.error = "Ne udalos podklyuchitsya k informacionnoy baze: $($_.Exception.Message)"
    Write-Result $result
    exit 3
}

# --- Physical storage structure --------------------------------------------
# Columns: DBName / Metadata / Purpose (+ Fields, Indexes value tables).
try {
    $struct = $conn.GetDBStorageStructureInfo()
    $rowCount = $struct.Count()
    $tables = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $rowCount; $i++) {
        $row = $struct.Get($i)
        $entry = [ordered]@{
            dbName   = [string]$row.Get(0)
            metadata = [string]$row.Get(1)
            purpose  = [string]$row.Get(2)
        }
        [void]$tables.Add($entry)
    }
    $result.tables = $tables.ToArray()
}
catch {
    [void]$result.errors.Add("GetDBStorageStructureInfo: $($_.Exception.Message)")
}

# --- Record counts ----------------------------------------------------------
# Schet vypolnyaetsya PAKETAMI: odin zapros s ОБЪЕДИНИТЬ ВСЕ srazu po mnogim
# obektam odnogo vida. Eto na dva poryadka bystree, chem otdelnyy zapros
# na kazhdyy obekt, i ne narushaet sobstvennoe pravilo "ne delay zaprosy v cikle".
#
# Kazhdyy paket vozvrashchaet stroki [imya_obekta, kolichestvo].
# Pustye tablicy stroku NE vozvrashchayut - takie obekty schitayutsya nulevymi
# na storone Node (on znaet polnyy spisok zaprashivaemyh obektov).
#
# Esli paket upal celikom (naprimer, odin obekt nedostupen po pravam),
# vypolnyaetsya otkat: kazhdyy obekt paketa zaprashivaetsya otdelno.

function Invoke-CountQuery {
    param($conn, [string]$text)

    $q = $conn.NewObject('Query')
    Set-ComProp $q 'Text' $text
    $vt = $q.Execute().Unload()

    $rows = New-Object System.Collections.ArrayList
    for ($r = 0; $r -lt $vt.Count(); $r++) {
        $row = $vt.Get($r)
        [void]$rows.Add(@([string]$row.Get(0), [int64]$row.Get(1)))
    }
    return $rows
}

$batches = @($cfg.batches)
$total = $batches.Count
$budget = if ($cfg.budgetSeconds) { [double]$cfg.budgetSeconds } else { 900.0 }
$counts = New-Object System.Collections.ArrayList
$done = 0
$budgetExceeded = $false

foreach ($batch in $batches) {
    $done++

    if ($sw.Elapsed.TotalSeconds -gt $budget) {
        if (-not $budgetExceeded) {
            [void]$errors.Add("Prevyshen limit vremeni sbora dannyh; ne obrabotano paketov: $($total - $done + 1)")
            $budgetExceeded = $true
        }
        break
    }

    Write-Output "PROGRESS|$done|$total|$($batch.id)"

    $qsw = [System.Diagnostics.Stopwatch]::StartNew()
    $ok = $false
    try {
        $rows = Invoke-CountQuery -conn $conn -text $batch.text
        foreach ($row in $rows) {
            [void]$counts.Add([ordered]@{ id = $row[0]; count = $row[1]; error = $null })
        }
        $ok = $true
    }
    catch {
        [void]$errors.Add("Paket '$($batch.id)': $($_.Exception.Message)")
    }
    $qsw.Stop()

    if ($ok) { continue }

    # --- Otkat: poobektno, chtoby odin problemnyy obekt ne poteryal ves paket ---
    foreach ($fallback in @($batch.fallback)) {
        if ($sw.Elapsed.TotalSeconds -gt $budget) { break }
        try {
            $rows = Invoke-CountQuery -conn $conn -text $fallback.text
            if ($rows.Count -gt 0) {
                [void]$counts.Add([ordered]@{ id = $fallback.id; count = $rows[0][1]; error = $null })
            }
            else {
                [void]$counts.Add([ordered]@{ id = $fallback.id; count = 0; error = $null })
            }
        }
        catch {
            [void]$counts.Add([ordered]@{ id = $fallback.id; count = $null; error = $_.Exception.Message })
        }
    }
}

$result.counts = $counts.ToArray()

# --- Cleanup ----------------------------------------------------------------
try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($conn) } catch { }
try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($connector) } catch { }

$sw.Stop()
$result.durationMs = [int]$sw.ElapsedMilliseconds
$result.ok = $true
Write-Result $result
exit 0

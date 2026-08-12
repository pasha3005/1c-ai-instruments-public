<#
    deferred-update.ps1 - zapusk otlozhennogo obnovleniya informatsionnoy bazy
    cherez COM-soedinitel 1C.

    Skript namerenno napisan tolko latinicey - po toy zhe prichine, chto i
    collect-live.ps1: Windows PowerShell 5.1 chitaet .ps1 v ANSI-kodirovke,
    esli u fayla net BOM, i kirillitsa v identifikatorah prevratilas by v musor.
    Vse kirillicheskie imena prihodyat iz Node v UTF-8 JSON (pole "names").

    Chto delaet:
      1. podklyuchaetsya k baze;
      2. ishchet reglamentnoe zadanie otlozhennogo obnovleniya IB (BSP);
      3. ishchet v metadannyh formu rezultatov obnovleniya i otdaet ee polnoe
         imya - iz nego Node stroit navigatsionnuyu ssylku e1cib/app/...;
      4. zapuskaet ego metod fonovym zadaniem;
      5. zhdet zaversheniya, pechataya progress;
      6. otdaet sostoyanie zadaniya i priznak "Ispolzovanie" reglamentnogo
         zadaniya: BSP gasit ego, kogda otlozhennyh obrabotchikov ne ostalos.

    Konfiguratsiyu skript NE menyaet: tolko zapusk zadaniya i chtenie sostoyaniya.

    Vhod (JSON, UTF-8):
      {
        "binDir": "...", "progId": "V85.COMConnector",
        "connectionString": "File=\"D:\\Base\";Usr=\"Admin\";",
        "jobNamePattern": "Deferred|...", "jobTitle": "...",
        "budgetSeconds": 1800, "pollSeconds": 10,
        "names": { "scheduledJobs": "...", "getJobs": "...", ... }
      }

    Vyhod (JSON, UTF-8):
      { "ok": true, "job": {...}, "background": {...}, "finished": true,
        "form": { "full": "...", "title": "..." },
        "jobNames": [...], "errors": [...] }

    Stroki v stdout:
      FORM|<polnoe imya formy>|<sinonim>   - do zapuska zadaniya
      STARTED|<uuid>                       - zadanie zapushcheno
      PROGRESS|<seconds>|<state>           - hod ozhidaniya
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

# Platforma otdaet svoi obekty i po angliyskim, i po russkim imenam, no na
# raznyh sborkah i raznyh variantah vstroennogo yazyka vedet sebya po-raznomu.
# Poetomu kazhdoe obrashchenie probuem oboimi imenami: angliyskim (zdes)
# i russkim (prishlo iz Node).
# Vazhno: cherez COM 1C otdaet ne tolko COM-obekty. Massiv (naprimer rezultat
# GetScheduledJobs) prihodit uzhe kak obychnyy Object[] .NET, i obrashchatsya
# k nemu cherez System.__ComObject nelzya - imenno na etom spisok zadaniy
# vyglyadel pustym (count = 0 pri desyatkah zadaniy). Poetomu dlya ne-COM
# obektov ispolzuem pryamoy dostup k chlenam.
function Get-Any($obj, [string[]]$names) {
    foreach ($n in $names) {
        if ([string]::IsNullOrWhiteSpace($n)) { continue }
        if ($obj -is [System.__ComObject]) {
            try { $v = Get-ComProp $obj $n; if ($null -ne $v) { return $v } } catch { }
        } else {
            try { $v = $obj.$n; if ($null -ne $v) { return $v } } catch { }
        }
    }
    return $null
}

function Invoke-Any($obj, [string[]]$names, $argsArray) {
    foreach ($n in $names) {
        if ([string]::IsNullOrWhiteSpace($n)) { continue }
        if ($obj -is [System.__ComObject]) {
            try { return Invoke-ComMethod $obj $n $argsArray } catch { }
        } else {
            try { return $obj.$n.Invoke($argsArray) } catch { }
        }
    }
    return $null
}

# Spisok elementov nezavisimo ot togo, chem ego otdala platforma: gotovym
# massivom .NET ili kollektsiey 1C s Kolichestvo()/Poluchit().
function Get-Items($list, $ruGet, $ruCount) {
    if ($null -eq $list) { return @() }
    if ($list -is [System.Array]) { return $list }
    $out = New-Object System.Collections.ArrayList
    $count = Get-Count $list $ruCount
    for ($i = 0; $i -lt [int]$count; $i++) {
        $item = Invoke-Any $list @('Get', $ruGet) @([int]$i)
        if ($null -ne $item) { [void]$out.Add($item) }
    }
    return $out.ToArray()
}

# U massiva 1C "Kolichestvo" - eto METOD, a ne svoystvo: chtenie kak svoystva
# vozvrashchaet nichego, i spisok reglamentnyh zadaniy vyglyadel pustym.
# Poymano na zhivoy proverke: zadanie "ne naydeno" pri desyatkah zadaniy v baze.
function Get-Count($obj, [string]$ruName) {
    $v = Invoke-Any $obj @('Count', $ruName) @()
    if ($null -ne $v) { return [int]$v }
    $v = Get-Any $obj @('Count', $ruName)
    if ($null -ne $v) { return [int]$v }
    return 0
}

function Write-Result($obj) {
    $obj.errors = @($errors.ToArray())
    $json = $obj | ConvertTo-Json -Depth 8 -Compress
    [System.IO.File]::WriteAllText($OutputFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$cfg = Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8 | ConvertFrom-Json
$n = $cfg.names
$result = [ordered]@{
    ok = $false; job = $null; background = $null; finished = $false
    form = $null; jobNames = @(); errors = @()
}

if ($cfg.binDir -and (Test-Path $cfg.binDir)) { $env:PATH = "$($cfg.binDir);$env:PATH" }

# --- Soedinenie -------------------------------------------------------------
try {
    $connector = New-Object -ComObject $cfg.progId
    $conn = Invoke-ComMethod $connector 'Connect' @($cfg.connectionString)
} catch {
    [void]$errors.Add("Ne udalos podklyuchitsya k baze cherez $($cfg.progId): $($_.Exception.Message)")
    Write-Result $result
    exit 1
}

# --- Poisk reglamentnogo zadaniya -------------------------------------------
# Diagnostika popadaet v rezultat namerenno: kogda spisok zadaniy okazyvaetsya
# pustym, bez nee nevozmozhno ponyat, chto imenno ne otvetilo - menedzher,
# metod ili perebor. Odin raz uzhe stoilo lishnego zahoda.
$result.diag = [ordered]@{ manager = ''; listType = ''; count = -1 }

$jobsManager = $null
foreach ($mgrName in @('ScheduledJobs', $n.scheduledJobs)) {
    if ([string]::IsNullOrWhiteSpace($mgrName)) { continue }
    try {
        $candidate = Get-ComProp $conn $mgrName
        if ($null -ne $candidate) { $jobsManager = $candidate; $result.diag.manager = $mgrName; break }
    } catch {
        [void]$errors.Add("$mgrName -> $($_.Exception.Message)")
    }
}
if ($null -eq $jobsManager) {
    [void]$errors.Add('Menedzher reglamentnyh zadaniy nedostupen cherez COM')
    Write-Result $result
    exit 1
}

function Find-Job($manager, [string]$pattern, $collected) {
    $list = Invoke-Any $manager @('GetScheduledJobs', $n.getJobs) @()
    if ($null -eq $list) {
        if ($null -ne $collected) { $result.diag.listType = 'null' }
        return $null
    }
    $items = Get-Items $list $n.get $n.count
    if ($null -ne $collected) {
        $result.diag.listType = $list.GetType().Name
        $result.diag.count = @($items).Count
    }
    foreach ($job in $items) {
        if ($null -eq $job) { continue }
        $meta = Get-Any $job @('Metadata', $n.metadata)
        if ($null -eq $meta) { continue }
        $name = Get-Any $meta @('Name', $n.name)
        if ($null -eq $name) { continue }
        if ($null -ne $collected) { [void]$collected.Add([string]$name) }
        if ([string]$name -match $pattern) {
            return [ordered]@{
                job = $job
                name = [string]$name
                methodName = [string](Get-Any $meta @('MethodName', $n.methodName))
                use = [bool](Get-Any $job @('Use', $n.use))
            }
        }
    }
    return $null
}

$names = New-Object System.Collections.ArrayList
$target = Find-Job $jobsManager $cfg.jobNamePattern $names
$result.jobNames = @($names.ToArray())

if ($null -eq $target) {
    [void]$errors.Add('Reglamentnoe zadanie otlozhennogo obnovleniya v etoy baze ne naydeno')
    Write-Result $result
    exit 1
}

$result.job = [ordered]@{
    name = $target.name; methodName = $target.methodName
    useBefore = $target.use; useAfter = $null
}

if ([string]::IsNullOrWhiteSpace($target.methodName)) {
    [void]$errors.Add("U zadaniya $($target.name) ne ukazan metod obrabotki - zapustit nechego")
    Write-Result $result
    exit 1
}

# --- Forma rezultatov obnovleniya -------------------------------------------
# Imya formy NE zashito: ono chitaetsya iz metadannyh toy zhe bazy. Polnoe imya
# (PolnoeImya) platforma otdaet uzhe v tom vide, kotoryy nuzhen navigatsionnoy
# ssylke: "Obrabotka.X.Forma.Y" - dostroit ostaetsya tolko prefiks e1cib/app/.
# Sinonim - eto zagolovok okna, po nemu Node proveryaet, chto forma otkrylas.
function Find-ResultsForm($meta, [string]$pattern) {
    $group = Get-Any $meta @('DataProcessors', $n.dataProcessors)
    if ($null -eq $group) { return $null }
    foreach ($obj in (Get-Items $group $n.get $n.count)) {
        if ($null -eq $obj) { continue }
        $objName = [string](Get-Any $obj @('Name', $n.name))
        if ($objName -notmatch $pattern) { continue }
        $forms = Get-Items (Get-Any $obj @('Forms', $n.forms)) $n.get $n.count
        $chosen = $null
        foreach ($f in $forms) {
            if ($null -eq $f) { continue }
            if ([string](Get-Any $f @('Name', $n.name)) -match $pattern) { $chosen = $f; break }
        }
        if ($null -eq $chosen -and @($forms).Count -gt 0) { $chosen = @($forms)[0] }
        if ($null -eq $chosen) { continue }
        return [ordered]@{
            full  = [string](Invoke-Any $chosen @('FullName', $n.fullName) @())
            title = [string](Get-Any $chosen @('Synonym', $n.synonym))
        }
    }
    return $null
}

if ($cfg.formNamePattern) {
    try {
        $meta = Get-Any $conn @('Metadata', $n.metadata)
        $form = Find-ResultsForm $meta $cfg.formNamePattern
        if ($null -ne $form -and -not [string]::IsNullOrWhiteSpace($form.full)) {
            $result.form = $form
            Write-Output "FORM|$($form.full)|$($form.title)"
        } else {
            [void]$errors.Add('Forma rezultatov obnovleniya v metadannyh bazy ne naydena')
        }
    } catch {
        [void]$errors.Add("Poisk formy rezultatov obnovleniya: $($_.Exception.Message)")
    }
}

# --- Zapusk fonovym zadaniem ------------------------------------------------
$backgroundManager = Get-Any $conn @('BackgroundJobs', $n.backgroundJobs)
if ($null -eq $backgroundManager) {
    [void]$errors.Add('Menedzher fonovyh zadaniy nedostupen cherez COM')
    Write-Result $result
    exit 1
}

$background = Invoke-Any $backgroundManager @('Execute', $n.execute) @($target.methodName, $null, 'ai-deferred-update', $cfg.jobTitle)
if ($null -eq $background) {
    [void]$errors.Add("Fonovoe zadanie po metodu $($target.methodName) ne zapustilos")
    Write-Result $result
    exit 1
}

# Zadanie zapushcheno - Node po etoy stroke srazu otkryvaet formu rezultatov
# obnovleniya, chtoby chelovek videl hod otlozhennyh obrabotchikov s nachala.
$uuid = Get-Any $background @('UUID', $n.uuid)
Write-Output "STARTED|$uuid"

# --- Ozhidanie --------------------------------------------------------------
$deadline = (Get-Date).AddSeconds([int]$cfg.budgetSeconds)
$poll = [int]$cfg.pollSeconds
if ($poll -lt 2) { $poll = 5 }
$startedAt = Get-Date
$state = ''

# Sostoyanie zadaniya - perechislenie, i cherez COM ego strokovoe predstavlenie
# ravno "System.__ComObject": sravnivat s nim nechego. Poymano na zhivoy proverke -
# ozhidanie obryvalos na pervoy zhe proverke. Poetomu zavershennost opredelyaem
# po date OKONCHANIYA zadaniya: poka zadanie rabotaet, ona pustaya. A chitaemoe
# nazvanie sostoyaniya beryom u samoy platformy - funktsiey String().
function Read-State($conn, $job) {
    $value = Get-Any $job @('State', $n.state)
    if ($null -eq $value) { return '' }
    $text = Invoke-Any $conn @('String', $n.stringFn) @($value)
    if ($null -ne $text -and "$text" -ne 'System.__ComObject') { return [string]$text }
    return ''
}

$stillRunning = $true
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $poll
    $fresh = $null
    if ($null -ne $uuid) { $fresh = Invoke-Any $backgroundManager @('FindByUUID', $n.findByUuid) @($uuid) }
    if ($null -eq $fresh) { $fresh = $background }
    $background = $fresh

    $state = Read-State $conn $fresh
    $ended = Get-Any $fresh @('End', $n.end)
    Write-Output "PROGRESS|$([int]((Get-Date) - $startedAt).TotalSeconds)|$state"

    # Data okonchaniya zapolnena - zadanie otrabotalo, nezavisimo ot yazyka
    # i ot togo, chem imenno zakonchilos.
    if ($null -ne $ended -and "$ended" -ne '' -and "$ended" -notmatch '^0*1\.01\.0*1') {
        $stillRunning = $false
        break
    }
}

$errorText = ''
try {
    $info = Get-Any $background @('ErrorInfo', $n.errorInfo)
    if ($null -ne $info) {
        $desc = Get-Any $info @('Description', $n.description)
        if ($null -ne $desc) { $errorText = [string]$desc }
    }
} catch { }
$result.background = [ordered]@{
    state = $state
    error = $errorText
    ended = "$(Get-Any $background @('End', $n.end))"
    # Zadanie moglo ne uspet za otvedennoe vremya. Vydavat eto za zavershenie
    # nelzya: pri pervoy zhe proverke na zhivoy baze zadanie rabotalo 8 minut
    # i ne zakonchilos, a rezultat govoril "vypolneno".
    stillRunning = $stillRunning
}

# --- Sostoyanie posle: BSP gasit zadanie, kogda obrabotchikov ne ostalos ----
$after = Find-Job $jobsManager $cfg.jobNamePattern $null
if ($null -ne $after) { $result.job.useAfter = $after.use }

$result.ok = $true
# Zaversheno tolko esli: zadanie deystvitelno okonchilos, bez oshibki, i BSP
# pogasil reglamentnoe zadanie - znachit neobrabotannyh obrabotchikov net.
$result.finished = (-not $stillRunning) -and ($errorText -eq '') -and ($result.job.useAfter -eq $false)
Write-Result $result
exit 0

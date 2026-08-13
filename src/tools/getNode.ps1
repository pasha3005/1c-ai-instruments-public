<#
    getNode.ps1 — переносной Node.js рядом с программой.

    Зачем этот файл на PowerShell, а не на JavaScript, как всё остальное.
    Он решает задачу «курицы и яйца»: интерпретатора ещё нет, и выполнить
    им ничего нельзя. PowerShell же есть в любой Windows начиная с 7 —
    это единственное, на что можно опереться до появления node.exe.

    Что делает: находит последний LTS-выпуск Node.js, спрашивает согласие,
    скачивает официальный переносной архив и достаёт из него один node.exe
    в runtime\ рядом с программой. В систему ничего не ставится: ни PATH,
    ни реестр, ни ярлыки — каталог можно просто удалить.

    Прокси и TLS настраиваются явно. На сервере заказчика выход в интернет
    почти всегда через прокси из настроек системы, а в PowerShell 5.1 бывает
    выключен TLS 1.2 — без него nodejs.org просто обрывает соединение.

    Коды возврата: 0 — node.exe на месте, 1 — не получилось (текст причины
    уже напечатан).
#>

[CmdletBinding()]
param(
    # Куда положить node.exe (каталог runtime рядом с программой).
    [Parameter(Mandatory = $true)][string] $RuntimeDir,
    # Не спрашивать согласия — для установки без участия человека.
    [switch] $Yes
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Line([string] $Text) { Write-Host "  $Text" }

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch { }
try {
    [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials
} catch { }

Write-Host ''
Write-Line 'Node.js на этом компьютере не найден.'
Write-Line 'Он нужен программе как интерпретатор — сама она написана на нём.'
Write-Line ''
Write-Line 'Можно скачать переносной Node.js и положить рядом с программой,'
Write-Line 'в папку runtime\. В систему он не устанавливается: ни в PATH,'
Write-Line 'ни в реестр, ни ярлыков — чтобы убрать, достаточно удалить папку.'
Write-Line ''
Write-Line 'Размер загрузки — около 36 МБ, на диске займёт около 120 МБ.'
Write-Line 'Источник: официальные сборки nodejs.org (OpenJS Foundation).'
Write-Host ''

if (-not $Yes) {
    $answer = Read-Host '  Скачать Node.js сейчас? [д/н]'
    $answer = $answer.Trim().ToLower()
    if ($answer -ne 'д' -and $answer -ne 'да' -and $answer -ne 'y' -and $answer -ne 'yes') {
        Write-Host ''
        Write-Line 'Хорошо, не скачиваем. Без Node.js программа не запустится.'
        Write-Line 'Другой путь: установить Node.js 20 или новее с nodejs.org'
        Write-Line 'либо положить node.exe в папку runtime\ вручную.'
        Write-Host ''
        exit 1
    }
}

try {
    Write-Host ''
    Write-Line 'Узнаём последний LTS-выпуск…'

    # Берём именно LTS: у него длинный срок поддержки, а нам нужен
    # предсказуемый интерпретатор, а не самый свежий.
    $releases = (Invoke-WebRequest -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing).Content | ConvertFrom-Json
    $release = $releases | Where-Object { $_.lts -and ($_.files -contains 'win-x64-zip') } | Select-Object -First 1
    if (-not $release) { throw 'на nodejs.org не нашлось подходящего выпуска' }

    $version = $release.version
    Write-Line "Последний LTS: $version"

    if (-not (Test-Path $RuntimeDir)) { New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null }

    $name = "node-$version-win-x64"
    $url = "https://nodejs.org/dist/$version/$name.zip"
    $zip = Join-Path $RuntimeDir "$name.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }

    Write-Line 'Скачиваем… (окно закрывать нельзя)'
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

    $size = (Get-Item $zip).Length
    if ($size -lt 10MB) { throw "скачано всего $([math]::Round($size/1MB)) МБ — это не архив Node.js" }
    Write-Line "Скачано: $([math]::Round($size/1MB)) МБ. Распаковываем…"

    $unpacked = Join-Path $RuntimeDir '_node_tmp'
    if (Test-Path $unpacked) { Remove-Item $unpacked -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $unpacked -Force

    # Из архива нужен ровно один файл. Всё остальное там — npm, заголовки
    # для сборки модулей и документация; программе они не нужны, а место
    # занимают втрое больше самого интерпретатора.
    $exe = Get-ChildItem -Path $unpacked -Filter 'node.exe' -Recurse | Select-Object -First 1
    if (-not $exe) { throw 'в архиве не нашёлся node.exe' }

    Copy-Item $exe.FullName (Join-Path $RuntimeDir 'node.exe') -Force
    Remove-Item $unpacked -Recurse -Force
    Remove-Item $zip -Force

    $final = Join-Path $RuntimeDir 'node.exe'
    if (-not (Test-Path $final)) { throw 'node.exe не оказался на месте после распаковки' }

    Write-Host ''
    Write-Line "Готово: $final"
    Write-Host ''
    exit 0
}
catch {
    Write-Host ''
    Write-Line "[ОШИБКА] Не удалось скачать Node.js: $($_.Exception.Message)"
    Write-Host ''
    Write-Line 'Скорее всего, закрыт выход в интернет или мешает прокси.'
    Write-Line 'Тогда скачайте архив на любом другом компьютере:'
    Write-Line '  https://nodejs.org/dist/latest-v24.x/node-v24.x.x-win-x64.zip'
    Write-Line 'достаньте из него node.exe и положите в папку:'
    Write-Line "  $RuntimeDir"
    Write-Line 'Либо просто установите Node.js 20 или новее с nodejs.org.'
    Write-Host ''
    exit 1
}

<#
    download.ps1 — скачать файл на машине заказчика.

    Отдельным файлом, потому что качать приходится дважды (интерпретатор
    и браузер) и в обоих случаях по чужим правилам: сервер в домене,
    выход в интернет через прокси из настроек системы, PowerShell 5.1,
    иногда с ограничениями политик.

    Способов три, по очереди — каждый следующий пробуется, если предыдущий
    не смог:

      1. Start-BitsTransfer. Служба передачи Windows: пишет прямо на диск,
         память не ест, знает системный прокси, переживает обрыв связи.
         Лучший вариант, но служба BITS бывает выключена политикой.
      2. WebClient.DownloadFile. Тоже потоком на диск и тоже через системный
         прокси. Недоступен, если PowerShell работает в ограниченном режиме
         языка (бывает под AppLocker/WDAC): создавать объекты .NET там нельзя.
      3. Invoke-WebRequest -OutFile. Работает почти всегда, но в PowerShell 5.1
         держит ответ в памяти целиком — на 340 МБ браузера это сотни мегабайт
         в сеансе терминального сервера. Поэтому он последний, а не первый.

    Возвращает 0, если файл скачан. Иначе печатает причину и возвращает 1.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Url,
    [Parameter(Mandatory = $true)][string] $OutFile
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Line([string] $Text) { Write-Host "  $Text" }

# TLS 1.2 в PowerShell 5.1 включён не всегда, а без него и nodejs.org,
# и storage.googleapis.com просто обрывают соединение. Прокси берём
# системный, вместе с проверкой подлинности текущим пользователем домена.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch { }
try {
    [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials
} catch { }

if (Test-Path $OutFile) { Remove-Item $OutFile -Force -ErrorAction SilentlyContinue }

$reasons = @()

# --- 1. BITS ----------------------------------------------------------------
try {
    if (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
        Start-BitsTransfer -Source $Url -Destination $OutFile -ErrorAction Stop
        if (Test-Path $OutFile) { Write-Line 'Способ: служба передачи Windows (BITS)'; exit 0 }
    } else {
        $reasons += 'BITS: команда Start-BitsTransfer недоступна'
    }
} catch {
    $reasons += "BITS: $($_.Exception.Message)"
}

# --- 2. WebClient -----------------------------------------------------------
try {
    $client = New-Object System.Net.WebClient
    $client.Proxy = [Net.WebRequest]::DefaultWebProxy
    try {
        $client.Proxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials
    } catch { }
    $client.DownloadFile($Url, $OutFile)
    $client.Dispose()
    if (Test-Path $OutFile) { Write-Line 'Способ: прямая загрузка (WebClient)'; exit 0 }
} catch {
    $reasons += "WebClient: $($_.Exception.Message)"
}

# --- 3. Invoke-WebRequest ---------------------------------------------------
try {
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    if (Test-Path $OutFile) { Write-Line 'Способ: Invoke-WebRequest'; exit 0 }
} catch {
    $reasons += "Invoke-WebRequest: $($_.Exception.Message)"
}

Write-Host ''
Write-Line 'Скачать не удалось. Что ответили способы загрузки:'
foreach ($reason in $reasons) { Write-Line "  * $reason" }
Write-Host ''
Write-Line 'Чаще всего это значит одно из двух: на этой машине нет выхода'
Write-Line 'в интернет, либо он идёт через прокси, который просит пароль.'
exit 1

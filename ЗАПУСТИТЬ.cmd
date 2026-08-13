@echo off
setlocal enabledelayedexpansion

REM ---------------------------------------------------------------------------
REM  Zapusk prilozheniya "AI-audit bazy 1S".
REM
REM  VNIMANIE: tekst v etom fayle namerenno tolko latinicey.
REM  cmd.exe razbiraet .cmd v tekushchey kodovoy stranice konsoli JESHCHO DO
REM  vypolneniya chcp, poetomu kirillica v echo prevrashchaetsya v krakozyabry.
REM  Vse soobshcheniya na russkom vyvodit uzhe samo prilozhenie (Node.js).
REM
REM  Okno konsoli ne ostayotsya viset: server zapuskaetsya otdelnym protsessom,
REM  a eto okno zakryvaetsya, kak tolko prilozhenie otvetit na proverku.
REM ---------------------------------------------------------------------------

title AI-audit bazy 1S

cd /d "%~dp0"

echo.
echo   ============================================
echo     AI-audit bazy 1S
echo   ============================================
echo.

REM --- Shag 1: poisk Node.js -------------------------------------------------
echo   [1/4] Poisk Node.js...

set "NODE_EXE="

if exist "%~dp0runtime\node.exe" (
    set "NODE_EXE=%~dp0runtime\node.exe"
    goto :found
)

where node >nul 2>&1
if %errorlevel% equ 0 (
    for /f "delims=" %%i in ('where node') do (
        set "NODE_EXE=%%i"
        goto :found
    )
)

echo.
echo   [OSHIBKA] Node.js ne nayden.
echo.
echo   Varianty resheniya:
echo     1. Polozhite portativnyy Node.js v papku runtime\ ryadom s etim faylom
echo        (nuzhen tolko node.exe, nodejs.org - "Windows Binary .zip").
echo     2. Libo ustanovite Node.js LTS s https://nodejs.org
echo.
echo   Windows Server 2012 / 2012 R2: Node.js 18+ na nih ne zapuskaetsya,
echo   i obhoda net. Zapuskayte programmu na rabochey stancii Windows 10/11 -
echo   servernaya baza ukazyvaetsya po seti (srv-1c:1541\Base). Podrobnee -
echo   razdel "Windows Server 2012 ne podderzhivaetsya" v README.md.
echo.
pause
exit /b 1

:found
for /f "tokens=1 delims=." %%v in ('"!NODE_EXE!" --version') do set "NODE_MAJOR=%%v"
set "NODE_MAJOR=!NODE_MAJOR:v=!"
if !NODE_MAJOR! LSS 20 (
    echo.
    echo   [OSHIBKA] Nuzhen Node.js 20 ili novee. Ustanovlena versiya: !NODE_MAJOR!
    echo.
    echo   Esli eto Windows Server 2012 / 2012 R2 - novee Node.js tam ne rabotaet
    echo   voobshche. Zapuskayte programmu na rabochey stancii Windows 10/11,
    echo   baza ukazyvaetsya po seti. Podrobnee - v README.md.
    echo.
    pause
    exit /b 1
)
echo         Node.js !NODE_MAJOR!.x nayden.

REM --- Proverka brauzera -----------------------------------------------------
REM  Interfeys - eto stranica v brauzere, i emu nuzhen sovremennyy dvizhok:
REM  moduli JS, fetch, peremennye CSS. Internet Explorer nichego etogo ne umeet.
REM
REM  Proverka i vopros pro zagruzku Chromium zhivut imenno zdes, a ne v samoy
REM  programme: server zapuskaetsya skrytym oknom (Start-Process -WindowStyle
REM  Hidden), sprosit ottuda nechego i otvetit nekuda. Vidimoe okno odno - eto.
echo   [2/4] Proverka brauzera...
"!NODE_EXE!" "%~dp0src\tools\ensureBrowser.mjs"

REM --- Shag 3: zapusk servera otdelnym protsessom ----------------------------
REM  Start-Process -WindowStyle Hidden otvyazyvaet server ot etoy konsoli.
REM  "start /b" ne podoshel: takoy protsess ostayotsya privyazan k oknu konsoli
REM  i mozhet byt snyat vmeste s nim. Zhurnal servera pishetsya v data\logs.
echo   [3/4] Zapusk servera...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process -FilePath '!NODE_EXE!' -ArgumentList '\"%~dp0src\main.js\"' -WindowStyle Hidden"

REM --- Shag 4: zhdyom gotovnosti i zakryvaem okno -----------------------------
echo   [4/4] Ozhidanie gotovnosti prilozheniya...

"!NODE_EXE!" "%~dp0src\tools\waitReady.mjs"
if !errorlevel! neq 0 (
    echo.
    echo   [OSHIBKA] Server ne otvetil za otvedennoe vremya.
    echo   Podrobnosti - v data\logs\
    echo.
    pause
    exit /b 1
)

echo         Gotovo. Prilozhenie otkryvaetsya v otdelnom okne.
exit /b 0

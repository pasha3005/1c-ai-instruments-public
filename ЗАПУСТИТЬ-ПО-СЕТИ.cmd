@echo off
setlocal enabledelayedexpansion

REM ---------------------------------------------------------------------------
REM  Zapusk dlya raboty s DRUGOGO kompyutera.
REM
REM  Zachem. Na servere zakazchika brauzerom byvaet tolko Internet Explorer,
REM  a interfeys programmy emu ne po zubam. Togda programma rabotaet zdes,
REM  ryadom s bazoy i platformoy 1S, a smotryat na neyo s rabochey stancii -
REM  v obychnom Edge ili Chrome.
REM
REM  Otlichie ot ZAPUSTIT.cmd odno: server slushaet ne tolko 127.0.0.1,
REM  no i set. Poetomu okno brauzera zdes ne otkryvaetsya - vmesto nego
REM  pechataetsya adres, kotoryy nado otkryt na drugom kompyutere.
REM
REM  VNIMANIE: tekst v etom fayle namerenno tolko latinicey - cmd.exe razbiraet
REM  .cmd v tekushchey kodovoy stranice JESHCHO DO vypolneniya chcp.
REM ---------------------------------------------------------------------------

title AI-audit bazy 1S (setevoy rezhim)

cd /d "%~dp0"

echo.
echo   ============================================
echo     AI-audit bazy 1S - setevoy rezhim
echo   ============================================
echo.

REM --- Shag 1: poisk Node.js -------------------------------------------------
echo   [1/2] Poisk Node.js...

set "NODE_EXE="

if exist "%~dp0runtime\node.exe" (
    set "NODE_EXE=%~dp0runtime\node.exe"
) else (
    where node.exe >nul 2>nul
    if !errorlevel! equ 0 (
        for /f "delims=" %%i in ('where node.exe') do (
            if not defined NODE_EXE set "NODE_EXE=%%i"
        )
    )
)

if not defined NODE_EXE (
    echo.
    echo   [OSHIBKA] Node.js ne nayden. Podrobnee - v ZAPUSTIT.cmd i README.md.
    echo.
    pause
    exit /b 1
)

for /f "tokens=1 delims=." %%v in ('"!NODE_EXE!" --version') do set "NODE_MAJOR=%%v"
set "NODE_MAJOR=!NODE_MAJOR:v=!"
if !NODE_MAJOR! LSS 20 (
    echo.
    echo   [OSHIBKA] Nuzhen Node.js 20 ili novee. Ustanovlena versiya: !NODE_MAJOR!
    echo.
    pause
    exit /b 1
)
echo         Node.js !NODE_MAJOR!.x nayden.

REM --- Shag 2: zapusk servera v etom zhe okne --------------------------------
REM  Imenno v etom okne, a ne skrytym protsessom: adres dlya podklyucheniya
REM  pechataet sama programma, i uvidet ego nado zdes. Okno ostayotsya otkrytym
REM  na vsyo vremya raboty - eto i est priznak togo, chto programma zhivyot.
echo   [2/2] Zapusk servera...
echo.
echo   Server budet dostupen po seti. Zakryvat eto okno nelzya:
echo   ono i est rabotayushchaya programma. Ostanovka - Ctrl+C.
echo.
echo   Nizhe programma napechataet adresa vida http://10.0.0.15:7345 -
echo   lyuboy iz nih i nado otkryt v brauzere na rabochey stancii.
echo.

set "ONEC_AUDIT_HOST=0.0.0.0"
set "ONEC_AUDIT_NO_BROWSER=1"

"!NODE_EXE!" "%~dp0src\main.js"

echo.
echo   Programma ostanovlena.
pause

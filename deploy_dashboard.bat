@echo off
REM ==========================================================================
REM  pubblica_dashboard.bat
REM  Rende PUBBLICABILE la dashboard Angular di Leuven 15-min.
REM  1) Ricompila il progetto Angular (ng build --configuration production)
REM  2) Impacchetta la build in C:\leuven_15_min\dashboard\pubblicabile\
REM     con la struttura a cartelle:  html/  js/  css/  assets/  media/
REM ==========================================================================

setlocal
cd /d "%~dp0"

echo.
echo === [1/2] Compilo la dashboard Angular (ng build production)...
echo.
python "%~dp0config\_ng_build.py"
if errorlevel 1 (
    echo.
    echo ERRORE durante la ng build. Interrompo.
    goto :FINE
)

echo.
echo === [2/2] Impacchetto la build in pubblicabile\ (html/ js/ css/ assets/ media/)...
echo.
python "%~dp0config\_build_pubblicabile.py"
if errorlevel 1 (
    echo.
    echo ERRORE durante l'impacchettamento. Interrompo.
    goto :FINE
)

echo.
echo === FATTO. Dashboard pubblicabile pronta in:
echo     %~dp0pubblicabile
echo.

:FINE
endlocal
pause

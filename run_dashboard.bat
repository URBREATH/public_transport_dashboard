@echo off
REM ==========================================================================
REM  avvia_dashboard_angular.bat
REM  Avvia la dashboard Angular in modalita' SVILUPPO (ng serve),
REM  quella vera Angular, NON la versione pubblicabile.
REM  Apre il browser su http://localhost:4200
REM ==========================================================================

setlocal
cd /d "%~dp0frontend"

echo.
echo === Avvio la dashboard Angular (ng serve) su http://localhost:4200 ...
echo === Lascia questa finestra aperta. Chiudila (o CTRL+C) per fermare il server.
echo.

REM apre il browser dopo qualche secondo, mentre il server si avvia
start "" /b cmd /c "timeout /t 8 /nobreak >nul & start http://localhost:4200"

REM su Windows ng sta in node_modules\.bin\ng.cmd
if exist "node_modules\.bin\ng.cmd" (
    call "node_modules\.bin\ng.cmd" serve --open=false
) else (
    call npx ng serve --open=false
)

endlocal
pause

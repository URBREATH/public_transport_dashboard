@echo off
REM ==========================================================================
REM  avvia_pubblicabile.bat
REM  Avvia la dashboard nella versione PUBBLICABILE (cartella pubblicabile\),
REM  servendo i file statici via web server locale e aprendo il browser su
REM  http://127.0.0.1:8777/html/index.html
REM ==========================================================================

setlocal
cd /d "%~dp0"

if not exist "%~dp0pubblicabile\html\index.html" (
    echo.
    echo ERRORE: cartella pubblicabile non trovata o incompleta.
    echo Esegui prima pubblica_dashboard.bat per generarla.
    echo.
    goto :FINE
)

echo.
echo === Avvio la dashboard PUBBLICABILE su http://127.0.0.1:8777/html/index.html
echo === Lascia questa finestra aperta. Il server si arresta da solo dopo qualche minuto.
echo.

python "%~dp0config\_serve_open.py"

:FINE
endlocal
pause

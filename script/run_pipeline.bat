@echo off
REM ============================================================================
REM  run_pipeline.bat - Pipeline completa Leuven 15-min (step 01..08 + heatmap)
REM  Crea/usa un venv locale, installa le dipendenze e lancia l'orchestratore.
REM ============================================================================
setlocal
cd /d "%~dp0"

set VENV=.venv
set PY=%VENV%\Scripts\python.exe

echo.
echo === [1/3] Preparazione ambiente virtuale (%VENV%) ===
if not exist "%PY%" (
    echo    Creo il virtualenv...
    python -m venv "%VENV%"
    if errorlevel 1 (
        echo [ERRORE] Impossibile creare il venv. Verifica che Python sia nel PATH.
        pause
        exit /b 1
    )
)

echo.
echo === [2/3] Installazione dipendenze (requirements.txt) ===
"%PY%" -m pip install --upgrade pip
"%PY%" -m pip install -r requirements.txt
if errorlevel 1 (
    echo [ERRORE] Installazione dipendenze fallita.
    pause
    exit /b 1
)

echo.
echo === [3/3] Esecuzione pipeline (script\run_pipeline.py) ===
"%PY%" script\run_pipeline.py %*
set RC=%errorlevel%

echo.
if "%RC%"=="0" (
    echo === PIPELINE COMPLETATA CON SUCCESSO ===
) else (
    echo === PIPELINE TERMINATA CON ERRORI ^(codice %RC%^) ===
)
pause
exit /b %RC%

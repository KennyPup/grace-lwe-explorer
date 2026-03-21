@echo off
title GRACE-TC-Geology Explorer
color 0B
echo.
echo  ================================================================
echo   GRACE-TC-Geology Explorer - Starting up...
echo  ================================================================
echo.

:: Check Node.js is installed
where node >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo  ERROR: Node.js is not installed!
    echo.
    echo  Please download and install Node.js from:
    echo  https://nodejs.org  ^(click the LTS button^)
    echo.
    echo  After installing, run this script again.
    pause
    exit /b 1
)

:: Install dependencies if node_modules is missing
if not exist "%~dp0node_modules" (
    echo  Installing dependencies ^(first run only - takes a minute^)...
    cd /d "%~dp0"
    call npm install --silent
    if %errorlevel% neq 0 (
        color 0C
        echo  ERROR: npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
    echo  Dependencies installed OK.
    echo.
)

:: Check if dist/index.cjs exists; if not, build it
if not exist "%~dp0dist\index.cjs" (
    echo  Building app ^(first run only - takes about 30 seconds^)...
    cd /d "%~dp0"
    call npm run build
    if %errorlevel% neq 0 (
        color 0C
        echo  ERROR: Build failed.
        pause
        exit /b 1
    )
    echo  Build complete.
    echo.
)

:: Start the server in the background
echo  Starting server on http://localhost:5000 ...
cd /d "%~dp0"
start /min "GRACE Server" cmd /c "set NODE_ENV=production && node dist\index.cjs"

:: Wait for server to be ready
timeout /t 3 /nobreak >nul

:: Open the browser
echo  Opening in your browser...
start "" "http://localhost:5000"

echo.
echo  ================================================================
echo   App is running at:  http://localhost:5000
echo.
echo   Keep this window open while you use the app.
echo   Close this window to stop the server.
echo  ================================================================
echo.

:: Keep window open so the server stays running
pause

:: Shut down server when user closes the window
taskkill /fi "windowtitle eq GRACE Server" /f >nul 2>&1

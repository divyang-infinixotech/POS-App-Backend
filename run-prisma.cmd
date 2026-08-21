@echo off
cd /d "%~dp0"
npx.cmd prisma %* > prisma-output.txt 2>&1
echo Exit code: %ERRORLEVEL% >> prisma-output.txt

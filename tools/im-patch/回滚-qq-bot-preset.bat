@echo off
REM Roll back the local "qq-bot" agent preset (2026-10-24) if DSH fails to start.
REM 1) restores the profile patch file backup  2) removes the restrict plugin
setlocal
set PROFILE=%USERPROFILE%\.dsh\profiles\desktop
if exist "%PROFILE%\cordis.patch.yml.bak-before-qq-bot-preset-20261024" (
  copy /Y "%PROFILE%\cordis.patch.yml.bak-before-qq-bot-preset-20261024" "%PROFILE%\cordis.patch.yml"
  echo restored cordis.patch.yml
) else (
  echo backup not found: %PROFILE%\cordis.patch.yml.bak-before-qq-bot-preset-20261024
)
if exist "%PROFILE%\qq-bot-restrict.mjs" del /Q "%PROFILE%\qq-bot-restrict.mjs"
echo removed qq-bot-restrict.mjs
echo Done. Restart DSH.
pause

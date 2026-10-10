@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ============================================================================================================
rem  build+deploy.bat  -  Ratespass: Repo klonen, Docker-Image bauen, in die Tailscale-Registry pushen und
rem                       auf dem Server aktualisieren.
rem
rem  Ablauf
rem    1. Repo holen: Liegt diese Datei NICHT in einem Git-Repo, wird das Repo (REPO_URL) nach WORKDIR geklont
rem       (bzw. dort aktualisiert) und diese Datei wird aus dem Klon erneut gestartet - der Klon enthaelt sie ja
rem       selbst, so gilt immer die neueste Fassung. Liegt sie im Repo, wird dieses Repo verwendet.
rem    2. Pruefen: git, docker, ssh, scp, Tailscale-Verbindung.
rem    3. Bauen:   docker build  (oder buildx bei PLATFORM)   ->  REGISTRY/IMAGE_NAME:<datum>-<commit> und :latest
rem    4. Pushen:  in die Registry im Tailnet.
rem    5. Server:  docker-compose.registry.yml per scp nach REMOTE_DIR, dann per ssh "docker compose pull + up -d"
rem                und Gesundheitspruefung. Die .env auf dem Server (ADMIN_TOKEN usw.) wird nie ueberschrieben.
rem
rem  Einstellungen: unten Standardwerte; ueberschreiben per Umgebungsvariable oder in deploy.local.bat
rem  (Vorlage deploy.local.bat.example, wird nicht eingecheckt). Geheimnisse gehoeren NICHT in diese Datei.
rem
rem  Aufruf:  build+deploy.bat [--build-only] [--no-deploy] [--branch NAME] [--tag NAME] [--no-pull]
rem
rem  Hinweise zur Tailscale-Registry
rem    * Sie ist im Tailnet per MagicDNS erreichbar (z. B. registry.dein-tailnet.ts.net:5000). Dieser Rechner und
rem      der Server muessen im selben Tailnet angemeldet sein (Tailscale-App).
rem    * Laeuft die Registry ohne TLS (http), muss sie auf BEIDEN Seiten als "insecure-registry" eingetragen sein:
rem      Docker Desktop > Settings > Docker Engine:  "insecure-registries": ["registry.dein-tailnet.ts.net:5000"]
rem      und auf dem Server in /etc/docker/daemon.json (danach: sudo systemctl restart docker).
rem      Alternativ HTTPS ueber "tailscale serve" / "tailscale cert" - dann ist nichts einzutragen.
rem    * SSH zum Server geht mit normalem SSH-Schluessel oder mit Tailscale SSH (SSH_TARGET z. B. user@server).
rem    * PLATFORM (z. B. linux/arm64 fuer einen Raspberry Pi) nutzt buildx; bei einer HTTP-Registry braucht buildx eine
rem      eigene BuildKit-Konfiguration - dann PLATFORM weglassen und die Architektur des Servers beim Bauen beachten.
rem ============================================================================================================

rem ---- Einstellungen aus deploy.local.bat laden (neben dieser Datei) --------------------------------------------
if exist "%~dp0deploy.local.bat" call "%~dp0deploy.local.bat"

rem ---- Standardwerte (nur setzen, wenn noch nicht vorhanden) ----------------------------------------------------
if not defined REPO_URL     set "REPO_URL=https://github.com/qwertz098/ratespass.git"
if not defined BRANCH       set "BRANCH="
if not defined WORKDIR      set "WORKDIR=%USERPROFILE%\ratespass-build"
if not defined REGISTRY     set "REGISTRY=registry.dein-tailnet.ts.net:5000"
if not defined IMAGE_NAME   set "IMAGE_NAME=ratespass"
if not defined PLATFORM     set "PLATFORM="
if not defined SSH_TARGET   set "SSH_TARGET=deploy@server.dein-tailnet.ts.net"
if not defined SSH_OPTS     set "SSH_OPTS=-o BatchMode=yes -o ConnectTimeout=15"
if not defined REMOTE_DIR   set "REMOTE_DIR=/opt/ratespass"
if not defined HOST_PORT    set "HOST_PORT=3007"
if not defined SKIP_TS_CHECK set "SKIP_TS_CHECK=0"

rem ---- Argumente --------------------------------------------------------------------------------------------------
set "BUILD_ONLY=0"
set "NO_DEPLOY=0"
set "NO_PULL=0"
set "TAG_OVERRIDE="
set "FROM_CLONE=0"
:args
if "%~1"=="" goto :args_done
if /I "%~1"=="--build-only" set "BUILD_ONLY=1"
if /I "%~1"=="--no-deploy"  set "NO_DEPLOY=1"
if /I "%~1"=="--no-pull"    set "NO_PULL=1"
if /I "%~1"=="--from-clone" set "FROM_CLONE=1"
if /I "%~1"=="--branch"     (set "BRANCH=%~2" & shift)
if /I "%~1"=="--tag"        (set "TAG_OVERRIDE=%~2" & shift)
shift
goto :args
:args_done

echo.
echo === Ratespass build+deploy ============================================
echo  Registry : %REGISTRY%
echo  Image    : %IMAGE_NAME%
echo  Server   : %SSH_TARGET%  (%REMOTE_DIR%)
echo ========================================================================

rem ---- Werkzeuge pruefen -------------------------------------------------------------------------------------------
call :need git    "Git fuer Windows installieren: https://git-scm.com/download/win" || goto :fail
call :need docker "Docker Desktop installieren und starten: https://www.docker.com/products/docker-desktop" || goto :fail
if "%BUILD_ONLY%%NO_DEPLOY%"=="00" (
  call :need ssh "OpenSSH-Client aktivieren (Windows: Einstellungen > Optionale Features > OpenSSH-Client)" || goto :fail
  call :need scp "OpenSSH-Client aktivieren (enthaelt scp)" || goto :fail
)
docker info >nul 2>&1
if errorlevel 1 ( echo [FEHLER] Docker laeuft nicht - bitte Docker Desktop starten. & goto :fail )

rem ---- Repo bestimmen: im Repo ausfuehren oder klonen -----------------------------------------------------------
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
if exist "%HERE%\.git" (
  set "REPO=%HERE%"
  echo [1/5] Verwende vorhandenes Repo: !REPO!
  if "%NO_PULL%"=="0" call :pull "!REPO!"
  goto :have_repo
)

echo [1/5] Kein Git-Repo neben dieser Datei - klone %REPO_URL% nach "%WORKDIR%" ...
if exist "%WORKDIR%\.git" (
  call :pull "%WORKDIR%"
) else (
  if defined BRANCH ( git clone --branch "%BRANCH%" "%REPO_URL%" "%WORKDIR%" ) else ( git clone "%REPO_URL%" "%WORKDIR%" )
  if errorlevel 1 ( echo [FEHLER] git clone fehlgeschlagen. & goto :fail )
)
if not exist "%WORKDIR%\build+deploy.bat" ( echo [FEHLER] build+deploy.bat fehlt im Klon - falscher Branch? & goto :fail )
if "%FROM_CLONE%"=="0" (
  echo      Starte die Fassung aus dem Klon: %WORKDIR%\build+deploy.bat
  set "ARGS=--from-clone"
  if "%BUILD_ONLY%"=="1" set "ARGS=!ARGS! --build-only"
  if "%NO_DEPLOY%"=="1"  set "ARGS=!ARGS! --no-deploy"
  if defined TAG_OVERRIDE set "ARGS=!ARGS! --tag !TAG_OVERRIDE!"
  call "%WORKDIR%\build+deploy.bat" !ARGS!
  exit /b !errorlevel!
)
set "REPO=%WORKDIR%"
:have_repo

rem ---- Version -----------------------------------------------------------------------------------------------------------
for /f "delims=" %%i in ('git -C "%REPO%" rev-parse --short HEAD') do set "SHA=%%i"
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set "STAMP=%%i"
if defined TAG_OVERRIDE ( set "TAG=%TAG_OVERRIDE%" ) else ( set "TAG=%STAMP%-%SHA%" )
set "IMAGE=%REGISTRY%/%IMAGE_NAME%"
echo      Version: %TAG%

rem ---- Tailscale ---------------------------------------------------------------------------------------------------------
echo [2/5] Pruefe Tailscale ...
if "%SKIP_TS_CHECK%"=="1" goto :ts_ok
set "TS="
where tailscale >nul 2>&1 && set "TS=tailscale"
if not defined TS if exist "%ProgramFiles%\Tailscale\tailscale.exe" set "TS=%ProgramFiles%\Tailscale\tailscale.exe"
if not defined TS (
  echo [WARNUNG] tailscale.exe nicht gefunden - ueberspringe die Pruefung. ^(SKIP_TS_CHECK=1 blendet das aus^)
  goto :ts_ok
)
"%TS%" status >nul 2>&1
if errorlevel 1 ( echo [FEHLER] Tailscale ist nicht verbunden - bitte in der Tailscale-App anmelden. & goto :fail )
:ts_ok

rem ---- Registry-Login (optional) --------------------------------------------------------------------------------------
if defined REGISTRY_USER if defined REGISTRY_PASSWORD (
  echo      Melde bei %REGISTRY% an ...
  echo %REGISTRY_PASSWORD%| docker login "%REGISTRY%" --username "%REGISTRY_USER%" --password-stdin
  if errorlevel 1 ( echo [FEHLER] docker login fehlgeschlagen. & goto :fail )
)

rem ---- Bauen und pushen ----------------------------------------------------------------------------------------------
echo [3/5] Baue Image %IMAGE%:%TAG% ...
if defined PLATFORM (
  docker buildx build --platform "%PLATFORM%" -t "%IMAGE%:%TAG%" -t "%IMAGE%:latest" --push "%REPO%"
  if errorlevel 1 ( echo [FEHLER] docker buildx fehlgeschlagen. & goto :fail )
  echo [4/5] Gebaut und gepusht mit buildx ^(%PLATFORM%^).
) else (
  docker build -t "%IMAGE%:%TAG%" -t "%IMAGE%:latest" "%REPO%"
  if errorlevel 1 ( echo [FEHLER] docker build fehlgeschlagen. & goto :fail )
  if "%BUILD_ONLY%"=="1" ( echo [4/5] --build-only: kein Push. & goto :done )
  echo [4/5] Pushe in die Registry ...
  docker push "%IMAGE%:%TAG%"
  if errorlevel 1 ( echo [FEHLER] Push fehlgeschlagen - Registry erreichbar? Insecure-Registry eingetragen? & goto :fail )
  docker push "%IMAGE%:latest"
  if errorlevel 1 ( echo [FEHLER] Push von :latest fehlgeschlagen. & goto :fail )
)
if "%BUILD_ONLY%"=="1" goto :done
if "%NO_DEPLOY%"=="1" ( echo [5/5] --no-deploy: Server wird nicht aktualisiert. & goto :done )

rem ---- Server aktualisieren -----------------------------------------------------------------------------------------
echo [5/5] Aktualisiere den Server %SSH_TARGET% ...
ssh %SSH_OPTS% %SSH_TARGET% "mkdir -p '%REMOTE_DIR%'"
if errorlevel 1 ( echo [FEHLER] SSH-Verbindung fehlgeschlagen ^(SSH_TARGET, Schluessel/Tailscale SSH pruefen^). & goto :fail )
scp %SSH_OPTS% "%REPO%\docker-compose.registry.yml" "%SSH_TARGET%:%REMOTE_DIR%/docker-compose.yml"
if errorlevel 1 ( echo [FEHLER] scp der Compose-Datei fehlgeschlagen. & goto :fail )
ssh %SSH_OPTS% %SSH_TARGET% "test -f '%REMOTE_DIR%/.env'"
if errorlevel 1 (
  scp %SSH_OPTS% "%REPO%\.env.example" "%SSH_TARGET%:%REMOTE_DIR%/.env.example"
  echo.
  echo [HINWEIS] Auf dem Server fehlt %REMOTE_DIR%/.env. Die Vorlage liegt als .env.example dort.
  echo           Anlegen ^(ADMIN_TOKEN, VAPID_SUBJECT, CONTROLLER_*^) und dieses Skript erneut starten:
  echo             ssh %SSH_TARGET%  "cd %REMOTE_DIR% && cp .env.example .env && nano .env"
  goto :fail
)
ssh %SSH_OPTS% %SSH_TARGET% "cd '%REMOTE_DIR%' && export RATESPASS_IMAGE='%IMAGE%:%TAG%' && docker compose pull && docker compose up -d && echo '%IMAGE%:%TAG%' > .deployed-image && docker image prune -f >/dev/null"
if errorlevel 1 ( echo [FEHLER] docker compose auf dem Server fehlgeschlagen ^(Server als insecure-registry eingetragen? Docker laeuft?^). & goto :fail )

echo      Warte auf den Gesundheitscheck ...
set "OK=0"
for /l %%n in (1,1,12) do (
  if "!OK!"=="0" (
    ssh %SSH_OPTS% %SSH_TARGET% "curl -fsS http://127.0.0.1:%HOST_PORT%/healthz >/dev/null" >nul 2>&1
    if not errorlevel 1 ( set "OK=1" ) else ( timeout /t 5 /nobreak >nul )
  )
)
if "%OK%"=="0" (
  echo [WARNUNG] /healthz antwortet nicht. Logs:  ssh %SSH_TARGET% "cd %REMOTE_DIR% && docker compose logs --tail 50"
  goto :fail
)

:done
echo.
echo === Fertig: %IMAGE%:%TAG% ===
endlocal & exit /b 0

rem ---- Unterprogramme --------------------------------------------------------------------------------------------------
:need
where %~1 >nul 2>&1
if errorlevel 1 ( echo [FEHLER] %~1 nicht gefunden. %~2 & exit /b 1 )
exit /b 0

:pull
echo      Aktualisiere %~1 ...
git -C "%~1" fetch --quiet origin
if defined BRANCH git -C "%~1" checkout "%BRANCH%" 2>nul
git -C "%~1" pull --ff-only --quiet
if errorlevel 1 echo [WARNUNG] git pull nicht moeglich ^(lokale Aenderungen?^) - baue den aktuellen Stand.
exit /b 0

:fail
echo.
echo === ABGEBROCHEN ===
endlocal & exit /b 1

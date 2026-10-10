@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "SELF=%~f0"
set "SELFDIR=%~dp0"

rem ============================================================================================================
rem  build+deploy.bat  -  Quissel: Repo klonen, Docker-Image bauen, in die Registry pushen (und optional per SSH
rem                       auf dem Server aktualisieren). Ablauf wie build_docker.bat + deploy_docker.bat (HandPack).
rem
rem  Aufruf:  build+deploy.bat [registry-host:port] [namespace] [Optionen]
rem  Beispiel: build+deploy.bat 100.68.13.43:5000            -> 100.68.13.43:5000/ratespass:<datum>-<commit> + :latest
rem            build+deploy.bat 100.68.13.43:5000 kristian   -> 100.68.13.43:5000/kristian/ratespass:...
rem  Optionen: --build-only   nur bauen, kein Push
rem            --no-deploy    pushen, aber den Server nicht per SSH aktualisieren
rem            --branch NAME  Branch des Repos        --tag NAME   eigener Tag statt <datum>-<commit>
rem            --no-pull      vorhandenes Repo nicht aktualisieren
rem            --no-pause     am Ende nicht auf eine Taste warten
rem            --make-shortcut  Windows-Verknuepfung "Quissel deploy - <registry>.lnk" auf dem Desktop anlegen
rem                             (Ziel = diese Datei, Argument = registry-host:port, wie bei deploy_docker.bat)
rem
rem  Ablauf
rem    1. Repo holen: Liegt diese Datei NICHT in einem Git-Repo, wird das Repo (REPO_URL) nach WORKDIR geklont
rem       (bzw. dort aktualisiert) und diese Datei wird aus dem Klon erneut gestartet - der Klon enthaelt sie ja
rem       selbst, so gilt immer die neueste Fassung. Liegt sie im Repo, wird dieses Repo verwendet.
rem    2. Pruefen: git, docker (und ssh/scp nur, wenn SSH_TARGET gesetzt ist), Tailscale-Verbindung.
rem    3. Bauen:   docker build  (oder buildx bei PLATFORM)  ->  REGISTRY[/NAMESPACE]/ratespass:<datum>-<commit> und :latest
rem    4. Pushen:  beide Tags in die Registry.
rem    5. Server:  - Standard (SSH_TARGET leer): Hinweis "In Dockge verwenden: image: ..." - Image in der Dockge-
rem                  Stack eintragen (compose: docker-compose.dockge.yml, .env: RATESPASS_IMAGE=...) und dort
rem                  "Update" / "Pull & Redeploy" ausfuehren.
rem                - Mit SSH_TARGET: docker-compose.registry.yml per scp nach REMOTE_DIR, dann per ssh
rem                  "docker compose pull + up -d" und Gesundheitspruefung. Die .env auf dem Server wird nie ueberschrieben.
rem
rem  Einstellungen: unten Standardwerte; ueberschreiben per Umgebungsvariable oder in deploy.local.bat
rem  (Vorlage deploy.local.bat.example, wird nicht eingecheckt). Geheimnisse gehoeren NICHT in diese Datei.
rem
rem  Hinweise zur Registry
rem    * Port ist Pflicht (z. B. :5000) - ohne Port versucht Docker HTTPS auf Port 443 -> "connection refused".
rem    * Laeuft die Registry ohne TLS (http), muss sie auf diesem Rechner als "insecure-registry" eingetragen sein:
rem        Docker Desktop -> Settings -> Docker Engine -> JSON ergaenzen:
rem          { "insecure-registries": ["100.68.13.43:5000"] }   -> Apply & Restart
rem      Der Server (Dockge/Docker auf Unraid) braucht denselben Eintrag, damit er das Image ziehen kann.
rem    * Die Registry liegt im Tailnet: dieser Rechner und der Server muessen in Tailscale angemeldet sein.
rem    * PLATFORM (z. B. linux/arm64) nutzt buildx; bei einer HTTP-Registry braucht buildx eine eigene
rem      BuildKit-Konfiguration - dann PLATFORM weglassen und die Architektur des Servers beim Bauen beachten.
rem ============================================================================================================

rem ---- Einstellungen aus deploy.local.bat laden (neben dieser Datei) --------------------------------------------
if exist "%SELFDIR%deploy.local.bat" call "%SELFDIR%deploy.local.bat"

rem ---- Standardwerte (nur setzen, wenn noch nicht vorhanden) ----------------------------------------------------
if not defined REPO_URL     set "REPO_URL=https://github.com/qwertz098/ratespass.git"
if not defined BRANCH       set "BRANCH="
if not defined WORKDIR      set "WORKDIR=%USERPROFILE%\ratespass-build"
if not defined REGISTRY     set "REGISTRY=100.68.13.43:5000"
if not defined NAMESPACE    set "NAMESPACE="
if not defined IMAGE_NAME   set "IMAGE_NAME=ratespass"
if not defined PLATFORM     set "PLATFORM="
if not defined SSH_TARGET   set "SSH_TARGET="
if not defined SSH_OPTS     set "SSH_OPTS=-o BatchMode=yes -o ConnectTimeout=15"
if not defined REMOTE_DIR   set "REMOTE_DIR=/opt/ratespass"
if not defined HOST_PORT    set "HOST_PORT=3007"
if not defined SKIP_TS_CHECK set "SKIP_TS_CHECK=0"

rem ---- Argumente --------------------------------------------------------------------------------------------------
set "BUILD_ONLY=0"
set "NO_DEPLOY=0"
set "NO_PULL=0"
set "NO_PAUSE=0"
set "MAKE_SHORTCUT=0"
set "TAG_OVERRIDE="
set "FROM_CLONE=0"
set "ARG_REGISTRY="
set "ARG_NAMESPACE="
:args
if "%~1"=="" goto :args_done
set "ARG=%~1"
if "!ARG:~0,2!"=="--" goto :opt
if not defined ARG_REGISTRY ( set "ARG_REGISTRY=!ARG!" ) else if not defined ARG_NAMESPACE ( set "ARG_NAMESPACE=!ARG!" )
shift
goto :args
:opt
if /I "!ARG!"=="--build-only"     set "BUILD_ONLY=1"
if /I "!ARG!"=="--no-deploy"      set "NO_DEPLOY=1"
if /I "!ARG!"=="--no-pull"        set "NO_PULL=1"
if /I "!ARG!"=="--no-pause"       set "NO_PAUSE=1"
if /I "!ARG!"=="--make-shortcut"  set "MAKE_SHORTCUT=1"
if /I "!ARG!"=="--from-clone"     set "FROM_CLONE=1"
if /I "!ARG!"=="--branch"         (set "BRANCH=%~2" & shift)
if /I "!ARG!"=="--tag"            (set "TAG_OVERRIDE=%~2" & shift)
shift
goto :args
:args_done
if defined ARG_REGISTRY  set "REGISTRY=%ARG_REGISTRY%"
if defined ARG_NAMESPACE set "NAMESPACE=%ARG_NAMESPACE%"

rem ---- Registry muss einen Port enthalten (sonst versucht Docker HTTPS auf 443) -------------------------------------
echo %REGISTRY%| findstr /r ":[0-9][0-9]*$" >nul
if errorlevel 1 (
  echo [FEHLER] "%REGISTRY%" enthaelt keinen Port ^(z. B. :5000^).
  echo          Ohne Port versucht Docker HTTPS auf Port 443 -^> "connection refused".
  echo          Beispiel: build+deploy.bat 100.68.13.43:5000
  goto :fail
)
set "IMAGE=%REGISTRY%/%IMAGE_NAME%"
if defined NAMESPACE set "IMAGE=%REGISTRY%/%NAMESPACE%/%IMAGE_NAME%"

if "%MAKE_SHORTCUT%"=="1" goto :shortcut

echo.
echo === Quissel build+deploy ===============================================
echo  Registry : %REGISTRY%
echo  Image    : %IMAGE%
if defined SSH_TARGET ( echo  Server   : %SSH_TARGET%  ^(%REMOTE_DIR%^) ) else ( echo  Server   : Dockge ^(Hinweis am Ende, kein SSH^) )
echo ========================================================================

rem ---- Werkzeuge pruefen -------------------------------------------------------------------------------------------
call :need git    "Git fuer Windows installieren: https://git-scm.com/download/win" || goto :fail
call :need docker "Docker Desktop installieren und starten: https://www.docker.com/products/docker-desktop" || goto :fail
set "DO_SSH=0"
if defined SSH_TARGET if "%BUILD_ONLY%%NO_DEPLOY%"=="00" set "DO_SSH=1"
if "%DO_SSH%"=="1" (
  call :need ssh "OpenSSH-Client aktivieren (Windows: Einstellungen - Optionale Features - OpenSSH-Client)" || goto :fail
  call :need scp "OpenSSH-Client aktivieren (enthaelt scp)" || goto :fail
)
docker info >nul 2>&1
if errorlevel 1 ( echo [FEHLER] Docker laeuft nicht - bitte Docker Desktop starten. & goto :fail )

rem ---- Repo bestimmen: im Repo ausfuehren oder klonen -----------------------------------------------------------
set "HERE=%SELFDIR%"
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
  if "%NO_PAUSE%"=="1"   set "ARGS=!ARGS! --no-pause"
  if defined TAG_OVERRIDE set "ARGS=!ARGS! --tag !TAG_OVERRIDE!"
  set "ARGS=!ARGS! !REGISTRY!"
  if defined NAMESPACE set "ARGS=!ARGS! !NAMESPACE!"
  call "%WORKDIR%\build+deploy.bat" !ARGS!
  exit /b !errorlevel!
)
set "REPO=%WORKDIR%"
:have_repo

rem ---- Version -----------------------------------------------------------------------------------------------------------
for /f "delims=" %%i in ('git -C "%REPO%" rev-parse --short HEAD') do set "SHA=%%i"
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set "STAMP=%%i"
if defined TAG_OVERRIDE ( set "TAG=%TAG_OVERRIDE%" ) else ( set "TAG=%STAMP%-%SHA%" )
for /f "delims=" %%i in ('git -C "%REPO%" rev-list --count HEAD') do set "COUNT=%%i"
set "APP_VERSION=0.0.%COUNT%"
echo      Version: %TAG%  ^(App %APP_VERSION%^)

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
set "PUSHED=0"
echo [3/5] Baue Image %IMAGE%:%TAG% ...
if defined PLATFORM (
  if "%BUILD_ONLY%"=="1" (
    docker buildx build --build-arg APP_VERSION=%APP_VERSION% --platform "%PLATFORM%" -t "%IMAGE%:%TAG%" -t "%IMAGE%:latest" "%REPO%"
    if errorlevel 1 ( echo [FEHLER] docker buildx fehlgeschlagen. & goto :fail )
    echo [4/5] --build-only: kein Push. ^(buildx ohne --push legt das Image nur im Build-Cache ab^)
    goto :done
  )
  docker buildx build --build-arg APP_VERSION=%APP_VERSION% --platform "%PLATFORM%" -t "%IMAGE%:%TAG%" -t "%IMAGE%:latest" --push "%REPO%"
  if errorlevel 1 ( echo [FEHLER] docker buildx fehlgeschlagen - Registry erreichbar? Insecure-Registry eingetragen? & goto :fail )
  echo [4/5] Gebaut und gepusht mit buildx ^(%PLATFORM%^).
  set "PUSHED=1"
) else (
  docker build --build-arg APP_VERSION=%APP_VERSION% -t "%IMAGE%:%TAG%" -t "%IMAGE%:latest" "%REPO%"
  if errorlevel 1 ( echo [FEHLER] docker build fehlgeschlagen. & goto :fail )
  if "%BUILD_ONLY%"=="1" ( echo [4/5] --build-only: kein Push. & goto :done )
  echo [4/5] Pushe in die Registry %REGISTRY% ...
  docker push "%IMAGE%:%TAG%"
  if errorlevel 1 (
    echo [FEHLER] Push fehlgeschlagen. Ist die Registry erreichbar und als insecure-registry in Docker Desktop
    echo          eingetragen? ^(Settings - Docker Engine: "insecure-registries": ["%REGISTRY%"]^)
    goto :fail
  )
  docker push "%IMAGE%:latest"
  if errorlevel 1 ( echo [FEHLER] Push von :latest fehlgeschlagen. & goto :fail )
  set "PUSHED=1"
)
if "%BUILD_ONLY%"=="1" goto :done
if "%NO_DEPLOY%"=="1" ( echo [5/5] --no-deploy: Server wird nicht per SSH aktualisiert. & goto :done )
if not defined SSH_TARGET ( echo [5/5] Kein SSH_TARGET gesetzt - Server wird nicht per SSH aktualisiert ^(siehe Dockge-Hinweis^). & goto :done )

rem ---- Server per SSH aktualisieren (optional) ------------------------------------------------------------------------
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
set "DIGEST="
if "%PUSHED%"=="1" for /f "delims=" %%d in ('docker image inspect --format "{{index .RepoDigests 0}}" "%IMAGE%:latest" 2^>nul') do set "DIGEST=%%d"
if "%PUSHED%"=="1" (
  echo Erfolgreich gepusht: %IMAGE%:%TAG%  und  %IMAGE%:latest  ^(App-Version %APP_VERSION%^)
  if defined DIGEST echo Registry-Stand: !DIGEST!
  echo.
  echo In Dockge verwenden:  image: %IMAGE%:latest   ^(immer :latest, dann reicht dort "Update"^)
  echo   Stack-compose: Inhalt von docker-compose.dockge.yml (Repo) einfuegen, Stack-.env: RATESPASS_IMAGE=%IMAGE%:latest
  echo   Ein fester Tag ^(%TAG%^) zieht bei "Update" immer wieder dasselbe Image - nur fuer einen Rollback.
  echo   Pruefen, ob der Server neu ist:  http://SERVER:3007/version.js  zeigt 0.0.%COUNT% oder hoeher
  echo   NICHT docker-compose.yml / docker-compose.npm.yml nehmen: sie enthalten "build:" und scheitern im Dockge-Ordner
  echo   mit "failed to read dockerfile". Danach im Stack "Update" bzw. "Pull & Redeploy".
  echo   Der Server braucht die Registry als insecure-registry.
)
echo.
if not "%NO_PAUSE%"=="1" pause
endlocal & exit /b 0

rem ---- Verknuepfung anlegen (--make-shortcut) -------------------------------------------------------------------------
:shortcut
set "RN=%REGISTRY::=_%"
set "SC_ARGS=%REGISTRY%"
if defined NAMESPACE set "SC_ARGS=%SC_ARGS% %NAMESPACE%"
set "SC_TARGET=%SELF%"
set "SC_DIR=%SELFDIR%"
set "DESK="
for /f "usebackq delims=" %%d in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESK=%%d"
if not defined DESK set "DESK=%SC_DIR%"
set "SC_LNK=%DESK%\Quissel deploy - %RN%.lnk"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:SC_LNK); $s.TargetPath=$env:SC_TARGET; $s.Arguments=$env:SC_ARGS; $s.WorkingDirectory=$env:SC_DIR; $s.IconLocation='shell32.dll,12'; $s.Description='Quissel: Image bauen und in die Registry pushen'; $s.Save()"
if errorlevel 1 ( echo [FEHLER] Verknuepfung konnte nicht angelegt werden. & goto :fail )
echo.
echo Verknuepfung angelegt:  %SC_LNK%
echo   Ziel     : %SC_TARGET%
echo   Argument : %SC_ARGS%
echo   Ein Doppelklick baut das Image und pusht es nach %REGISTRY%.
echo.
if not "%NO_PAUSE%"=="1" pause
endlocal & exit /b 0

rem ---- Unterprogramme --------------------------------------------------------------------------------------------------
:need
where %~1 >nul 2>&1
if not errorlevel 1 exit /b 0
echo [FEHLER] %~1 nicht gefunden. %~2
exit /b 1

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
if not "%NO_PAUSE%"=="1" pause
endlocal & exit /b 1

@echo off
title Meu Sistema

echo Aguardando Rancher Desktop...

:waitDocker
docker info >nul 2>&1
if errorlevel 1 (
    timeout /t 3 /nobreak >nul
    goto waitDocker
)

echo Docker pronto!

cd /d "C:\projetos\meu-sistema"

docker compose up -d

npm run dev
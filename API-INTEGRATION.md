# Integração IHM ↔ IFTS CSV Bridge

## Endereços

Exemplo de rede de produção:

| Componente | Endereço |
| --- | --- |
| IFTS CSV Bridge | `http://192.168.137.1:8787` |
| API da IHM | `http://192.168.137.2:3000` |

O endereço da IHM usado pelo bridge é configurado em `.env`, no campo `IHM_URL` (`config.json` continua disponível como fallback).

> `127.0.0.1` significa o próprio computador. Em PCs separados, usar o IP fixo do PC da IHM.

## Autenticação da API do bridge

Todas as chamadas da IHM para o bridge exigem:

```http
X-API-Key: <valor-de-BRIDGE_API_KEY-no-env-do-bridge>
Content-Type: application/json
```

## 1. Consultar saúde do bridge

```http
GET /health
```

Resposta `200`:

```json
{
  "ok": true,
  "state": {
    "status": "idle",
    "lastCycle": null
  }
}
```

Estados possíveis: `idle`, `started`, `delivery_failed`, `delivered_cleanup_pending` e `completed`.

## 2. Consultar modelo configurado

```http
GET /model
```

Resposta `200`:

```json
{
  "model": "SAMSUNG_A15",
  "source": "C:\\IFTS\\Config.Ini",
  "cycleStatus": "idle",
  "cycleId": null
}
```

## 3. Alterar modelo configurado

```http
PUT /model
```

Body:

```json
{
  "model": "SAMSUNG_A16"
}
```

Resposta `200`:

```json
{
  "model": "SAMSUNG_A16",
  "previousModel": "SAMSUNG_A15",
  "changed": true,
  "backup": "C:\\IFTS-CSV-Bridge\\archive\\config-backups\\Config.Ini.2026-09-24T12_00_00.000Z.bak",
  "restartMayBeRequired": true
}
```

Resposta `409`: há um ciclo pendente; não alterar o modelo durante um teste.

## 4. Iniciar ciclo

```http
POST /cycle/start
```

Body:

```json
{
  "cycleId": "ORDEM-000123"
}
```

`cycleId` deve identificar unicamente o teste/ordem. Se omitido, o bridge gera um UUID, mas a IHM deve sempre enviar um valor próprio para facilitar rastreabilidade.

Resposta `200`:

```json
{
  "status": "started",
  "cycleId": "ORDEM-000123",
  "model": "SAMSUNG_A15",
  "startedAt": "2026-09-24T12:00:00.000Z",
  "archivedBeforeStart": []
}
```

No START, o bridge lê o modelo atual e arquiva CSVs anteriores daquele modelo/data. Não iniciar um novo ciclo se a resposta for `409`.

## 5. Finalizar ciclo

```http
POST /cycle/finish
```

Body:

```json
{
  "cycleId": "ORDEM-000123"
}
```

O `cycleId` precisa ser o mesmo do START.

O bridge procura o arquivo gerado pelo IFTS em:

```text
Log\AAAAMM\Normal\<MODELO>_*_AAAAMMDD.Csv
```

Ele aguarda o arquivo aparecer e ficar estável, envia os dados à IHM e só depois arquiva o CSV.

Resposta `200`: ciclo entregue e concluído.

Resposta `409`: ciclo inexistente, `cycleId` divergente ou CSV ainda não apareceu. A IHM deve manter o ciclo pendente e tentar novamente.

Use timeout HTTP de pelo menos 60 segundos nesta chamada.

## 6. Repetir entrega/limpeza

```http
POST /cycle/retry
```

Body:

```json
{
  "cycleId": "ORDEM-000123"
}
```

Usar quando houver erro de rede, falha da API da IHM ou arquivo bloqueado.

Se a IHM já confirmou a gravação e apenas a limpeza local falhou, o retry não reenvia o resultado: apenas termina o arquivamento do CSV.

## 7. Receber resultado do bridge (API da IHM)

A IHM deve implementar e disponibilizar o endpoint configurado em `IHM_URL`:

```http
POST /api/test-results
Content-Type: application/json
Idempotency-Key: <cycleId>
X-API-Key: <ihmApiKey>  // somente se configurado no bridge
```

Payload recebido:

```json
{
  "schemaVersion": 2,
  "cycleId": "ORDEM-000123",
  "model": "SAMSUNG_A15",
  "startedAt": "2026-09-24T12:00:00.000Z",
  "finishedAt": "2026-09-24T12:03:00.000Z",
  "result": "FAIL",
  "passed": false,
  "totalPositions": 2,
  "passedPositions": 1,
  "failedPositions": 1,
  "positions": [
    {
      "position": 1,
      "passed": true,
      "result": "PASS",
      "judgment": "OK",
      "ngStep": null,
      "message": null
    },
    {
      "position": 2,
      "passed": false,
      "result": "FAIL",
      "judgment": "NG",
      "ngStep": "OCV",
      "message": "Voltage fora do limite"
    }
  ],
  "sourceFiles": [
    {
      "name": "SAMSUNG_A15_0_20260924.Csv",
      "positionCount": 2
    }
  ]
}
```

Cada registro do CSV representa uma posição/canal. `judgment` preserva o valor original do equipamento, enquanto `passed` e `result` fornecem o resultado normalizado. Por padrão, apenas `OK` e `PASS` aprovam; os valores podem ser alterados por `PASS_JUDGMENTS` no `.env`. Qualquer outro julgamento, inclusive `NG`, `FAIL`, `ESC`, vazio ou desconhecido, falha de forma segura.

A IHM deve persistir o resultado de forma transacional e retornar `200` ou `201` somente após gravar no banco. Exemplo:

```json
{
  "received": true,
  "duplicate": false,
  "cycleId": "ORDEM-000123"
}
```

O `cycleId`/`Idempotency-Key` deve ter restrição única no banco. Se receber o mesmo ciclo novamente, não duplicar os dados e responder `200`.

Qualquer resposta diferente de `2xx` faz o bridge preservar o CSV e o payload na `outbox` para retry.

## Fluxo completo

```text
CLP informa a chegada → IHM reserva a bandeja e chama POST /cycle/start
IFTS executa e grava CSV local
Bridge detecta automaticamente o CSV estável
Bridge lê CSV → Bridge chama POST /api/test-results na IHM
IHM salva e responde 2xx → Bridge arquiva CSV → ciclo completed
```

`POST /cycle/finish` permanece apenas como alternativa manual de diagnóstico. O fluxo produtivo não o aciona.

## Códigos de erro relevantes

| HTTP | Significado | Ação da IHM |
| --- | --- | --- |
| `200` / `201` | Operação concluída | Avançar o fluxo. |
| `400` | Request/modelo inválido | Corrigir a chamada; não repetir automaticamente. |
| `401` | API key inválida | Corrigir configuração de chaves. |
| `409` | Conflito de ciclo/estado | Não iniciar outro ciclo; consultar `/health`. |
| `422` | CSV sem posições reconhecíveis | Verificar o formato/geração do CSV no IFTS. |
| `500` ou falha de rede | Arquivo, bridge ou API indisponível | Manter ciclo pendente e usar `/cycle/retry`. |

## Swagger do bridge

```text
http://IP-DO-BRIDGE:8787/docs
http://IP-DO-BRIDGE:8787/openapi.json
```

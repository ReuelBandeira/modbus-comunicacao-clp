# IFTS CSV Bridge

O bridge envia cada ciclo concluído para:

```text
POST http://<IP_DO_PC_PRINCIPAL>:3000/api/test-results
```

A API escuta em `API_HOST`/`API_PORT`. Para acesso pela rede local, use `API_HOST=0.0.0.0` e libere a porta TCP no firewall do PC Principal.

## Autenticação e idempotência

Configure no `.env` do PC Principal:

```env
API_HOST=0.0.0.0
API_PORT=3000
IFTS_CSV_BRIDGE_API_KEY=uma-chave-longa-e-aleatoria
```

O bridge deve enviar `Content-Type: application/json`, `Idempotency-Key: <cycleId>` e `X-API-Key` com o mesmo segredo.
Se `IFTS_CSV_BRIDGE_API_KEY` ficar vazia ou ausente, a validação da chave é desativada. Cookies e sessão ADMIN não são usados.

## Persistência

Cada ciclo é salvo como um único documento em `ifts_test_results`. A operação `insertOne` é atômica no MongoDB e o HTTP 201
só é devolvido depois da confirmação do banco. O índice `uq_ifts_test_result_cycle` torna `cycleId` único e converte reenvios
em HTTP 200 com `duplicate: true`.

O documento preserva `header` e cada linha como arrays, inclusive quando existem nomes de colunas repetidos. A estrutura recebida
é armazenada diretamente, sem duplicar todo o payload em outro campo, evitando consumir duas vezes o limite de documento do MongoDB.

## Consultas para a IHM

```text
GET /api/test-results?limit=50
GET /api/test-results?model=SAMSUNG_A15
GET /api/test-results?from=2026-09-24T00:00:00.000Z&to=2026-09-25T00:00:00.000Z
GET /api/test-results/{cycleId}
```

A listagem retorna resumos. A consulta por `cycleId` retorna os arquivos, cabeçalhos e linhas.

## Exemplo PowerShell

```powershell
$body = @{
    schemaVersion = 1
    cycleId = 'ordem-123'
    model = 'SAMSUNG_A15'
    startedAt = '2026-09-24T14:20:10.000Z'
    finishedAt = '2026-09-24T14:22:45.000Z'
    rowCount = 2
    files = @(@{
        name = 'SAMSUNG_A15_0_20260924.Csv'
        header = @('Serial', 'Result', 'Item', 'Value')
        rows = @(
            @('A001', 'PASS', 'DDR_TEST', 'OK'),
            @('A002', 'FAIL', 'DDR_TEST', 'ERROR')
        )
        rowCount = 2
    })
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method Post `
    -Uri 'http://192.168.10.1:3000/api/test-results' `
    -ContentType 'application/json' `
    -Headers @{ 'Idempotency-Key' = 'ordem-123'; 'X-API-Key' = 'uma-chave-longa-e-aleatoria' } `
    -Body $body
```

Execute `npm run db:migrate` ou apenas reinicie a API para garantir automaticamente a collection e seus índices.

## Tela de teste do fluxo

Acesse **Configurações → Teste da integração IFTS** ou abra `/line/ifts-teste.html`. A tela exige uma sessão ADMIN e permite:

- consultar `/health` e `/model` do Bridge;
- gerar um `cycleId` de simulação;
- enviar START, FINISH e RETRY com o mesmo identificador;
- alterar o modelo quando não houver ciclo ativo;
- consultar o resultado retornado pelo Bridge e persistido em `ifts_test_results`.

O endereço e a credencial do Bridge ficam somente no backend:

```env
IFTS_BRIDGE_BASE_URL=http://192.168.137.1:8787
IFTS_BRIDGE_API_KEY=mesma-chave-configurada-no-bridge
IFTS_BRIDGE_TIMEOUT_MS=60000
IFTS_MEMORY_MACHINE_ID=m3
IFTS_EXPECTED_POSITION_COUNT=20
```

## Preparação automática na pré-partida

A tela de Entrada consulta o Bridge antes de liberar a bipagem. O PCM interpreta o contrato real do projeto: o ciclo vem em
`health.state`, enquanto a condição completa da estação vem em `health.stationReady` e `health.ifts`. Se o Bridge estiver online,
mas o IFTS não estiver pronto, o PCM chama `POST /ifts/start-auto-save-set` e aguarda `stationReady=true`.

O servidor Bridge é iniciado pela tarefa já configurada no computador da estação. O PCM não tenta executar essa tarefa nem
iniciar o processo pela rede. Enquanto `/health` e `/model` não responderem, a pré-partida permanece bloqueada e informa ao
operador que deve aguardar a tarefa de inicialização.

```env
IFTS_BRIDGE_STARTUP_TIMEOUT_MS=60000
```

Esse timeout é usado somente para aguardar o Bridge abrir o aplicativo IFTS e aplicar o Auto Save Set.

A chave não é enviada ao navegador. A tela chama a API local do PCM, que acrescenta `X-API-Key` ao conversar com o Bridge.

## Fluxo produtivo da estação de memória

Com `IFTS_MEMORY_MACHINE_ID` configurada, a ação de sinal `IFTS · START` deixa de gerar um ciclo avulso: ela reserva a bandeja da máquina e usa o `cycleId` da etapa. O Bridge finaliza automaticamente ao detectar o CSV e envia `/api/test-results`; a aplicação não chama `/cycle/finish` em produção.

O resultado produtivo só é confirmado ao Bridge depois de ser associado à etapa da bandeja. Falha de correlação ou mapa diferente da quantidade configurada responde HTTP 500 para preservar a entrega no Bridge. Reenvios são idempotentes. Ciclos iniciados por `SIM-` permanecem disponíveis para a tela de debug e não alteram o workflow da linha.

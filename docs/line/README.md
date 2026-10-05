# Controle da linha PCM — primeira implementação

## Telas operacionais

- **BIPAGEM** é uma tela exclusiva para o leitor HID. Depois de autorizada, cada
  leitura persistida aparece imediatamente em **Últimos bips**, com sequência,
  horário e posição atual na linha.
- **ACOMPANHAMENTO** mostra as estações, filas e a vida da bandeja. Em **Ver etapas**,
  cada resposta de CLP aparece na step da máquina correspondente, incluindo `OK` ou
  `NAO`, `errorCode`, `cycleTimeMs`, horários de resultado e de passagem.
- **BANDEJAS** permite localizar passagens, acompanhar sua posição e encerrar uma
  ocorrência como retirada ou quarentena, mediante autenticação ADMIN.
- **CONFIGURAÇÕES** mantém o cadastro, a ordem das máquinas e os mapas Modbus.
- **Simular teste**, dentro do acompanhamento, continua disponível para gerar os
  mesmos eventos sem escrever em uma CLP física.

A estação 1 usa `m1-qr-handshake-v1`: na chegada, o Node grava sequência e QR no
mailbox da CLP; a CLP confirma a passagem zerando todo o bloco. As estações 2–4 usam
`result-handshake-v1`: a CLP grava sequência, QR e posições, e o Node compara com a
ordem esperada, persiste a step e zera o bloco como ACK.

O Node é cliente Modbus TCP em todas as estações. Não há servidor ou porta Modbus
no computador do Node. Cada máquina cadastra somente o IP, porta e Unit ID de sua
CLP, além dos endereços do mailbox.

A API mantém a ordem de entrada e o histórico de cada passagem no MongoDB.
Máquinas sem mapa continuam em **simulação**. A primeira estação pode usar o protocolo
`m1-qr-handshake-v1`, e as seguintes usam `result-handshake-v1`. A API inicia um
polling de cada CLP somente depois que o mapa completo for salvo e habilitado.

## Preparação

1. Configure MongoDB no `.env` como em `.env.example`.
2. Configure `PCM_LINE_ID=linha-01` (também é o padrão se a variável estiver ausente).
3. Inicie `npm run infra:up` e `npm run start:api`, ou use a API iniciada pelo Electron.
4. Cadastre a linha antes de bipar. Os exemplos estão no Swagger, grupo **Linha PCM**,
   em `http://127.0.0.1:3000/api-docs/`.

Use **uma única instância da API/coordenador para a mesma linha**. A admissão é
serializada nessa instância, desde a reserva da sequência até o insert. O incremento
do contador é atômico, mas não substitui essa ordenação: não há suporte a múltiplas
instâncias recebendo bips para a mesma linha nesta versão. As reservas das estações
e as atualizações de resultados têm proteção adicional no MongoDB.

## Cadastro das máquinas

`POST /api/lines`, com `Content-Type: application/json`:

```json
{
  "lineId": "linha-01",
  "name": "Linha 1",
  "ipRange": { "min": 25, "max": 75 },
  "machines": [
    { "machineId": "m1", "name": "Máquina 1", "host": "192.168.1.25" },
    { "machineId": "m2", "name": "Máquina 2", "host": "192.168.1.35" },
    { "machineId": "m3", "name": "Máquina 3", "host": "192.168.1.45" },
    { "machineId": "m4", "name": "Máquina 4", "host": "192.168.1.55" }
  ]
}
```

A ordem do array é a ordem física. `ipRange` valida o último octeto do IPv4 e pode
ser configurado de 1 a 254. Porta padrão: **502**; `unitId`: **1**; `timeoutMs`: **3000**.
Esses três campos podem ser informados por máquina. IP, porta e Unit ID iguais não
podem se repetir dentro da linha. A configuração aceita até 32 máquinas, respeitando
o limite HTTP de 32 KB. IDs usam letras, números, hífen ou sublinhado, até 80 caracteres.

Repetir o cadastro com o mesmo `lineId` retorna 409. A retirada de bandejas é uma
intervenção auditada; não exclui documentos. Não há reset automático de passagem.
`GET /api/lines/linha-01` mostra a configuração persistida. O modo é `simulation`
quando todas as máquinas estão `unmapped` e passa a `production` ao habilitar o
protocolo da M1.

## Editar máquinas e sequência

Consulte `GET /api/lines/linha-01`, copie o objeto de `data`, ajuste os campos e envie
`PUT /api/lines/linha-01` com a configuração completa e a `revision` recebida.
Para reordenar, altere a posição dos itens em `machines`; não é necessário trocar IPs.

```json
{
  "revision": 1,
  "name": "Linha 1",
  "ipRange": { "min": 25, "max": 75 },
  "machines": [
    { "machineId": "m2", "name": "Máquina 2", "host": "192.168.1.35", "port": 502 },
    { "machineId": "m1", "name": "Máquina 1", "host": "192.168.1.25", "port": 502 },
    { "machineId": "m3", "name": "Máquina 3", "host": "192.168.1.45", "port": 502 }
  ]
}
```

A resposta retorna a nova revisão. Duas edições usando a mesma revisão não se
sobrescrevem: a segunda retorna 409 e precisa consultar novamente. Cadastros antigos
sem revisão são apresentados como revisão 1 e atualizados ao editar.

Com bandejas em andamento (mesmo aguardando a primeira estação), a edição retorna
409. A admissão e a edição compartilham a mesma exclusão no coordenador, evitando
alterar a configuração durante um insert pendente. Finalize as passagens antes de
trocar máquinas, conexões ou ordem. O histórico de bandejas concluídas é preservado;
novas bipagens recebem a sequência atual e `workflow.lineRevision`.

O exemplo acima muda a ordem para m2 → m1 → m3. Para seguir o teste abaixo,
mantenha a ordem inicial m1 → m2 → m3.

## Testar o percurso por POST

Todos os POSTs abaixo usam JSON. As rotas de eventos são de simulação e **alteram
o estado no MongoDB**, mas não acessam o equipamento.

### 1. Bipar A e B

`POST /api/serial-numbers`:

```json
{ "qr-code": "BANDEJA-A" }
```

Repita com `BANDEJA-B`. Um serial pode ser reutilizado depois que sua passagem anterior
for concluída; enquanto estiver em andamento, uma nova bipagem retorna 409.
A API registra cada bandeja com `workflow.entrySequence`, rota das etapas e estado
inicial `waiting`. Sem a linha cadastrada, retorna 404 antes de gravar.

### 2. Máquina 1 recebe A

`POST /api/lines/linha-01/machines/m1/arrival`:

```json
{ "cycleId": "ciclo-001" }
```

A resposta inclui `data.serialNumber`, `operationId`, `action: "EXECUTE"` e `state`.
Guarde o `operationId`. Repetir o mesmo `cycleId` retorna a mesma operação, inclusive
após a passagem ser concluída. Um novo ciclo enquanto há passagem pendente retorna 409.
O `cycleId` deve ser único por máquina/linha **também após reiniciar o CLP**; o adaptador
real deverá compor uma época de inicialização com o contador caso o CLP o reinicie.

### 3. Máquina 1 aprova e confirma a passagem

`POST /api/lines/linha-01/machines/m1/result`:

```json
{ "operationId": "ID-DA-OPERACAO-1", "result": "OK", "data": { "measurement": 12.5 } }
```

`POST /api/lines/linha-01/machines/m1/passage`:

```json
{ "operationId": "ID-DA-OPERACAO-1" }
```

Só agora A pode ser reservada pela máquina 2. A máquina 1 pode receber B usando
`cycleId: "ciclo-002"`. Um resultado não confirma automaticamente o avanço físico.

### 4. Máquina 2 reprova A

Envie `arrival` para `m2`, com `cycleId: "ciclo-001"`. O ciclo pode ter o mesmo texto
em máquinas diferentes. A resposta identifica A e fornece outra `operationId`.

Envie `result` para `m2`:

```json
{ "operationId": "ID-DA-OPERACAO-2", "result": "NAO", "data": { "reason": "Falha no processo" } }
```

Confirme `passage` usando essa operação. A bandeja passa a ter
`quality: "rejected"` e `blockedByMachine: "m2"`, mas continua no fluxo.

### 5. Máquina 3 continua testando A

Com o bypass desabilitado por padrão, envie `arrival` para `m3`. A resposta será
`action: "EXECUTE"`, mesmo que a qualidade geral já esteja `rejected`. Envie o
resultado e confirme `passage` normalmente. Assim, as posições e o resultado das
máquinas posteriores continuam registrados sem apagar a primeira reprovação.

O comportamento antigo pode ser reativado ao iniciar a aplicação com
`PCM_BYPASS_ENABLED=true`. Nesse modo, as etapas posteriores recebem `BYPASS` e
terminam como `skipped` após a confirmação de passagem.

Após a última passagem, `workflow.status` fica `completed`. A qualidade continua
`rejected`. Uma bandeja que tenha todas as etapas aprovadas termina com `approved`.

## Consultas e persistência

- `GET /api/trays/BANDEJA-A`: passagem mais recente desse serial.
- `GET /api/lines/linha-01/trays/123`: passagem exata identificada pela sequência 123.
- `GET /api/lines/linha-01/chip-metrics?from=...&to=...&timezoneOffsetMinutes=180`: métricas de chips por período e por hora.
- `GET /api/lines/linha-01/trays?limit=50`: últimas bandejas, incluindo as concluídas;
  limite entre 1 e 200, em ordem decrescente de entrada.
- `POST /api/lines/linha-01/trays/123/interventions`: encerra a passagem 123 como
  `removed` ou `quarantined`; exige sessão ADMIN, motivo e confirmação física quando
  a bandeja já estiver atribuída a uma estação.
- `pcm_lines`: máquinas e configuração da linha.
- `pcm_line_counters`: sequência de entrada da linha; preserve-a nos backups.
- `pcm_line_entries`: entidade PCM com `workflow`, etapas, resultados, timestamps,
  dados adicionais e identificação das operações.

### Relatório de chips

A tela `relatorios.html` consolida os arrays de posições das estações posteriores à
primeira máquina. Uma posição é aprovada somente quando todas essas estações registram
`true`; qualquer `false` reprova o chip. Posição ausente ou quantidade incompatível é
apresentada como indeterminada. As métricas usam bandejas concluídas e o horário de
saída final da linha.

Os índices são registrados nos modelos e garantidos na conexão e na migration.
Impedem reutilizar um serial ainda ativo, duplicar sequência por linha ou passagem ativa por máquina
e ciclo de máquina em bandejas diferentes. A atualização de todo o `workflow` usa
comparação da versão anterior e uma única escrita atômica por PCM, funcionando
também no MongoDB standalone do Docker Compose atual.

Uma consulta de chegada considera a primeira bandeja ainda aguardando aquela etapa,
mesmo que esteja na máquina anterior. Não permite que outra bandeja a ultrapasse.
Passagens retiradas ou em quarentena deixam de participar das filas. A ordem física
das demais bandejas continua sendo respeitada.

Registros antigos, sem `workflow`, são preservados e **não entram automaticamente na
fila**. O identificador `_id` existente não é alterado; `entrySequence` é independente.
A reutilização de uma bandeja cria uma nova passagem depois que a anterior é concluída,
retirada ou colocada em quarentena.

## Retirada e quarentena de bandejas

A tela **BANDEJAS** atualiza a listagem a cada três segundos e mantém até 200 passagens
recentes disponíveis para filtro. As ações possíveis sobre uma passagem em andamento são:

- `remove`: retirada operacional definitiva daquela passagem;
- `quarantine`: separação da bandeja para inspeção ou análise.

As duas ações preservam serial, sequência, etapas, resultados anteriores, motivo,
observação, horário e papel responsável (`ADMIN`). Elas não entram nas métricas de
produção concluída nem são excluídas do MongoDB.

Quando a bandeja está em uma estação, o operador deve confirmar que fez a retirada
física e que o mailbox da CLP está zerado. O serviço pausa os runtimes Modbus, grava
a intervenção de forma otimista e recria os runtimes. O PCM não envia reset cego para
a CLP. Se o mailbox continuar ocupado, a comunicação permanecerá bloqueada para
reconciliação, evitando associar os dados antigos à próxima bandeja.

Repetições idênticas são idempotentes. Resultado diferente do já persistido retorna
409. Sem operação correspondente, retorna 404. Em erro de banco, retorna 503 sem
confirmar o evento. Timeout de rede não reprova uma bandeja nem libera a próxima.

## Modbus das quatro estações

- `MachineModbusSession`: conexão persistente por máquina, FC01/FC03/FC05/FC16, porta padrão
  502, timeout e serialização das requisições. Uma falha de leitura permite reconectar
  na próxima tentativa. Escrita sem confirmação bloqueia novas escritas até o adaptador
  reconciliar a operação; não há reenvio automático de comandos.
- `ZeroMailboxRuntime`: na estação 1 escreve sequência/QR e aguarda duas leituras
  zeradas; nas estações 2–4 lê QR/posições estáveis, persiste e zera o bloco como ACK.
- `MachineRuntimeManager`: acompanha a revisão da configuração e inicia ou encerra
  um runtime por CLP sem criar leituras sobrepostas.

O runtime é iniciado pela API para cada máquina com protocolo integrado, integração
habilitada e mapa validado. Máquinas `unmapped` continuam sem comunicação automática. Consulte
`docs/modbus/M1_HANDSHAKE.md` para o fluxo, mapa do simulador e pendências da CLP real.

## Controle somente em banco

A bipagem confirma OK após o insert no MongoDB. Entrada, posição, resultados e
passagens são consultados e atualizados diretamente no banco; não há broker externo.
Em caso de resposta perdida, consulte a bandeja: repetir o serial retorna 409 enquanto
a passagem anterior estiver em andamento. Depois da conclusão, o mesmo serial cria uma
nova passagem e preserva as anteriores no histórico. Os sinais físicos e as regras finais de transferência entre estações ainda
serão validados com o debug das CLPs.

## Testes

```powershell
npm.cmd run test:line
```

Inclui regras do fluxo, concorrência, replay, bypass configurável, recuperação do coordenador,
validação e falhas da sessão Modbus. O teste Mongo real fica desabilitado por padrão.
Para executá-lo com o Mongo configurado no `.env`:

```powershell
npm.cmd run build
$env:PCM_TEST_MONGO = 'true'
node --env-file=.env --test --test-isolation=none scripts/testLineMongo.cjs
Remove-Item Env:PCM_TEST_MONGO
```

O teste cria collections temporárias com UUID, usa os índices reais e as remove
ao finalizar. Não modifica as collections da produção. A suíte Modbus também testa
a nova sessão usando um servidor TCP local simulado, sem acessar máquinas reais.

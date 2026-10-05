# Máquinas da IHM

As máquinas exibidas em `maquinas.html` possuem cadastro independente das máquinas do fluxo produtivo (`pcm_lines.machines`).
Elas são persistidas na coleção `pcm_ihm_machines` e reutilizam os comandos configurados no módulo **Sinais e comandos CLP**.

O cadastro visual fica em **Configurações → Máquinas da IHM** (`maquinas-admin.html`) e exige autenticação ADMIN.

Cada botão guarda o `commandId` de um comando existente. A execução continua passando por `/api/plc-controls/:code/execute`, portanto mantém ACK, timeout, intertravamentos, histórico e vínculo com a CLP.

O bloco **Controle geral** usa os comandos visíveis com escopo `line`. O código ou o nome desses comandos deve identificar a ação como `START`/`INICIAR`, `STOP`/`PARAR` ou `RESET`/`REARMAR`.

A toolbar da tela **Máquinas** possui temporariamente o botão protegido **REINICIAR ESTAÇÃO**. Ele usa exclusivamente um quarto comando, diferente do Reset geral, cadastrado em **Sinais e comandos CLP** com destino `Linha` e código lógico exato `REINICIAR_ESTACAO`. A tela solicita a senha ADMIN a cada acionamento. O botão fica desabilitado se o comando não estiver cadastrado, visível e ativo ou se algum intertravamento estiver aberto.

Após a confirmação, `POST /api/station-test-reset` executa uma operação destrutiva de bancada nesta ordem:

1. pausa os runtimes de mailbox;
2. executa e confirma o comando `REINICIAR_ESTACAO`;
3. zera M0, M1 e M2 e as áreas de entrada/saída configuradas em cada CLP, sempre com leitura de conferência;
4. somente se todas as CLPs forem conferidas, remove as bandejas da linha do MongoDB;
5. cria uma bandeja com 20 chips, estado `ready`, para aparecer na Entrada pronta para liberação;
6. retoma os runtimes aceitando uma eventual solicitação M0 já ativa na primeira leitura.

Se uma CLP não confirmar a limpeza, as bandejas do banco não são removidas. O log de comunicação não é apagado e registra cada Coil e faixa de registradores manipulada. O QR e o prefixo dos chips de teste podem ser definidos por `PCM_TEST_RESET_TRAY_SERIAL` e `PCM_TEST_RESET_CHIP_PREFIX`.

## Consultas

- `GET /api/ihm-machines`: retorna somente máquinas habilitadas; usado pela tela operacional.
- `GET /api/ihm-machines/configuration`: retorna todas as máquinas e exige token ADMIN.
- `GET /api/plc-signals`: retorna, entre outros dados, os comandos disponíveis para montar os vínculos e exige token ADMIN.

## Cadastro

`POST /api/ihm-machines`, com token ADMIN:

```json
{
  "ihmMachineId": "prensa-01",
  "name": "Prensa 01",
  "enabled": true,
  "order": 1,
  "commandIds": {
    "start": "id-do-comando-start",
    "stop": "id-do-comando-stop",
    "reset": "id-do-comando-reset"
  }
}
```

Os três vínculos são opcionais, mas cada ação deve apontar para um comando diferente e já existente na configuração de sinais.

## Alteração e remoção

- `PUT /api/ihm-machines/:ihmMachineId`: substitui nome, estado, ordem e vínculos da máquina.
- `DELETE /api/ihm-machines/:ihmMachineId`: remove somente o cadastro da IHM; não remove máquinas da linha, sinais ou comandos.

As operações de escrita exigem o cabeçalho `Authorization: Bearer <token>`, obtido por `POST /api/admin/sessions`.

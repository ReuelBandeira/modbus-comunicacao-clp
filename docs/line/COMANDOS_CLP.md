# Comandos operacionais da CLP

Os botões operacionais das telas **Máquinas** e **Teste da integração IFTS** usam registros configuráveis. O código lógico (`LINE_START`, `LINE_STOP`, `LINE_RESET`, por exemplo) identifica o comando sem espalhar endereços Modbus pelo frontend ou pelos controllers.

Cada comando define a CLP, o endereço físico e Modbus, o valor, o modo mantido ou pulsado, o sinal opcional de confirmação (ACK), o tempo limite, os intertravamentos, a aparência e o destino linha/máquina. A tela operacional nunca recebe um endereço digitado pelo operador.

Um comando também pode ser replicado para CLPs adicionais. A função Modbus, o endereço, o valor e o pulso são iguais em todos os destinos, e as escritas são tentadas em paralelo. Uma CLP offline gera aviso, mas não impede o envio às demais. Cada destino cria sua própria execução e auditoria; o ACK configurado pertence somente à CLP principal e as réplicas confirmam a comunicação pela escrita Modbus.

Quando não existe ACK na CLP, selecione **Sem confirmação · somente escrita**. Um comando mantido termina após a escrita Modbus; um comando pulsado termina somente depois de escrever o valor ativo, aguardar `pulseMs` e escrever o valor de retorno. Esse estado confirma a comunicação Modbus, não a execução física da lógica da CLP.

Todo pulso enviado pelo PCM possui duração mínima efetiva de **600 ms**. A interface e a API recusam novos valores menores, e o runtime eleva automaticamente configurações antigas para 600 ms durante a execução.

## Execução

1. O PCM cria uma execução idempotente em `pcm_plc_command_executions`.
2. Revalida os sinais usados como intertravamentos.
3. Executa o manipulador de negócio `before`, quando existir.
4. Escreve na CLP e, no modo pulso, retorna ao valor configurado.
5. Aguarda o sinal de ACK quando ele estiver configurado; sem ACK, confirma apenas a conclusão da escrita/pulso.
6. Executa o manipulador de negócio `after`, quando existir.
7. Grava o resultado final e o apresenta no histórico da tela.

Falha anterior à escrita é registrada como `failed`. Falha ou timeout depois de uma tentativa de escrita é `uncertain`, pois a CLP pode ter recebido o comando mesmo sem o PCM confirmar o estado final. Quando o comando está configurado sem sinal de ACK, essa incerteza permanece no histórico, mas não bloqueia o próximo comando. Com ACK configurado, novas escritas continuam bloqueadas até a reconciliação do estado real.

Nos comandos pulsados, o log diferencia a escrita do **valor ativo** da escrita de **retorno do pulso**. Em caso de falha, o registro mostra a etapa, o valor tentado, a função Modbus (`FC05` ou `FC16`) e o endereço Modbus. Uma escrita de retorno bem-sucedida também gera o evento `PLC_COMMAND_PULSE_RESET`.

Cada execução também gera um arquivo texto diário `plc-commands-AAAA-MM-DD.txt`. No aplicativo desktop ele fica, por padrão, em `Documentos/PCM-IHM/logs`; na API executada separadamente, em `logs` no diretório de trabalho. `PLC_COMMAND_LOG_DIR` permite escolher outra pasta. Cada linha é um JSON independente com solicitação, preflight, escrita, retorno do pulso, ACK, durações e resultado, sem credenciais.

## Pré-partida e liberação da bipagem

A tela **Entrada** exige uma pré-partida antes de aceitar a primeira bandeja. Ela verifica equipe mínima, Final de Linha,
Bridge do teste de memória e comunicação com todas as CLPs vinculadas ao comando START. O comando deve ter destino
**Linha** e usar `START`, `INICIAR`, `INICIO`, `LIGAR` ou `PARTIR` como palavra isolada no código ou no nome.

O preflight lê o endereço do comando em cada CLP sem escrever. O START só é enviado quando todos os checks passam;
diferentemente do acionamento operacional comum, sucesso parcial em réplicas não libera a bipagem. Para o teste de memória,
o PCM exige `stationReady=true`; se apenas o IFTS estiver fechado, chama `/ifts/start-auto-save-set`. Se o próprio Bridge estiver
offline, a operação permanece bloqueada até que a tarefa configurada no computador da estação o inicie. Consulte
[`IFTS_CSV_BRIDGE.md`](../integrations/IFTS_CSV_BRIDGE.md) para os detalhes da integração.

Uma transição confirmada com ação **Linha parou** volta a bloquear novas bipagens. Uma preparação de bandeja que já
estava em andamento permanece acessível para recuperação, sem descartar as leituras realizadas.

## Regras de negócio

`plc_only` executa a comunicação e a auditoria, sem alterar outros documentos. Uma ação que também precise fechar eventos, atualizar entidades ou disparar outro serviço deve ser implementada no backend como um `PlcBusinessActionHandler` e registrada ao criar `PlcSignalRuntime`. Dados executáveis ou nomes arbitrários de collections não devem ser armazenados no MongoDB.

Os métodos `before` e `after` separam a ordem da regra. Uma validação ou reserva necessária antes da CLP fica em `before`; alterações que só podem ocorrer após o ACK ficam em `after`. Se o `after` falhar, a execução permanece `uncertain` e exige reconciliação, evitando informar sucesso parcial.

## Regras acionadas por sinais

Um sinal monitorado pode executar uma regra interna quando muda de estado. O runtime considera somente transições confirmadas:
manter o valor em `1` durante vários ciclos de polling não repete a regra. A primeira leitura após iniciar o PCM apenas estabelece
a referência e não executa ações retroativas.

Para um sinal `LINHA_ATIVA`, configure:

- **Ao ficar ativo:** `Linha iniciou`;
- **Ao ficar inativo:** `Linha parou`;
- **Motivo no OEE:** motivo usado caso a desativação abra uma parada automática.

`Linha parou` abre uma parada de origem CLP. `Linha iniciou` encerra somente a parada aberta pelo mesmo sinal, sem fechar uma
parada manual ou pertencente a outro sinal. Cada execução fica em `pcm_plc_signal_action_executions` com estado `pending`,
`completed` ou `failed`.

## Segurança

Esta camada é controle operacional e não substitui relé de segurança, botão de emergência, intertravamento físico ou lógica certificada no CLP. START deve ser recusado também pelo CLP quando as condições físicas não estiverem seguras.

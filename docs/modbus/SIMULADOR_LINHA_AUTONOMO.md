# Simulador autônomo da linha M1 → M2 → M3 → M4

O simulador abre quatro servidores Modbus TCP e movimenta automaticamente cada bandeja pelas quatro estações. Por padrão, a M2 representa a estação de teste de memória integrada ao IFTS Bridge. Depois de iniciado, o único evento manual necessário é o bip no PCM.

## Iniciar

Na raiz do projeto:

```cmd
npm run simulate:line
```

Aguarde os quatro endpoints mostrarem `ONLINE` e digite:

```text
start
```

O `start` deve ser executado depois que o PCM e o IFTS Bridge estiverem abertos e com as integrações habilitadas.

## Configuração no PCM para teste local

| Máquina | IP | Porta | Unit ID | Protocolo |
| --- | --- | ---: | ---: | --- |
| M1 | `127.0.0.1` | 1502 | 1 | Estação 1 · Node envia QR |
| M2 | `127.0.0.1` | 1503 | 1 | Estação IFTS · QR de entrada e saída |
| M3 | `127.0.0.1` | 1504 | 1 | Estação 2–4 · CLP envia dados |
| M4 | `127.0.0.1` | 1505 | 1 | Estação 2–4 · CLP envia dados |

Mapa convencional usado pelas estações que não representam o IFTS:

```text
ENTRY_SEQUENCE: 0
SERIAL_LENGTH: 2
Início do SERIAL: 3
Registers do SERIAL: 32
POSITION_COUNT: 35
Início de POSITION_BITS: 36
Registers de POSITION_BITS: 4
Quantidade publicada pelas estações convencionais: 20 posições
Byte order: AB / Big Endian
Word order: High Word → Low Word
```

`ENTRY_SEQUENCE` é mantido no bloco por compatibilidade, mas é somente diagnóstico. Como a M1 recebe apenas o QR, a CLP não conhece a sequência interna criada pelo PCM. A decisão de aceitar uma bandeja utiliza o QR esperado e a ordem interna da fila.

A M1 e a estação IFTS utilizam `REQUEST_QR`, na Coil 0. A estação IFTS usa também as áreas descritas abaixo.

## Fluxo automático

```text
BIP no PCM
  ↓
M1 ativa REQUEST_QR
  ↓
PCM grava somente o QR em HR0–HR31 na M1
  ↓
M1 ativa CONFIRMAR_SAIDA, zera HR0–HR31 e depois retorna a Coil para FALSE
  ↓
M2 ativa M0; PCM grava o QR em D0–D14
  ↓
M2 baixa M0 e limpa D0–D14; PCM confirma a identificação pela queda de M0
  ↓
M2 ativa M23
  ↓
PCM inicia no Bridge o ciclo já associado à bandeja
  ↓
Simulador grava o CSV; Bridge o detecta e envia o resultado ao PCM
  ↓
PCM persiste as posições e pulsa M24 para informar o término
  ↓
M2 grava o QR em D21–D35 e ativa M1
  ↓
PCM valida o QR, persiste a passagem e pulsa M2
  ↓
M3 e M4 publicam seus dados; PCM persiste e zera cada mailbox como ACK
  ↓
Percurso concluído; simulador solicita o próximo bip
```

O simulador aguarda o ACK nas estações convencionais e a confirmação completa do IFTS na estação de memória antes de publicar na seguinte. QR e `ENTRY_SEQUENCE` são preservados durante todo o percurso.

## Estação IFTS simulada

O padrão é usar M2 na porta 1503:

| Direção | Endereço | Ação |
|---|---:|---|
| Simulador → PCM | `M0` | Solicita o QR da bandeja |
| PCM → simulador | `D0–D14` | Entrega o QR de entrada |
| Simulador → PCM | `M23` | Inicia o IFTS após a identificação |
| PCM → simulador | `M24` | Pulso que informa o término do teste |
| Simulador → PCM | `D21–D35` e `M1` | Publica o QR de saída |
| PCM → simulador | `M2` | Confirma a passagem persistida |

Configure o PCM com:

```env
IFTS_MEMORY_MACHINE_ID=m2
IFTS_EXPECTED_POSITION_COUNT=20
IFTS_BRIDGE_BASE_URL=http://127.0.0.1:8787
IFTS_BRIDGE_API_KEY=123
```

Em **Integração CLP → Sinais monitorados**, cadastre na CLP da M2:

- Coil 23, ativo em `1`, ação ao ficar ativo `IFTS · START da estação`.

Em **Comandos operacionais**, cadastre `IFTS_RESULT_PASS` e `IFTS_RESULT_FAIL` como pulso na Coil 24 da mesma CLP, sem ACK. Os dois códigos usam o mesmo coil; PASS/FAIL detalhado continua registrado no PCM. `M24` não confirma passagem.

O simulador consulta `/health` e `/monitoring` do Bridge após o START e grava vinte linhas no diretório de log informado por ele. Não chama `POST /cycle/finish`: a finalização continua automática pela detecção do CSV. Se o Bridge ainda não estiver pronto, a M2 permanece ocupada e tenta novamente a cada segundo.

As opções abaixo permitem alterar o mapa do simulador:

```env
SIM_IFTS_STATION=2
SIM_IFTS_RESULT_SOURCE=simulated
SIM_IFTS_START_COIL=23
SIM_IFTS_RESULT_COIL=24
SIM_IFTS_QR_REGISTERS=15
SIM_IFTS_OUTPUT_START=21
SIM_IFTS_BRIDGE_URL=http://127.0.0.1:8787
SIM_IFTS_BRIDGE_API_KEY=123
# Opcional: força uma pasta em vez da retornada por /monitoring
SIM_IFTS_LOG_ROOT=C:\caminho\para\Log
```

O comando `status` exibe os sinais de entrada, START, término e saída, além do estado do teste, da URL do Bridge e da pasta de CSV usada como fallback.

### M1 simulada e M2 com IFTS real

Para simular somente a entrada/M1 e usar o equipamento real na M2:

```env
IFTS_MEMORY_MACHINE_ID=m2
SIM_IFTS_STATION=2
SIM_IFTS_RESULT_SOURCE=real
```

Nesse modo, o simulador não cria CSV. Ao receber a bandeja da M1, a M2 primeiro executa o handshake `M0/D0–D14` e só então ativa `M23`. O PCM inicia o Bridge usando as configurações `IFTS_BRIDGE_*` já existentes no `.env`; o IFTS real executa o teste e grava o CSV. Depois do pulso em `M24`, o simulador publica a saída em `D21–D35/M1` e só encaminha a bandeja à M3 após receber `M2`.

`SIM_IFTS_STATION` tem precedência; quando ela não é informada, o simulador também reconhece `IFTS_MEMORY_MACHINE_ID=m2`, `m3` ou `m4`.

No PCM, uma diferença em `ENTRY_SEQUENCE` não reprova a bandeja. Uma diferença de QR bloqueia a estação, mantém o mailbox preenchido e não libera a próxima máquina.

### Ordem de bytes por estação

Cada CLP pode usar sua própria ordem de bytes. O simulador aceita configuração individual, com `SIM_BYTE_ORDER` como valor geral de fallback:

```powershell
$env:SIM_M1_BYTE_ORDER = 'le'
$env:SIM_M2_BYTE_ORDER = 'be'
$env:SIM_M3_BYTE_ORDER = 'be'
$env:SIM_M4_BYTE_ORDER = 'be'
npm run simulate:line
```

Essa configuração corresponde a M1 em `BA` e M2–M4 em `AB`. O comando `status` mostra a ordem efetiva de cada estação.

Também pode ser configurado no terminal antes do `start`:

```text
bytes m1 ba
bytes m2 ab
bytes m3 ab
bytes m4 ab
```

## Compatibilidade atual e futura

O simulador possui dois perfis, mas ambos usam exatamente o mesmo mapa Modbus, as mesmas Coils e o mesmo conteúdo dos Holding Registers.

```text
perfil atual
perfil robusto
```

- `atual`: ao concluir a M1, a CLP ativa a Coil 1 e zera o QR no mesmo momento. Reproduz o comportamento utilizado atualmente.
- `robusto`: a CLP ativa a Coil 1, aguarda `SIM_CLEAR_MS` e só depois zera o QR. Esse perfil comprova a regra em duas fases: a próxima estação somente é liberada depois da memória zerada.

O perfil pode ser definido antes de iniciar:

```powershell
$env:SIM_COMPATIBILITY_PROFILE = 'hardened'
$env:SIM_CLEAR_MS = '1500'
npm run simulate:line
```

A mudança de perfil não altera FC01, FC03, FC16, endereços, byte order, word order ou tamanho do mailbox. Portanto, o mesmo simulador serve para comparar a implementação atual com o endurecimento futuro.

## Injeção de falhas

As falhas são ativadas e removidas sem encerrar o simulador:

```text
falha <m1|m2|m3|m4> <tipo> <valor>
```

| Tipo | Máquinas | Exemplo | Comportamento esperado |
| --- | --- | --- | --- |
| `rede` | M1–M4 | `falha m2 rede on` | Fecha a porta TCP e derruba conexões existentes, como na remoção do cabo |
| `comunicacao` | M1–M4 | `falha m2 comunicacao on` | Mantém a porta aberta, mas responde erro Modbus de equipamento |
| `atraso` | M2–M4 | `falha m3 atraso 10000` | Atrasa a publicação do mailbox em milissegundos |
| `parcial` | Estações convencionais M2/M4 | `falha m2 parcial on` | Publica um mailbox incompleto e estável |
| `sequencia` | Estações convencionais M2/M4 | `falha m2 sequencia 1` | Soma o valor informado à sequência publicada |
| `qr` | Estações convencionais M2/M4 | `falha m4 qr -DIVERGENTE` | Acrescenta um sufixo ao QR publicado |
| `ack` | Estações convencionais M2/M4 | `falha m2 ack on` | Rejeita a tentativa do PCM de zerar o mailbox |
| `saida` | M1 | `falha m1 saida on` | Não ativa a Coil 1 após receber o QR |
| `limpeza` | M1 | `falha m1 limpeza on` | Ativa a Coil 1, mas mantém o QR na memória |
| `coil-presa` | M1 | `falha m1 coil-presa on` | Mantém a Coil 1 em TRUE depois da saída |

Valores booleanos usam `on` e `off`. Para remover desvios numéricos ou de QR:

```text
falha m3 sequencia 0
falha m4 qr off
falha m3 atraso 0
```

Para consultar ou desativar todas as injeções:

```text
falhas
falhas limpar
```

`falhas limpar` não apaga um mailbox que já foi publicado. Isso é proposital: permite observar se o PCM consegue reconciliar o dado existente. Para limpar toda a bancada, execute `stop`, depois `reset`.

## Roteiro de validação

### Fluxo atual sem falhas

```text
perfil atual
falhas limpar
reset
start
```

Após cada solicitação da M1, faça um bip no PCM. Confirme que as quatro steps terminam em sequência.

### Perda e recuperação de comunicação

```text
falha m2 rede on
start
```

Faça um bip e aguarde a bandeja chegar à M2. O PCM deve manter a step pendente e indicar indisponibilidade. Depois:

```text
falha m2 rede off
```

O mesmo mailbox deve ser processado uma única vez, sem novo bip e sem duplicar a step.

### ACK incerto nas M2–M4

```text
falha m3 ack on
```

A M3 publica e mantém o mailbox ocupado. Depois de `falha m3 ack off`, o PCM reconcilia o mesmo resultado, zera a memória e somente após confirmar o bloco vazio libera a M4.

### Bandeja fora de sequência

```text
falha m2 sequencia 1
```

Esse valor é registrado somente para diagnóstico. Se o QR estiver correto, a inspeção é aceita usando a bandeja que o PCM reservou internamente para a estação.

### QR divergente

```text
falha m2 qr -ERRO
```

O fluxo bloqueia por falha de protocolo, preservando a bandeja esperada. A step permanece pendente, não envia o ACK de zeros, não reprova os chips e não libera a máquina seguinte.

Para corrigir o conteúdo sem perder a bandeja pendente:

```text
falha m2 qr off
republicar m2
```

O simulador reescreve o mailbox da mesma bandeja. Depois de duas leituras estáveis com o QR correto, o PCM remove o bloqueio e continua o percurso.

### Confirmação sem limpeza da M1

```text
perfil robusto
falha m1 limpeza on
```

A Coil 1 será ativada, mas o QR continuará nos HRs. A M2 não será liberada. Para continuar:

```text
falha m1 limpeza off
```

### Demora operacional

```text
falha m4 atraso 30000
```

Permite validar o futuro aviso de demora sem simular uma desconexão. A bandeja deve permanecer em andamento até a publicação real.

## Cenários automáticos das posições

Com `aleatorio on`, um único `start` percorre cinco cenários, um por bandeja:

1. 20 posições aprovadas em M2, M3 e M4 (`100% aprovada`);
2. uma posição reprovada em uma estação aleatória;
3. a mesma posição reprovada em duas estações distintas;
4. a mesma posição reprovada nas três estações M2, M3 e M4;
5. duas posições distintas reprovadas em duas estações distintas.

Depois do quinto cenário, o ciclo recomeça pela bandeja 100% aprovada. As posições e estações são sorteadas dentro de cada cenário. Assim todos os resultados podem ser testados mantendo o mesmo processo do simulador aberto.

O terminal informa antecipadamente a escolha, por exemplo:

```text
[M1] cenário aleatório: 100% aprovada
[M1] cenário aleatório: uma posição em uma estação; falhas: M3 posição 6
[M1] cenário aleatório: a mesma posição nas três estações; falhas: M2 posição 14 e M3 posição 14 e M4 posição 14
```

Para desligar ou religar durante a execução:

```text
aleatorio off
aleatorio on
```

Também é possível iniciar com o modo aleatório desligado:

```powershell
$env:SIM_RANDOM_FAILURE = 'false'
npm run simulate:line
```

## Posições manuais dos chips

Com `aleatorio off`, M2, M3 e M4 usam os perfis manuais. O perfil inicial contém vinte chips aprovados:

```text
[true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true]
```

Para simular falha no terceiro chip da M3, antes do `start` execute:

```text
posicoes m3 1,1,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1
```

Outros exemplos:

```text
posicoes m2 1,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1
posicoes m4 true,true,true,false,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true
```

O índice mostrado na tela do PCM começa em 1. Assim, o terceiro valor `false` aparece como `Chips com falha: 3`.

O perfil configurado é usado nas próximas bandejas até que seja alterado. O comando exige exatamente 20 valores. Com o modo aleatório ligado, os perfis manuais ficam preservados, mas os cinco cenários automáticos são usados.

## Comandos

| Comando | Ação |
| --- | --- |
| `start` | Inicia a solicitação e o encadeamento automático |
| `stop` | Impede que uma nova bandeja seja solicitada |
| `status` | Mostra memória, estado e sequência de cada estação |
| `perfil atual` | Usa Coil 1 e limpeza simultâneas na M1 |
| `perfil robusto` | Separa a confirmação da saída e a limpeza da M1 |
| `bytes m1 ba` | Configura individualmente a ordem dos bytes da estação |
| `aleatorio on` | Reinicia e ativa o ciclo dos cinco cenários automáticos |
| `aleatorio off` | Desativa os cenários e utiliza os perfis manuais |
| `posicoes m2 <20 valores>` | Configura as 20 posições da M2 |
| `posicoes m3 <20 valores>` | Configura as 20 posições da M3 |
| `posicoes m4 <20 valores>` | Configura as 20 posições da M4 |
| `falha <máquina> <tipo> <valor>` | Ativa, altera ou remove uma falha controlada |
| `falhas` | Exibe as injeções configuradas |
| `falhas limpar` | Desativa todas as injeções sem apagar os mailboxes |
| `republicar m2` | Reescreve a bandeja pendente usando as falhas atualmente configuradas |
| `reset` | Zera as quatro memórias; exige fluxo parado |
| `quit` | Encerra os quatro servidores |

## Tempos

Valores padrão:

```text
Processamento da M1: 800 ms
Transferência entre estações: 800 ms
```

Podem ser alterados antes da execução:

```powershell
$env:SIM_PROCESS_MS = '1200'
$env:SIM_TRANSFER_MS = '1000'
npm run simulate:line
```

## IPs diferentes

Em produção, cada CLP pode usar seu próprio IP e a mesma porta 502. Para um computador com os IPs configurados nas interfaces de rede:

```text
SIM_M1_HOST=192.168.1.51  SIM_M1_PORT=502
SIM_M2_HOST=192.168.1.52  SIM_M2_PORT=502
SIM_M3_HOST=192.168.1.53  SIM_M3_PORT=502
SIM_M4_HOST=192.168.1.54  SIM_M4_PORT=502
```

Para o teste no mesmo computador, mantenha `127.0.0.1` e as portas 1502–1505.

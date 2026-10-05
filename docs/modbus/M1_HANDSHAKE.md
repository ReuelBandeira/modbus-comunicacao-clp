# Protocolo Modbus TCP da linha (4 estações)

O Node é **cliente Modbus TCP** nas quatro estações. Cada CLP disponibiliza seu próprio IP, porta, Unit ID, uma área contínua de holding registers e, somente na estação 1, uma Coil de chegada. Não é necessário abrir uma porta Modbus no computador do Node.

## Mapa do mailbox (offset base zero)

| Offset relativo | Tipo | Conteúdo |
| ---: | --- | --- |
| 0–1 | UINT32 | `ENTRY_SEQUENCE`, na ordem de words configurada |
| 2 | UINT16 | `SERIAL_LENGTH`, quantidade de bytes UTF-8 |
| 3–34 | 32 × UINT16 | `SERIAL`, dois bytes por register, com zeros no restante |
| 35 | UINT16 | `POSITION_COUNT` |
| 36–39 | 4 × UINT16 | `POSITION_BITS`, bit 0 primeiro (até 64 posições) |

O endereço inicial é configurável. O exemplo usa HR 0–39. A área deve ser contínua e ter no máximo 123 registers para permitir leitura FC03 e escrita/limpeza FC16 em uma única operação.

## Estação 1 — Node entrega somente o QR

1. A CLP detecta a chegada da bandeja e muda `REQUEST_QR` de `FALSE` para `TRUE`.
2. O Node lê a Coil por FC01 e confirma que os 32 registers reservados ao serial estão em zero.
3. O Node grava somente o QR em uma única FC16, começando no endereço configurado em `qrEntrySequenceRegister`.
4. Cada register contém dois bytes UTF-8 e os registers não utilizados ficam zerados. Não são enviados `ENTRY_SEQUENCE` nem `SERIAL_LENGTH`.
5. A CLP lê e copia os dados internamente. Enquanto processa, não deve alterar parcialmente o mailbox.
6. Quando a bandeja passar fisicamente, a CLP muda `CONFIRMAR_SAIDA` (Coil 1 por padrão) de `FALSE` para `TRUE`.
7. O Node persiste o resultado `OK`, mas mantém a etapa e a próxima estação bloqueadas.
8. A própria CLP zera os 32 registers como parte de seu fluxo; o Node não escreve zeros na M1.
9. Depois de ler todo o bloco zerado, o Node conclui a etapa e libera a estação 2.
10. A CLP retorna `CONFIRMAR_SAIDA` e `REQUEST_QR` para `FALSE` antes de solicitar a próxima bandeja.

Com o endereço inicial padrão `0`, a M1 recebe o QR em `HR0–HR31`. Os mapas de sequência, tamanho e posições abaixo continuam sendo usados por M2, M3 e M4.

| Sinal M1 | Endereço padrão | Sentido |
| --- | ---: | --- |
| `REQUEST_QR` | Coil 0 | CLP → Node |
| `CONFIRMAR_SAIDA` | Coil 1 | CLP → Node |
| QR | HR0–HR31 | Node → CLP |

### Célula paralela na Estação 1

Quando `Bandejas simultâneas na célula` for maior que `1`, a Estação 1 usa áreas separadas para o QR de entrada e o QR de saída. Esse modo atende uma esteira que distribui bandejas entre máquinas internas sem comunicação direta dessas máquinas com o PCM.

1. A CLP muda `M0 / REQ_INFO_BANDEJA` de `FALSE` para `TRUE` e o Node grava o próximo QR em `D0–D14`.
2. A CLP copia o QR para sua memória interna e retorna `M0` para `FALSE`.
3. A queda de `M0` confirma a captura para o Node; a limpeza de `D0–D14` pertence exclusivamente à CLP.
4. Enquanto houver capacidade, uma nova borda de `M0` entrega a bandeja seguinte.
5. Na saída, a CLP grava o QR da bandeja em `D21–D35` e mantém `M1 / QR_SAIDA_PRONTO` em `TRUE`.
6. O Node lê duas vezes o mesmo QR, confere se é a bandeja mais antiga, persiste a passagem e ativa `M2 / ACK_SAIDA`.
7. A CLP baixa `M1`, limpa `D21–D35` e, quando configurada como responsável pelo ACK, também limpa `M2`.

| Área padrão | Sentido | Função |
| --- | --- | --- |
| `M0` | CLP → Node | Solicitar QR de entrada |
| `D0–D14` | Node → CLP | QR de entrada |
| `M1` | CLP → Node | QR de saída pronto |
| `D21–D35` | CLP → Node | QR da bandeja na saída |
| `M2` | Node → CLP | Confirmação após persistência: pulso da IHM ou `TRUE` limpo pela CLP, conforme configuração |

A CLP deve manter `M1` ativo e `D21–D35` estável até receber a confirmação em `M2`. No modo **CLP limpa**, a IHM escreve `M2=TRUE` e a CLP deve retornar `M2=FALSE` antes da próxima saída; enquanto isso não acontecer, outra confirmação fica bloqueada. Um QR desconhecido ou fora da ordem não recebe confirmação e bloqueia a passagem para evitar concluir a bandeja errada.

## Estação IFTS — QR na entrada e na saída

A estação IFTS usa o mesmo princípio de correlação por QR da célula paralela, mas com capacidade única e com o resultado vindo do Bridge.

1. A CLP ativa `M0` e o Node grava o QR em `D0–D14`.
2. A CLP guarda o QR e baixa `M0`; a queda de `M0` confirma a identificação. A própria CLP limpa `D0–D14`.
3. Somente então a CLP ativa `M23` para iniciar o IFTS.
4. Após persistir PASS ou FAIL, o Node pulsa `M24` para informar que o teste terminou. Esse pulso não confirma passagem.
5. Na saída, a CLP grava o QR em `D21–D35` e ativa `M1`.
6. O Node valida o QR e a existência do resultado, persiste a passagem e confirma em `M2` conforme o modo configurado.
7. A CLP baixa `M1` e limpa `D21–D35`.

| Área padrão | Sentido | Função |
| --- | --- | --- |
| `M0` | CLP → Node | Solicitar QR de entrada |
| `D0–D14` | Node → CLP | QR de entrada |
| `M23` | CLP → Node | Iniciar teste IFTS |
| `M24` | Node → CLP | Teste terminado |
| `M1` | CLP → Node | QR de saída pronto |
| `D21–D35` | CLP → Node | QR lido na saída |
| `M2` | Node → CLP | ACK da passagem persistida |

## Estações convencionais — CLP devolve o QR lido

1. Com o mailbox totalmente zerado, a CLP grava em uma única atualização `ENTRY_SEQUENCE`, `SERIAL_LENGTH`, `SERIAL`, `POSITION_COUNT` e `POSITION_BITS`.
2. O Node exige duas leituras idênticas para não consumir uma escrita parcial.
3. O Node compara o QR com a próxima bandeja liberada pela estação anterior. `ENTRY_SEQUENCE` é somente diagnóstico.
4. QR divergente bloqueia a etapa como falha de comunicação; não reprova o produto e não envia ACK.
5. O Node exige exatamente a quantidade de posições configurada (20 por padrão). Quantidade diferente também bloqueia sem reprovar.
6. Com QR e estrutura válidos, o Node persiste `OK` ou `NÃO` conforme os bits das posições.
7. Somente depois de persistir, o Node zera todo o mailbox por FC16.
8. A etapa e a próxima estação só são liberadas depois que uma nova FC03 confirma o bloco totalmente zerado.

## Estações 2, 3 e 4 — QR e posições

Nas três estações, `POSITION_COUNT` deve ser exatamente igual ao valor configurado no PCM (20 por padrão). Cada posição ocupa um bit: posição 0 no bit 0 do primeiro register, posição 15 no bit 15, posição 16 no bit 0 do segundo register. O resultado é `OK` somente quando o QR confere e todas as posições são `TRUE`. O array completo é armazenado no histórico da step.

## Regras obrigatórias para a automação

- Em `D0–D14` das estações com entrada por `M0`, a borda `M0: FALSE → TRUE` autoriza o Node a sobrescrever a área com o novo QR.
- Nessas entradas, somente a queda `M0: TRUE → FALSE` confirma a captura; o conteúdo ou a limpeza de `D0–D14` não participa da confirmação.
- A CLP é responsável por limpar `D0–D14`; o Node não escreve zeros nessa área durante o ciclo normal.
- Nos mailboxes de resultado das estações convencionais, um produtor só escreve quando o bloco inteiro está zerado.
- O conteúdo dos mailboxes de resultado fica estável até o consumidor zerar todo o bloco.
- Não usar apenas o serial zerado como vazio: vazio significa **todos os registers em zero**.
- `POSITION_COUNT` permite que um array com todas as posições `FALSE` continue sendo uma mensagem válida.
- Fora da área de entrada `D0–D14` autorizada por `M0`, o Node não sobrescreve mailbox ocupado.
- Após falha ou reinício, não é necessário reset manual: o Node reconcilia o conteúdo atual. Não force zero enquanto a bandeja ainda não tiver passado.
- A tela de configuração define a quantidade exata de posições e o tempo máximo de cada fase. Demora excessiva bloqueia e sinaliza a etapa sem reprovar o produto.
- Perda de conexão Modbus aparece no acompanhamento; a operação permanece pendente e é retomada após a comunicação voltar.
- Os endereços da aplicação são base zero. Confirme com a automação a conversão de referências como `40001`.

## Simulação da estação 1

Execute `npm run simulate:m1`. O simulador abre `127.0.0.1:1502`, Unit ID 1, ativa a Coil 0, recebe HR 0–39 e zera o bloco após 500 ms para confirmar a passagem.

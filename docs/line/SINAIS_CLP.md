# Sinais e comandos da CLP

O módulo é independente do mailbox de bandejas. Não reutilize HR0–39 ou Coils 0–2 do
handshake sem validar o mapa com a automação.

## CLPs

A conexão Modbus é cadastrada separadamente das estações de produção. Cada CLP possui nome,
IP, porta, Unit ID, timeout e status. Sinais e comandos referenciam uma CLP por `plcId`;
alterar o IP nesse cadastro atualiza todos os pontos associados sem alterar as máquinas.

## Sinais monitorados

Cada sinal informa a CLP, o endereço usado na programação (por exemplo `D10`), o endereço
Modbus efetivo, tipo de leitura, bit opcional, valor que ativa e intervalo de polling.

Para disparar apenas quando `D10 = 1`, use endereço Modbus `10`, bit vazio e valor que ativa
`1`, depois de confirmar essa equivalência no mapa do CLP Delta.

Tipos disponíveis:

- Coil: FC01;
- Entrada discreta: FC02;
- Holding Register: FC03;
- Input Register: FC04.

`pause_entry` e `block_line` impedem novas entradas e novo avanço lógico enquanto o sinal
estiver ativo. Eles não substituem circuito de segurança, relé ou lógica de safety da CLP.

Vários sinais podem ser marcados como **participantes do status agregado da linha**. Para quatro
CLPs com o mesmo registrador `D20`, cadastre um sinal em cada CLP e use o endereço Modbus `20`.
A interface preenche a tabela sugerida: `0 = Linha parada`, `1 = Linha em produção`,
`2 = Alerta da linha` e `3 = Linha em emergência`.

A barra global avalia todos os participantes em conjunto. Qualquer valor vermelho (emergência)
tem prioridade, seguido por qualquer valor amarelo (alerta). Se todos tiverem o mesmo valor, a
barra mostra o estado correspondente. Valores normais diferentes, como `0` e `1`, aparecem como
**Transição/divergência** em azul. Ausência de leitura, erro, leitura desatualizada ou valor não
mapeado aparece em vermelho e bloqueia novas entradas. Uma emergência conhecida continua tendo
prioridade visual mesmo que outra CLP esteja sem comunicação. Cada valor também permite escolher
na interface se bloqueia novas entradas; o padrão bloqueia o valor `3`.

O mesmo sinal monitorado pode também ser marcado como **status da máquina** e vinculado a uma
máquina IHM. A tabela padrão usa `0 = Máquina parada`, `1 = Em produção`, `2 = Em alerta` e
`3 = Em emergência`, mas textos e cores podem ser alterados na interface. O estado aparece no
cartão da máquina com o valor e o horário da leitura. Falha de comunicação e leitura desatualizada
são indicadas em vermelho. A mesma leitura de `D20` pode alimentar simultaneamente o status da
máquina, o status agregado da linha e o catálogo de alarmes; isso não cria leituras Modbus extras.

## Alarmes

O catálogo de alarmes transforma valores dos sinais já monitorados em ocorrências persistidas, sem
abrir outra conexão Modbus. Cada cadastro possui código, título, máquina IHM opcional, gravidade,
valores de ativação, descrição, orientação ao operador, atrasos de ativação e normalização, exigência
de reconhecimento e bloqueio de novas entradas.

Enquanto a condição permanecer ativa existe somente uma ocorrência aberta. O reconhecimento registra
data e responsável, mas não normaliza o alarme; o encerramento ocorre quando o valor da CLP deixa a
condição configurada. Erros de comunicação não encerram ocorrências abertas. A tela de máquinas mostra
os alarmes gerais no painel superior e os alarmes vinculados também no cartão da respectiva máquina.

Para um registrador que contém códigos, configure vários valores no mesmo alarme ou crie alarmes com
códigos distintos. Para um registrador por bits, cadastre o bit como sinal monitorado e use `1` como
valor de ativação. Alarmes da aplicação não substituem circuito, relé ou programa de segurança da CLP.

## OEE

`record_stop` abre uma parada quando o sinal fica ativo e encerra quando retorna ao normal.
O cadastro exige um motivo ativo. A rotina fecha somente a parada aberta pelo próprio sinal;
uma parada manual ou aberta por outro sinal é preservada.

Quando dois ou mais sinais `record_stop` ficam ativos ao mesmo tempo, o OEE mantém uma única
parada da linha e registra todos como participantes. A normalização de um sinal apenas o remove
da ocorrência; a parada é encerrada somente depois que o último sinal participante normalizar.
Paradas manuais continuam protegidas e não são incorporadas nem encerradas por sinais da CLP.

## Comandos operacionais

Comandos escrevem Coil (FC05) ou Holding Register (FC16) e exigem um sinal de confirmação
da mesma CLP. A escrita Modbus isolada não é considerada confirmação física.

Somente ADMIN pode cadastrar, remover ou executar comandos. Antes do uso real, alinhe com a
automação o comando, ACK, valor ativo, timeout e comportamento após reinício.

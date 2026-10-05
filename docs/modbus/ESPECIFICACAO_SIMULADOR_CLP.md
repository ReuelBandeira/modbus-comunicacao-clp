# Especificação para desenvolvimento do simulador das CLPs

## 1. Objetivo

Este documento descreve a comunicação que o simulador deve implementar para reproduzir as quatro CLPs da linha.

A aplicação PCM/Node é **cliente Modbus TCP**. Cada CLP simulada é um **servidor Modbus TCP**, com IP, porta, Unit ID e memória próprios.

Não existe servidor Modbus no Node e o simulador não deve tentar conectar nas antigas portas de memória do Node.

## 2. Conexões sugeridas para desenvolvimento

| Estação | IP | Porta | Unit ID |
| --- | --- | ---: | ---: |
| Estação 1 | `127.0.0.1` | 1502 | 1 |
| Estação 2 | `127.0.0.1` | 1503 | 1 |
| Estação 3 | `127.0.0.1` | 1504 | 1 |
| Estação 4 | `127.0.0.1` | 1505 | 1 |

Esses valores são sugestões. Em produção, a aplicação utilizará o endereço configurado para cada máquina.

## 3. Funções Modbus utilizadas

| Função | Uso |
| --- | --- |
| FC01 — Read Coils | Node consulta a chegada na estação 1 |
| FC03 — Read Holding Registers | Node lê o mailbox das quatro estações |
| FC16 — Write Multiple Registers | Node escreve o QR na estação 1 ou limpa o mailbox nas estações 2–4 |

Não são utilizados sinais `QR_READY`, `QR_ACK`, `RESULT_READY` ou `RESULT_ACK`.

O handshake é realizado pelo conteúdo do mailbox: ocupado quando existe conteúdo e confirmado quando todo o bloco volta a zero.

## 4. Mapa padrão do mailbox

Os endereços são offsets base zero.

| Offset relativo | Quantidade | Tipo | Conteúdo |
| ---: | ---: | --- | --- |
| 0 | 2 | UINT32 | `ENTRY_SEQUENCE` |
| 2 | 1 | UINT16 | `SERIAL_LENGTH` em bytes UTF-8 |
| 3 | 32 | UINT16[] | `SERIAL` / QR code |
| 35 | 1 | UINT16 | `POSITION_COUNT` |
| 36 | 4 | UINT16[] | `POSITION_BITS` |
| 0–39 | 40 | UINT16[] | Mailbox completo |

O endereço inicial pode ser alterado no cadastro, mas os campos precisam formar um único bloco contínuo. O bloco deve possuir no máximo 123 Holding Registers.

## 5. Codificação

### 5.1 ENTRY_SEQUENCE

- Inteiro sem sinal de 32 bits.
- Ocupa dois Holding Registers.
- Padrão: High Word seguida da Low Word.

Exemplo para sequência `1`:

```text
HR0 = 0
HR1 = 1
```

### 5.2 SERIAL_LENGTH

Quantidade de bytes UTF-8 utilizados pelo QR code. Não é quantidade de caracteres.

### 5.3 SERIAL

- Texto codificado em UTF-8.
- Dois bytes por Holding Register.
- Padrão `AB`: byte alto primeiro.
- Registers não utilizados devem permanecer zerados.

Exemplo para `ABC`:

```text
HR3 = 0x4142
HR4 = 0x4300
```

### 5.4 POSITION_BITS

As posições são empacotadas do bit menos significativo para o mais significativo:

```text
posição 0  = bit 0 do primeiro register
posição 15 = bit 15 do primeiro register
posição 16 = bit 0 do segundo register
```

Exemplo:

```text
Posições: [TRUE, FALSE, TRUE]
POSITION_COUNT = 3
Primeiro POSITION_BITS = 0b0000000000000101
```

Com quatro registers podem ser informadas até 64 posições.

## 6. Identificação de mailbox vazio

O mailbox somente está vazio quando **todos os registers do bloco estiverem zerados**.

```text
HR0 até HR39 = 0
```

Não verificar somente o tamanho, o serial ou o primeiro register.

`POSITION_COUNT` permite distinguir um mailbox vazio de uma mensagem válida em que todas as posições são `FALSE`.

## 7. Estação 1 — Node envia o QR

### 7.1 Sinal de chegada

A estação 1 possui `REQUEST_QR` na Coil 0 e `CONFIRMAR_SAIDA` na Coil 1.

Uma nova solicitação é reconhecida pela borda:

```text
FALSE → TRUE
```

Não manter a Coil permanentemente em `TRUE` entre duas bandejas.

### 7.2 Fluxo

1. O mailbox está totalmente zerado.
2. O operador aciona `Simular chegada da bandeja`.
3. O simulador produz uma borda `REQUEST_QR: FALSE → TRUE`.
4. O Node reserva o próximo serial da fila.
5. O Node grava somente o `SERIAL` em HR0–HR31 por FC16.
6. O simulador copia o serial para sua memória interna.
7. O simulador coloca `REQUEST_QR = FALSE`.
8. O operador aciona `Confirmar saída`.
9. O simulador produz `CONFIRMAR_SAIDA: FALSE → TRUE` e zera HR0–HR31.
10. O Node detecta a Coil 1 e persiste o resultado `OK`, mas mantém a estação 2 bloqueada.
11. O Node confirma por FC03 que HR0–HR31 estão zerados e somente então conclui a step e libera a estação 2.
12. O simulador retorna `CONFIRMAR_SAIDA = FALSE` antes do próximo ciclo.

### 7.3 Botão Simular chegada

```text
se mailbox não estiver zerado:
    informar "ciclo anterior pendente"
senão:
    REQUEST_QR = FALSE
    produzir borda REQUEST_QR = TRUE
```

### 7.4 Botão Confirmar saída

```text
se ainda não recebeu o serial:
    informar erro
senão:
    REQUEST_QR = FALSE
    CONFIRMAR_SAIDA = TRUE
    zerar HR0 até HR31
```

A borda da Coil 1 confirma a passagem física. A limpeza do bloco é responsabilidade da CLP; o Node não escreve os zeros na M1.

## 8. Estação 2 — CLP envia o QR lido

### 8.1 Fluxo

1. O simulador aguarda o mailbox ficar totalmente zerado.
2. Recebe o QR e a sequência da bandeja simulada.
3. Publica, de forma estável:
   - `ENTRY_SEQUENCE`;
   - `SERIAL_LENGTH`;
   - `SERIAL`;
   - `POSITION_COUNT`, exatamente igual à quantidade configurada no PCM (20 por padrão);
   - `POSITION_BITS`, com uma posição por chip da bandeja.
4. O Node realiza duas leituras FC03 idênticas.
5. O Node compara o QR com a próxima bandeja esperada; a sequência recebida é somente diagnóstico.
6. O Node valida que `POSITION_COUNT` seja exatamente a quantidade configurada (20 por padrão) e persiste `OK` ou `NÃO`.
7. Somente depois da persistência, o Node zera o mailbox por FC16.
8. O Node relê o bloco; somente após confirmar todos os registers em zero conclui a step e libera a próxima estação.
9. O simulador interpreta o bloco zerado como ACK e permite a próxima bandeja.

### 8.2 Resultado calculado pelo Node

```text
OK = QR recebido igual ao esperado
     E sequência recebida igual à esperada
```

Qualquer divergência produz resultado `NÃO`. O valor recebido fica registrado no histórico da step.

## 9. Estações 2, 3 e 4 — QR e posições

As três estações informam:

- `POSITION_COUNT`, exatamente igual à quantidade configurada no PCM (20 por padrão);
- `POSITION_BITS`, com o estado de cada posição.

O resultado será `OK` somente quando:

```text
QR recebido == QR esperado
E ENTRY_SEQUENCE recebida == sequência esperada
E POSITION_COUNT > 0
E todas as posições == TRUE
```

Caso contrário, o Node grava `NÃO`.

O histórico da step contém:

- QR recebido;
- sequência recebida;
- resultado do match do QR;
- resultado do match da sequência;
- quantidade de posições;
- array completo de `TRUE`/`FALSE`.

Depois de persistir, o Node zera todo o mailbox como ACK.

## 10. Regras obrigatórias

1. Nunca sobrescrever um mailbox ocupado.
2. Um produtor somente escreve quando todos os registers estiverem zerados.
3. Manter o conteúdo estável até o consumidor zerar todo o bloco.
4. Não publicar duas bandejas no mesmo mailbox.
5. Não alterar apenas parte do bloco enquanto o consumidor estiver lendo.
6. Manter a mesma `ENTRY_SEQUENCE` durante todo o percurso da bandeja.
7. Nas estações 2–4, o bloco zerado pelo Node é o ACK.
8. Na estação 1, o bloco zerado pela CLP é a confirmação de passagem.
9. QR e sequência precisam pertencer à mesma bandeja.

## 11. Operação contínua

Cada estação possui conexão e mailbox independentes. É permitido haver várias bandejas simultaneamente na linha:

```text
Sequência 101 → estação 4
Sequência 102 → estação 3
Sequência 103 → estação 2
Sequência 104 → estação 1
Sequência 105 → fila de entrada
```

O simulador deve manter uma máquina de estados separada para cada estação.

## 12. Recuperação após reinício

### Estação 1 com mailbox preenchido

O Node recupera a operação e continua aguardando a Coil 1 e a limpeza feita pela CLP. O simulador não deve limpar uma bandeja que ainda não passou.

### Estações 2–4 com mailbox preenchido

O Node relê o conteúdo, verifica a persistência e zera o mailbox sem duplicar a step.

### Mailbox parcialmente preenchido

É erro de protocolo. O Node não deve consumir o conteúdo.

Não é necessário um reset manual no funcionamento normal.

## 13. Pseudocódigo

### Estação 1

```text
estado = AGUARDANDO_BANDEJA

simular_chegada():
    exigir mailbox totalmente zerado
    REQUEST_QR = FALSE
    REQUEST_QR = TRUE
    estado = AGUARDANDO_QR

ao_receber_fc16(mailbox):
    copiar o serial de HR0-HR31
    REQUEST_QR = FALSE
    estado = PROCESSANDO

confirmar_saida():
    exigir estado == PROCESSANDO
    CONFIRMAR_SAIDA = TRUE
    zerar HR0-HR31
    aguardar pelo menos um ciclo de polling do Node
    CONFIRMAR_SAIDA = FALSE
    estado = AGUARDANDO_BANDEJA
```

### Estações 2, 3 e 4

```text
publicar_bandeja(sequence, qr, positions):
    exigir mailbox totalmente zerado
    escrever sequence, length e qr
    escrever POSITION_COUNT = quantidade de chips
    empacotar e escrever POSITION_BITS
    estado = AGUARDANDO_ACK

poll():
    se estado == AGUARDANDO_ACK e mailbox totalmente zerado:
        estado = AGUARDANDO_BANDEJA
```

## 14. Parâmetros padrão

```text
Protocolo: Modbus TCP
Unit ID: 1
Polling do Node: 200 ms
Timeout: 3000 ms
Byte order: AB / Big Endian
Word order: High Word → Low Word
Mailbox M1: HR0-HR31 (32 Holding Registers)
Mailbox M2-M4: HR0-HR39 (40 Holding Registers)
Coil REQUEST_QR da estação 1: 0
Coil CONFIRMAR_SAIDA da estação 1: 1
```

## 15. Checklist de aceite do simulador

- [ ] Disponibiliza quatro servidores/endpoints Modbus independentes.
- [ ] Estação 1 gera borda `REQUEST_QR FALSE → TRUE`.
- [ ] Estação 1 recebe e exibe somente o QR escrito pelo Node.
- [ ] `Confirmar saída` produz a borda da Coil 1 e a CLP zera HR0–HR31.
- [ ] Estações 2, 3 e 4 publicam sequência, QR e posições e aguardam o Node zerar.
- [ ] Permite testar QR divergente.
- [ ] Permite testar sequência divergente.
- [ ] Permite testar posições `TRUE` e `FALSE`.
- [ ] Não sobrescreve mailbox ocupado.
- [ ] Reconhece mailbox zerado como ACK nas estações 2–4.
- [ ] Mantém estado independente para cada estação.
- [ ] Exibe os registers em decimal e hexadecimal para diagnóstico.

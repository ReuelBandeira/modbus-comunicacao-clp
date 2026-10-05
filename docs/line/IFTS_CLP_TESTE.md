# Fluxo produtivo do IFTS acionado pela CLP

A estação IFTS usa dois handshakes independentes: identificação da bandeja na entrada e confirmação física na saída. O pulso `M24` informa somente que o teste terminou; ele não conclui a passagem da bandeja.

## Mapa da estação

| Direção | Endereço | Função |
| --- | ---: | --- |
| CLP → PCM | `M0` | Solicita os dados da próxima bandeja |
| PCM → CLP | `D0–D14` | QR da bandeja de entrada |
| CLP → PCM | `M23` | START do teste, após capturar o QR |
| PCM → CLP | `M24` | Pulso mínimo de 600 ms: teste finalizado |
| CLP → PCM | `D21–D35` | QR lido novamente na saída |
| CLP → PCM | `M1` | Informa que o QR de saída está pronto |
| PCM → CLP | `M2` | Confirmação da saída persistida; pulso da IHM ou sinal limpo pela CLP |

Os endereços de entrada e saída são configurados no protocolo **Estação IFTS · QR de entrada e saída**. `M23` é cadastrado em **Sinais monitorados** com a ação `IFTS · START da estação`. Os comandos `IFTS_RESULT_PASS` e `IFTS_RESULT_FAIL` devem apontar para `M24`; ambos significam apenas “teste terminou”. O resultado PASS/FAIL detalhado permanece persistido no PCM.

## Sequência completa

1. A CLP ativa `M0`.
2. O PCM reserva a próxima bandeja liberada pela M1 e grava seu QR em `D0–D14`.
3. A CLP copia o QR, baixa `M0` e limpa `D0–D14`.
4. A queda de `M0` faz o PCM registrar que a identificação foi confirmada; o conteúdo de `D0–D14` não participa dessa confirmação.
5. A CLP ativa `M23`. O PCM só aceita o START se os passos anteriores tiverem sido concluídos.
6. O Bridge acompanha o teste e entrega o resultado ao PCM.
7. O PCM persiste PASS/FAIL e pulsa `M24` por meio do comando correspondente.
8. A etapa permanece aberta, no estado de resultado registrado, aguardando a saída física.
9. A CLP grava o QR em `D21–D35` e mantém `M1` ativo.
10. O PCM lê duas vezes o mesmo QR, valida a bandeja e verifica se o resultado IFTS já existe.
11. O PCM persiste a passagem e confirma em `M2` conforme o modo configurado.
12. A CLP baixa `M1` e limpa `D21–D35`.

O PCM não envia `M2` para QR desconhecido, QR fora de ordem ou bandeja ainda sem resultado. Esses casos ficam registrados como falha de correlação, sem reprovar automaticamente o produto.

## Configuração produtiva

Configure a máquina associada ao IFTS:

```env
IFTS_MEMORY_MACHINE_ID=m2
IFTS_EXPECTED_POSITION_COUNT=20
```

Na configuração da linha, selecione para essa máquina o protocolo `ifts-qr-handshake-v1` e mantenha capacidade igual a 1. O runtime de QR e a integração do Bridge passam a compartilhar a mesma etapa: o primeiro controla a entrada/saída física e o segundo registra exclusivamente o resultado do teste.

## Retorno de término do teste

Cadastre em **Comandos operacionais**:

| Código lógico | Escrita | Uso |
| --- | --- | --- |
| `IFTS_RESULT_PASS` | Pulso em `M24` | Teste aprovado terminou |
| `IFTS_RESULT_FAIL` | Pulso em `M24` | Teste reprovado terminou |

Os dois comandos escrevem `1`, aguardam no mínimo 600 ms e retornam `M24` para `0`. O comando só é executado após o resultado ser persistido. Reenvios do Bridge usam uma chave idempotente derivada do `cycleId` e do resultado.

`IFTS · confirmar passagem` é uma ação legada e não deve ser configurada. No fluxo atual, somente `M1`, o QR de saída válido e a persistência bem-sucedida podem concluir a passagem.

## Teste de validação

1. Ative `M0` e confirme o preenchimento de `D0–D14`.
2. Baixe `M0`, limpe `D0–D14` pela CLP e confirme que o PCM registrou a identificação somente pela queda de `M0`.
3. Ative `M23` e execute o teste.
4. Confirme o pulso em `M24` após o resultado.
5. Antes de publicar a saída, confirme que a bandeja ainda aparece na M2.
6. Grave o mesmo QR em `D21–D35` e ative `M1`.
7. Confirme o acionamento de `M2`, a passagem persistida e a liberação da próxima estação. No modo **CLP limpa**, confirme também o retorno de `M2` para `FALSE` pela própria CLP.

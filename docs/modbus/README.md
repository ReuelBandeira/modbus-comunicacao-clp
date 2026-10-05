# Teste CLP — Modbus TCP

## Simular no próprio PC

1. Em um terminal, execute `npm run simulate:clp` e deixe aberto.
2. Em outro terminal, execute `npm run dev` e abra **TESTE CLP**.
3. Informe IP `127.0.0.1` e porta `1502`.
4. Nas configurações avançadas, use Unit ID `1`, escrita no endereço `0` com
   `32` registradores e ordem `AB`; resposta no endereço `100`, quantidade `1`,
   formato número e valor esperado `1`. Os timeouts padrões podem ser mantidos.
5. Aguarde ONLINE e clique em **ENVIAR E AGUARDAR OK** com o texto de exemplo.
   O terminal mostra o texto recebido e a tela indica OK.
6. Antes de repetir, pressione **Enter no terminal do simulador** para zerar
   a resposta. Sem isso, a tela bloqueia novo envio por OK já presente.
7. Encerre com **Ctrl+C**; a tela passa a OFFLINE na próxima verificação.

Não precisa de cabo nem CLP física. O simulador aceita apenas conexões do próprio
PC e aprova qualquer texto não vazio; não executa regras reais de inspeção.

Abra **TESTE CLP** na home (`npm run dev`). A tela é independente da bipagem,
da API e do MongoDB. Usa `modbus-serial` no processo principal do Electron.
Nenhum dado é enviado automaticamente ao abrir a tela.

IP, porta e conteúdo do QR code ficam visíveis na tela principal. A seção
**Configurações avançadas**, inicialmente recolhida, reúne Unit ID, timeout,
registradores, ordem dos bytes e parâmetros da resposta. Abra essa seção para
ajustar o mapa da CLP antes do primeiro envio. Recolher a seção mantém os valores
configurados em uso; os botões de teste e o log continuam disponíveis.

## Indicadores da tela

- **Conexão TCP:** ONLINE (verde), OFFLINE (vermelho) ou não configurado
  (cinza). Com IP preenchido, verifica a porta automaticamente a cada 3 segundos,
  com timeout de 1,5 segundo. Não envia dados Modbus nem executa ICMP nessa verificação.
- **Resposta da CLP:** AGUARDANDO durante o envio, OK (verde) apenas após escrita
  confirmada e resposta esperada, ou ERRO (vermelho) se o teste falhar.
  Ler resposta ou executar Ping não aprova um envio.

A verificação automática pausa durante os testes manuais e termina ao sair da
tela. Ao perder conexão, o OK anterior é removido; reconectar exige novo envio
para exibir OK novamente. Alterar os campos também invalida o resultado anterior.
ONLINE confirma acesso TCP, não o processamento do QR code pela CLP.

## O que pedir ao responsável pela CLP

Modbus não define um comando universal para enviar QR code ou receber OK.
É necessário um acordo com o programa da CLP, chamado mapa de registradores:

| Campo | O que significa |
| --- | --- |
| IP / porta | Endereço Ethernet da CLP; porta usual 502. |
| Unit ID | Identificador Modbus, especialmente relevante em gateways. Exemplo 1, não confirmação do equipamento. |
| Endereço de escrita | Primeiro holding register reservado para o texto. |
| Quantidade | Tamanho reservado pela CLP; todos esses registradores serão escritos, inclusive zeros restantes. |
| Ordem AB / BA | Ordem dos dois bytes do texto dentro de cada registrador de 16 bits. |
| Endereço de resposta | Holding register(s) onde a CLP publica o resultado. |
| Formato e valor OK | Número, como 1, ou texto, como OK. Não presumir que 1 é aprovado sem confirmar. |
| Espera | Prazo máximo de consulta da resposta após a escrita. |

Os endereços da tela são **base zero**: o registrador referenciado como 40001 em
alguns manuais costuma corresponder ao endereço 0, mas confirme a convenção do
fabricante. Não digite 40001 sem conferir o mapa. Os valores iniciais são exemplos.

Também confirme se a CLP exige tamanho do texto, terminador, bit de disparo,
contador de transação ou reset de confirmação. Esses mecanismos ainda não são
implementados. Esta versão usa somente escrita FC16 e leitura FC03; não lê coils
nem input registers. É preciso adaptar o teste se o mapa usar esses tipos.

## Texto de teste

O campo contém um exemplo editável de conteúdo QR. Enviamos os **bytes UTF-8 do
texto**, não uma imagem. Cada registrador contém 2 bytes. `AB` vira 0x4142 na
ordem AB e 0x4241 na ordem BA. A capacidade é quantidade × 2 bytes, até 123
registradores por escrita. O restante é preenchido com zeros; texto maior é
rejeitado sem truncamento. Não é inserido cabeçalho de tamanho ou terminador extra.

## Sequência sugerida

1. Configure IP e porta. **PING** executa um ICMP e, mesmo se falhar, testa a
   conexão TCP. O log mostra a saída do ping do sistema e o resultado da porta.
   ICMP pode ser bloqueado enquanto Modbus funciona. Porta aberta não significa
   resposta Modbus nem aprovação da CLP.
2. Preencha o mapa confirmado. **LER RESPOSTA** realiza FC03 sem escrever.
3. Informe o valor OK esperado. No formato número, compara o primeiro registrador;
   no formato texto, decodifica todos na ordem configurada e remove zeros finais.
4. **ENVIAR E AGUARDAR OK** lê o estado inicial, escreve FC16 e consulta FC03 a cada
   aproximadamente 250 ms. Um OK já presente bloqueia a escrita. A tela não limpa
   nem reseta o sinal da CLP automaticamente.
5. Consulte registros decimais, hexadecimal e texto no log (até 100 entradas).

A confirmação FC16 só confirma escrita; a tela só reporta OK depois de observar
o valor esperado. Isso não substitui um identificador de correlação com o serial:
outro processo pode alterar a resposta. É necessário confirmar o handshake com
o programador da CLP antes de usar no processo real.

Timeout após tentativa de escrita deixa resultado incerto: a CLP pode ter
recebido o texto. Não há repetição automática da escrita. Cada operação abre e
fecha sua conexão; não execute dois testes ao mesmo tempo. Fechar a janela
encerra a conexão. Campos ficam na sessão da janela; log apenas na tela atual.

## Testes automatizados

Execute `npm run test:modbus`. Os testes usam um servidor TCP local simulando
FC03/FC16 e verificam codificação, escrita, leitura, OK antigo, timeout sem OK
e sobreposição de endereços. Não substituem o teste com a CLP física.

## Arquivos

- `src/modules/modbus/types/`: parâmetros e resultados.
- `src/modules/modbus/contracts/`: contrato da ponte Electron.
- `src/modules/modbus/services/`: validação, codificação, Ping e Modbus.
- `src/renderer/modules/modbus/`: interface de teste.

Referência: [modbus-serial](https://github.com/yaacov/node-modbus-serial).

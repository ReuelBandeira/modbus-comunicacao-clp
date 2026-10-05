# Uso do mesmo EXE em vários computadores

O PCM IHM possui dois perfis locais:

- **Principal**: inicia MongoDB/API, comunicação Modbus com as máquinas e todas as telas operacionais.
- **Final de Linha**: tela remota e somente leitura que apresenta o resultado de cada bandeja após a saída da última máquina.

M1, M2, M3 e M4 continuam sendo estações de máquina/CLP. O computador Final de Linha apenas consulta o resultado consolidado.

## Primeira execução

Ao iniciar o EXE pela primeira vez:

1. Escolha a área deste computador.
2. Para Final de Linha, informe `http://IP-DO-PRINCIPAL:3000`.
3. Informe a senha local de configuração. O padrão é `123`.
4. O aplicativo salva a escolha e reinicia no perfil selecionado.

A configuração fica no arquivo `station.json`, dentro do diretório `userData` do Electron no Windows. A senha não é gravada. Para trocar o perfil, use **ESTAÇÃO** no computador Principal ou **Configurar estação** em uma estação de leitura.

## Rede

No computador Principal, o `.env` deve conter:

```env
API_HOST=0.0.0.0
API_PORT=3000
SETUP_PASSWORD=123
```

Use um IP fixo para o computador Principal e libere somente a porta TCP `3000` no Firewall do Windows para a rede interna. MongoDB não precisa ser exposto na rede; os clientes conversam apenas com a API.

Teste a partir de outro computador com:

```powershell
Test-NetConnection IP-DO-PRINCIPAL -Port 3000
```

## Segurança e disponibilidade

- Requisições vindas da LAN aceitam consultas autorizadas (`GET`) e a entrada de bandejas por `POST /api/serial-numbers`.
- Cadastro, simulação e alteração de máquinas continuam restritos ao computador Principal.
- A senha `12345` protege a troca do perfil local; ela não funciona como autenticação de rede.
- A tela Final de Linha reconecta automaticamente quando o Principal fica temporariamente indisponível.
- O canal em tempo real envia um estado inicial e só publica novamente quando o estado da linha muda.

## Resultado no Final de Linha

A tela só troca a bandeja em destaque quando o workflow estiver `completed`, depois da confirmação de saída da última máquina. Para cada bandeja são apresentados:

- QR Code/serial e sequência da passagem;
- horário de saída da linha;
- resultado geral (`APROVADA · 100%`, `REPROVADA` ou `RESULTADO INCOMPLETO`);
- quantidade de posições aprovadas, reprovadas ou sem resultado;
- mapa visual fixo com 20 posições, organizado em 5 colunas por 4 linhas;
- máquina ou máquinas que reprovaram cada posição;
- histórico imediato das cinco últimas saídas.

Uma posição é aprovada somente quando todas as máquinas de teste informam `true`. Se qualquer uma informar `false`, ela é contada uma única vez como reprovada e todas as estações responsáveis são mostradas. Dados ausentes deixam a posição como sem resultado. Antes da primeira saída, todos os componentes permanecem visíveis e as 20 posições aparecem como aguardando.

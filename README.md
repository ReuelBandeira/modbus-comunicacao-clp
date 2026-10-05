# conecthus.PCM

## Teste de CLP

Na home, **TESTE CLP** abre o teste independente Modbus TCP, com Ping ICMP/TCP,
envio de texto e consulta de OK. Configure o mapa conforme o
[guia de teste Modbus](docs/modbus/README.md).

## Executar todos os testes

Com a API iniciada, a documentação interativa está em
[Swagger UI](http://127.0.0.1:3000/api-docs/).

```powershell
npm.cmd test
```

Compila o projeto e executa as suítes de API, entrada PCM, linha, Modbus, TCP e inspeção.
Os comandos `test:api`, `test:pcm`, `test:line`, `test:modbus`, `test:tcp` e `test:inspection`
continuam disponíveis para executar cada suíte separadamente.

## Entrada da linha PCM

A API `POST /api/serial-numbers` registra o serial no MongoDB e rejeita duplicidades.
Configure o banco no `.env` (veja `.env.example`). O índice único é criado
automaticamente a cada conexão; `npm run db:migrate` é opcional, só para preparar o
banco sem subir a API/IHM. Veja o [fluxo de entrada PCM](docs/api/pcmEntry.md).

A entrada local por scanner está temporariamente desativada. Novas bandejas devem ser enviadas por
`POST /api/serial-numbers`, inclusive a partir da LAN usando o IP do computador Principal.

### Subir MongoDB com Docker

```powershell
copy .env.example .env
npm.cmd run infra:up
```

`infra:up` sobe `pcm-mongo` (imagem `mongo:7.0`, dados no volume `pcm_mongo_data`).
`npm.cmd run db:up` também inicia o banco.
As credenciais/portas vêm do `.env` na raiz (lido automaticamente pelo `docker compose`);
sem ele, valores padrão de desenvolvimento são usados. O script `docker/mongo-init.js`
cria o usuário de aplicação (`MONGO_USER`/`MONGO_PASSWORD`) com acesso restrito ao banco
`MONGO_DATABASE`, separado do usuário root (`MONGO_ROOT_USER`/`MONGO_ROOT_PASSWORD`).
`db:logs` acompanha o log do banco e `infra:down` encerra o serviço.

O fluxo de entrada ativo (`POST /api/serial-numbers`) retorna `OK` somente após
confirmar a gravação no MongoDB. Veja [o contrato e as falhas](docs/api/pcmEntry.md).

## Controle da linha e cadastro de máquinas

O controle persistente da linha está descrito em [docs/line](docs/line/README.md), e o
[handshake da M1](docs/modbus/M1_HANDSHAKE.md) documenta a comunicação contínua e o simulador.
Cadastre as máquinas pela tela de configurações ou pelo Swagger antes de bipar;
as rotas de simulação permitem testar aprovação e reprovação sem acessar CLPs. O bypass
fica desabilitado por padrão e pode ser reativado com `PCM_BYPASS_ENABLED=true`.

## Disponibilidade e OEE

A tela **OEE** registra paradas e retomadas manualmente, calcula a disponibilidade a partir dos turnos,
pausas e calendário produtivo e usa os resultados existentes para calcular a qualidade. Performance e OEE
permanecem pendentes até a definição do tempo de ciclo ideal. Veja a [documentação do módulo](docs/line/OEE.md).

## Registro operacional

A tela **Configurações → Registro operacional** centraliza ações da produção, operadores, turnos, OEE,
CLPs, alarmes, integrações e alterações administrativas. A consulta exige sessão ADMIN, permite filtrar
por período, categoria, resultado, responsável e texto, e exporta o resultado atual em CSV. Os registros
são persistidos no MongoDB sem senhas ou conteúdo livre das requisições. A retenção padrão é de 365 dias
e pode ser alterada por `OPERATIONAL_LOG_RETENTION_DAYS` no `.env`.

`POST /api/lines` cadastra as máquinas. `GET /api/lines/{lineId}` consulta a
configuração e sua revisão. `PUT /api/lines/{lineId}` edita IP, porta e ordem no
fluxo, usando a revisão retornada e sem bandejas em andamento. A ordem do array
`machines` é a sequência física. A porta Modbus padrão é 502.

## Inspeção visual

Na home, **INSPEÇÃO 01** e **INSPEÇÃO 02** abrem o [módulo de inspeção](docs/inspection/README.md),
com fila e histórico independentes por máquina. A primeira versão é apenas front-end,
com capturas simuladas, filtros e indicadores de produção.

## API de serial-number

A [API HTTP em TypeScript/Node.js](docs/api/README.md) recebe `serial-number` (hash) ou `qr-code` (texto lido),
grava a entrada no MongoDB e retorna `OK` ou `ERROR` com mensagem. Seu código fica em
`src/api`, com dependências e compilação compartilhadas com a IHM.
`npm.cmd run dev` e o executável Windows iniciam a IHM e a API juntos.
Execute `npm.cmd run start:api` na raiz para iniciar somente o serviço HTTP.

## Executar em desenvolvimento

```powershell
npm.cmd install
npm.cmd start
```

## Testar os dados da máquina via TCP

Veja a [documentação da estrutura dos testes TCP/IP](docs/tcp/README.md)
para conhecer os arquivos, o fluxo de comunicação e os testes automatizados.

Na home, abra **Teste TCP**, informe o IP e a porta da máquina e clique em
**Conectar**. Nesta primeira versão, o aplicativo funciona como cliente TCP:
a máquina precisa aceitar a conexão e enviar os dados. Nenhum comando é enviado.

A tela mostra horário, quantidade de bytes, texto UTF-8 e hexadecimal.
TCP entrega um fluxo de bytes: cada registro é um bloco recebido, não necessariamente
uma mensagem completa. O protocolo da máquina ainda precisa ser definido para
interpretar esses dados. O painel da home continua usando valores simulados.

Use **Desconectar** para encerrar a conexão. A navegação entre home e teste TCP
preserva os campos, o histórico e a conexão, que continua recebendo dados.
Fechar a janela encerra a conexão e descarta o histórico da sessão.
O histórico fica apenas na memória, limitado a 200 registros, com prévia de até
4 KB por bloco. **Limpar registros** também zera o contador de bytes.

Para validar a recepção com um servidor local:

```powershell
npm.cmd run test:tcp
```

## Gerar o executável Windows

```powershell
npm.cmd run build:win
```

O build compila o TypeScript, copia os arquivos da interface e gera a versão
portátil para Windows x64 em `out/PCM-IHM-1.0.0-x64.exe`.
Abra esse arquivo para executar o sistema, sem instalar Node.js ou npm.
O executável não possui assinatura digital e usa o ícone padrão do Electron.
A primeira geração pode precisar de internet para baixar as ferramentas de empacotamento.


## Convenção de nomes

Arquivos de código, variáveis e funções usam camelCase, como `tcpService.ts`,
`copyAssets.cjs` e `createWindow`. Classes e interfaces usam PascalCase,
como `TcpService` e `TcpOptions`. Classes CSS, atributos HTML e nomes de eventos
mantêm as convenções das respectivas tecnologias.

## Estrutura do projeto

Os módulos são agrupados por responsabilidade:

- `src/modules/pcm/entry/`: fluxo de entrada do produto, com rotas, service, validação,
  DTO, contrato, repositório e erros específicos em subpastas por responsabilidade.
- `src/modules/tcp/`: serviço, sessão e tipos de comunicação TCP.
- `src/modules/machines/`: configuração persistida das máquinas e base dos adaptadores.
- `src/modules/pcm/workflow/`: controle das passagens e sequência em banco.
- `src/modules/modbus/`: cliente, servidor, memória, codecs e debug Modbus TCP.
- `src/database/`: conexão MongoDB e executor da migration.
- `src/api/`: servidor HTTP, registro das rotas e respostas compartilhadas.
  Os tratamentos HTTP comuns ficam em `middlewares/`.
- `src/renderer/modules/inspection/`: módulo visual de inspeção independente por máquina.

O MongoDB concentra entrada, configuração das máquinas, sequência e histórico das etapas.

```text
src/
├── main/main.ts
├── preload/preload.ts
├── modules/tcp/services/tcpService.ts
├── modules/tcp/sessions/tcpSession.ts
├── modules/tcp/types/tcpTypes.ts
├── renderer/
│   ├── css/app.css
│   ├── js/
│   │   ├── home.ts
│   │   ├── loading.ts
│   │   └── tcp.ts
│   ├── views/
│   │   ├── home.html
│   │   └── tcp.html
│   └── vendor/bootstrap/bootstrap.min.css
└── index.html
scripts/
├── copyAssets.cjs
└── testTcp.cjs
```


┌──────────────── REDE INDUSTRIAL ────────────────┐
│                                                 │
│                  Switch                         │
│                    │                            │
│       ┌────────────┼─────────────┐              │
│       │            │             │              │
│       ▼            ▼             ▼              │
│      PCM       Inspeção 1    Inspeção 2         │
│                                                 │
│       │                                         │
│       ├── Node.js                               │
│       ├── MongoDB                               │
│       └── Modbus TCP                            │
│                                                 │
└─────────────────────────────────────────────────┘

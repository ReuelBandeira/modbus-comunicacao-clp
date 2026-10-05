# Entrada da linha PCM

Fluxo: leitura pelo cliente → API HTTP → validação → consulta de uso na linha → insert MongoDB → resposta OK.
O service retorna 409 somente quando o mesmo serial ainda possui uma passagem em andamento.
Depois que essa passagem termina, a bandeja pode ser reutilizada e recebe uma nova sequência.
O índice único parcial continua protegendo contra bipagens concorrentes enquanto a bandeja está na linha.
A fila lógica e as etapas pertencem ao documento PCM no MongoDB. Não há broker
externo. Sem banco disponível, a API não confirma a bipagem.

## Preparar MongoDB

Requer MongoDB 6+. Suba o container com `npm run infra:up` (ou `npm run db:up` para
só o Mongo); o script `docker/mongo-init.js` cria o banco e o usuário de aplicação
na primeira subida (volume novo). Preencha `.env` na raiz:

```dotenv
MONGO_HOST=127.0.0.1
MONGO_PORT=27017
MONGO_DATABASE=pcm
MONGO_USER=pcm_app
MONGO_PASSWORD=sua_senha
```

O índice parcial de `workflow.lineId + serialNumber + workflow.status` na collection
`pcm_line_entries` é criado automaticamente a cada conexão (`connectMongo`, em
`src/database/mongo.ts`), lendo
a definição de `src/modules/pcm/models/pcmModel.ts`. Isso é idempotente
e também recria o índice sozinho se a collection for apagada manualmente (ex.: "Drop
Collection" no Compass ao limpar dados de teste) — não é preciso lembrar de rodar
nada depois. A inicialização remove automaticamente o índice antigo que tornava o serial
único para sempre. `npm run db:migrate` continua disponível para garantir os índices sem
precisar subir a API/IHM inteira (útil antes do primeiro uso).

Inicie `npm run start:api` (somente API) ou `npm run dev` (IHM e API). No portátil,
o `.env` fica ao lado do `.exe`. Sem MongoDB configurado, o novo endpoint retorna
503, mantendo a IHM disponível. Para limpar dados de teste sem apagar o índice,
prefira `db.pcm_line_entries.deleteMany({})` a dropar a collection.

## Registrar leitura

Antes de bipar na API iniciada por `start:api`/Electron, cadastre a linha em
`POST /api/lines`. A variável `PCM_LINE_ID` seleciona a linha (padrão `linha-01`).
O registro passa a incluir sequência, estados e etapas em `workflow`.
Veja [controle da linha e simulação das máquinas](../line/README.md).

`POST /api/serial-numbers`, `Content-Type: application/json`:

```json
{ "serial-number": "AbC123" }
```

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/api/serial-numbers -ContentType application/json -Body '{"serial-number":"AbC123"}'
```

Para enviar de outro computador na mesma rede, substitua `127.0.0.1` pelo IP do computador Principal:

```powershell
Invoke-RestMethod -Method Post -Uri http://IP-DO-PRINCIPAL:3000/api/serial-numbers -ContentType application/json -Body '{"serial-number":"AbC123"}'
```

A entrada física por scanner na tela **Entrada** está temporariamente desativada. Este POST é a única escrita liberada para clientes da LAN; as demais alterações continuam restritas ao computador Principal.

- **200**: `{"status":"OK"}` somente após a confirmação da gravação no MongoDB.
- **400**: serial inválido (1–512 caracteres, sem espaços/controles) ou QR que nao contenha um serial valido.
- **409**: `{"status":"ERROR","msg":"Este serial já está em uso na linha."}`.
- **404**: linha de entrada não cadastrada.
- **503**: banco ausente/indisponível ou gravação não confirmada.
- JSON inválido, tipo de conteúdo e tamanho máximo de 32 KB seguem o contrato da API.

O serial não é convertido nem recalculado. Maiúsculas e minúsculas são distintas.
Um índice UNIQUE parcial no banco rejeita duplicidades concorrentes apenas para documentos
com `workflow.status: "in_progress"`. Cada `insertOne` grava uma nova passagem com
`serialNumber`, `enteredAt` e uma nova `entrySequence`. Em caso de perda da resposta,
uma repetição retorna 409 enquanto a primeira passagem estiver ativa. A bandeja fica aguardando a primeira estação no MongoDB;
as etapas avançam mediante os eventos de chegada, resultado e passagem.

`serialNumber` é gravado como string comum. O MongoDB compara e indexa strings de
forma binária/case-sensitive por padrão (sem `collation`), o que já garante a
comparação exata sem precisar de um tipo binário. Para consultar:

```javascript
db.pcm_line_entries.find().sort({ _id: -1 }).forEach(doc => print(doc.serialNumber, doc.enteredAt));
```

O endpoint de bipagem existente agora persiste no MongoDB; nao retorna mais sucesso apenas pela validacao.

## Testes

`npm run test:pcm`: contrato HTTP, validação, gravação parametrizada, espera da
confirmação, duplicidade e banco indisponível com dependências substituídas.
Esses testes não equivalem a executar contra um servidor MongoDB real.

Driver: [MongoDB Node.js Driver](https://www.mongodb.com/docs/drivers/node/current/).

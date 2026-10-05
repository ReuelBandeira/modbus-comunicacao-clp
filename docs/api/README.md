# API PCM

## Swagger

Inicie `npm run start:api` ou `npm run dev` e abra
[Swagger UI](http://127.0.0.1:3000/api-docs/).
O documento está disponível em [OpenAPI JSON](http://127.0.0.1:3000/api-docs/openapi.json).
Se alterar host ou porta, use o endereço configurado. Funciona também com a API
iniciada pelo Electron; os arquivos visuais são servidos localmente, sem CDN.

Use **Try it out**, escolha o exemplo de serial ou QR e clique em **Execute**.
A operação chama a API real e grava no banco quando configurado. A consulta à
documentação funciona sem MongoDB.

A especificação central fica em `src/api/docs/openApi.ts`, e a documentação do
fluxo em `src/modules/pcm/entry/docs/entryOpenApi.ts`. Atualize esses arquivos
quando mudar o contrato HTTP.

## Fluxo

O [controle da linha](../line/README.md) acrescenta cadastro das máquinas, consultas
do PCM e eventos de simulação de chegada, resultado e passagem. Cadastre a linha
selecionada por `PCM_LINE_ID` antes de registrar novas bipagens.

O endpoint existente **POST /api/serial-numbers** registra a entrada do produto
na linha PCM e persiste no MongoDB. Nao existe uma segunda rota para entrada PCM.

## Entrada

```json
{ "serial-number": "AbC123" }
```

Ou o serial lido de um QR code:

```json
{ "qr-code": "AbC123" }
```

Envie exatamente um campo. O serial deve ter de 1 a 512 caracteres, sem espacos
ou controles. O texto e preservado, inclusive maiusculas e minusculas. Para este
fluxo, QR deve conter o proprio serial; nao ha extracao de serial de JSON ou URL.
Campos adicionais sao ignorados. Corpo limitado a 32 KB.

## Respostas

- HTTP 200: `{"status":"OK"}` depois da confirmação da gravação no MongoDB.
- HTTP 409: `{"status":"ERROR","msg":"Serial ja registrado..."}` para duplicidade.
- HTTP 400: entrada invalida.
- HTTP 404: linha de entrada não cadastrada.
- HTTP 503: banco indisponível, não configurado ou operação não confirmada.
- HTTP 413/415: corpo excedido ou tipo de conteudo nao suportado.

Serial e QR com o mesmo valor representam o mesmo produto e a mesma restricao
UNIQUE. A entrada, a sequência e as etapas são controladas exclusivamente no MongoDB.
Veja [o contrato da bipagem](pcmEntry.md).

## Configuracao e indices

Veja [entrada PCM e MongoDB](pcmEntry.md) para configurar o banco e testar a API.
O indice unico e garantido automaticamente a cada conexao; `npm run db:migrate`
continua disponivel para prepara-lo sem subir a API/IHM inteira.

`npm run dev` inicia IHM e API; `npm run start:api` inicia somente a API.
No desenvolvimento, `.env` fica na raiz; no portatil, ao lado do `.exe`.
Nao execute ambos na mesma porta.

## Estrutura

O módulo `src/modules/pcm/entry` organiza cada responsabilidade em `routes`,
`services`, `validators`, `errors` e `dtos`.
A persistência pertence ao módulo PCM: `pcm/repositories` contém o repositório e
seu contrato, e `pcm/errors` contém o erro de duplicidade compartilhado.
O service de entrada monta a entidade `PCM` com serial e data de entrada; o
repositório recebe essa entidade pronta para persistir.
A configuração HTTP permanece em `src/api/config.ts`.
Os tratamentos HTTP compartilhados estão em `src/api/middlewares/httpErrors.ts`.

- `src/modules/pcm/entry/dtos/entryRequestDto.ts`: DTO da entrada existente.
- `src/api/dtos/apiResponseDto.ts`: DTO das respostas.
- `src/modules/pcm/entry/validators/entryValidation.ts`: validacao em tempo de execucao.
- `src/modules/pcm/entry/routes/entryRoutes.ts`: endpoint e respostas HTTP.
- `src/modules/pcm/entry/services/entryService.ts`: valida a bipagem e solicita a persistencia.
- `src/modules/pcm/entry/errors/invalidEntryError.ts`: erro de validacao da leitura.
- `src/modules/pcm/repositories/pcmRepositoryContract.ts`: contrato do repositorio.
- `src/modules/pcm/errors/duplicateSerialError.ts`: erro de duplicidade.
- `src/modules/pcm/repositories/pcmRepository.ts`: insertOne na collection.
- `src/modules/pcm/models/pcmModel.ts`: entidade PCM, nome da collection e índices compartilhados pelo módulo PCM (fonte única).
- `src/database/models.ts`: lista as models cujos indices sao garantidos na conexao.
- `src/database/mongo.ts`: configuracao, conexao MongoDB e criacao idempotente dos indices.
- `src/database/migrateMongo.cjs`: conecta e garante os indices sem subir a API/IHM.

O corpo HTTP permanece `unknown` ate passar pela validacao. DTOs nao substituem
essa validacao. O servidor encerra a conexão MongoDB junto com a API.

Para editar IP, porta e ordem das máquinas, consulte `GET /api/lines/{lineId}` e
envie a configuração completa com a revisão retornada para `PUT /api/lines/{lineId}`.
A edição exige que não existam bandejas em andamento nessa linha.

## Testes

- `npm run test:api`: ciclo de vida HTTP, QR e erros de protocolo.
- `npm run test:pcm`: persistencia, duplicidade, validacao e falhas do banco.

Os testes usam dependencias substituidas; nao validam um servidor MongoDB real.

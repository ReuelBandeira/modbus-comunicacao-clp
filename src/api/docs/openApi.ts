import { entryPaths, entrySchemas } from '../../modules/pcm/entry/docs/entryOpenApi';
import { linePaths } from '../../modules/pcm/workflow/docs/lineOpenApi';
import { availabilityPaths } from '../../modules/availability/docs/availabilityOpenApi';
import { stationPresencePaths } from '../../modules/stations/docs/stationPresenceOpenApi';
import { plcSignalPaths } from '../../modules/plcSignals/docs/plcSignalOpenApi';
import { testResultPaths, testResultSchemas } from '../../modules/testResults/docs/testResultOpenApi';
import { operationalLogPaths } from '../../modules/operationalLogs/docs/operationalLogOpenApi';

export const openApiDocument = {
    openapi: '3.0.3',
    info: { title: 'API PCM', version: '1.0.0',
        description: 'Documentação dos serviços do sistema PCM, organizada por módulo e funcionalidade. O acesso é restrito à rede local; áreas administrativas usam sessão ADMIN e a integração IFTS pode usar X-API-Key. Rotas inexistentes retornam HTTP 404 com status ERROR e msg. A consulta à documentação não depende do MongoDB.' },
    servers: [{ url: '/', description: 'Servidor atual da API' }],
    tags: [{ name: 'Entrada PCM', description: 'Bipagem e persistência no MongoDB.' },
        { name: 'Linha PCM', description: 'Configuração de máquinas e simulação persistente das passagens.' },
        { name: 'OEE e disponibilidade', description: 'Apontamentos, calendário produtivo e indicadores da linha.' },
        { name: 'Integração CLP', description: 'Sinais, comandos configuráveis, ACK e auditoria operacional.' },
        { name: 'Registro operacional', description: 'Auditoria persistida das ações, responsáveis e resultados.' },
        { name: 'IFTS', description: 'Recebimento idempotente e consulta dos resultados de testes de memória.' }],
    paths: { ...entryPaths, ...linePaths, ...availabilityPaths, ...stationPresencePaths, ...plcSignalPaths, ...testResultPaths,
        ...operationalLogPaths },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'ADMIN session' },
        apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } }, schemas: {
        ...entrySchemas,
        ...testResultSchemas,
        ApiResponseDto: {
            description: 'Contrato compartilhado de resposta da API: sucesso ou erro com mensagem obrigatória.',
            oneOf: [{ $ref: '#/components/schemas/ApiSuccess' }, { $ref: '#/components/schemas/ApiError' }]
        },
        ApiSuccess: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['OK'] } } },
        ApiError: { type: 'object', required: ['status', 'msg'], additionalProperties: false, properties: { status: { type: 'string', enum: ['ERROR'] }, msg: { type: 'string' } } }
    } }
};

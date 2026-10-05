const id = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' };
const parameter = (name: string) => ({ name, in: 'path', required: true, schema: id });
const response = (description: string) => ({ description });
const responses = {
    '200': { description: 'Operação confirmada. data contém a configuração, bandeja ou identificação da passagem.',
        content: { 'application/json': { schema: { type: 'object', required: ['status', 'data'], properties: {
            status: { type: 'string', enum: ['OK'] }, data: { description: 'Resultado da operação.' }
        } } } } },
    '400': response('Entrada inválida.'), '404': response('Linha, máquina ou operação não encontrada.'),
    '409': response('Conflito de sequência, passagem pendente ou resultado divergente.'),
    '413': response('Corpo excede 32 KB.'), '415': response('Use application/json.'),
    '503': response('Persistência não confirmada ou MongoDB não configurado. Repita o mesmo evento.')
};
const body = (schema: unknown, example: unknown) => ({ required: true,
    content: { 'application/json': { schema, example } } });
const machinePath = '/api/lines/{lineId}/machines/{machineId}';
const event = (summary: string, schema: unknown, example: unknown) => ({
    tags: ['Linha PCM'], summary,
    description: 'Evento de simulação persistido no MongoDB. Não acessa a CLP. Reutilize cycleId/operationId nas repetições.',
    parameters: [parameter('lineId'), parameter('machineId')], requestBody: body(schema, example), responses
});
const operationBody = { type: 'object', required: ['operationId'], properties: { operationId: id } };
const lineProperties = {
    lineId: id, name: { type: 'string' }, mode: { type: 'string', enum: ['simulation', 'production'], readOnly: true },
    minimumOperators: { type: 'integer', minimum: 1, maximum: 99, default: 3,
        description: 'Operadores ativos exigidos na estação principal para iniciar a bipagem.' },
    revision: { type: 'integer', minimum: 1, description: 'Revisão retornada no GET; obrigatória para editar.' },
    ipRange: { type: 'object', required: ['min', 'max'], properties: { min: { type: 'integer' }, max: { type: 'integer' } } },
    machines: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', required: ['machineId', 'name', 'host'], properties: {
        machineId: id, name: { type: 'string' }, host: { type: 'string', format: 'ipv4' },
        port: { type: 'integer', default: 502 }, unitId: { type: 'integer', default: 1 }, timeoutMs: { type: 'integer', default: 3000 },
        protocol: { type: 'string', enum: ['unmapped', 'm1-qr-handshake-v1', 'ifts-qr-handshake-v1', 'result-handshake-v1'], default: 'unmapped' },
        modbus: { type: 'object', description: 'Conexão, polling, mapa base zero e handshake de QR + resultado. Obrigatório para protocolos integrados.' }
    } } }
};

export const linePaths = {
    '/api/line-context': { get: { tags: ['Linha PCM'], summary: 'Consultar a linha configurada para bipagem', responses } },
    '/api/lines/{lineId}/status': { get: { tags: ['Linha PCM'], summary: 'Painel da linha: totais, passagens ativas, filas e últimas 50 entradas',
        description: 'As passagens ativas e contagens consideram toda a linha, independentemente do limite do histórico recente.',
        parameters: [parameter('lineId')], responses } },
    '/api/lines/{lineId}/chip-metrics': { get: { tags: ['Linha PCM'], summary: 'Indicadores consolidados de chips por período e por hora',
        description: 'Consolida as posições das estações posteriores à entrada. FALSE em qualquer estação reprova o chip; dados ausentes deixam a posição indeterminada.',
        parameters: [parameter('lineId'),
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'timezoneOffsetMinutes', in: 'query', schema: { type: 'integer', minimum: -840, maximum: 840 } }
        ], responses } },
    '/api/lines': { post: { tags: ['Linha PCM'], summary: 'Cadastrar linha e máquinas na ordem física',
        description: 'Porta padrão 502; faixa padrão do último octeto 25–75. Cada máquina integrada entrega QR e recebe resultado por handshake. Pode ser editada com PUT quando não houver bandejas em andamento.',
        requestBody: body({ type: 'object', required: ['lineId', 'name', 'machines'], properties: lineProperties }, { lineId: 'linha-01', name: 'Linha 1', machines: [
            { machineId: 'm1', name: 'Máquina 1', host: '192.168.1.25' },
            { machineId: 'm2', name: 'Máquina 2', host: '192.168.1.35' },
            { machineId: 'm3', name: 'Máquina 3', host: '192.168.1.45' }
        ] }), responses } },
    '/api/lines/{lineId}': {
        get: { tags: ['Linha PCM'], summary: 'Consultar configuração e revisão da linha', parameters: [parameter('lineId')], responses },
        put: { tags: ['Linha PCM'], summary: 'Editar máquinas, IPs, portas e sequência da linha',
            description: 'Substitui a configuração usando a revision do GET. A ordem do array machines define a sequência. Retorna 409 se houver bandejas em andamento ou revisão desatualizada. Históricos concluídos são preservados.',
            parameters: [parameter('lineId')],
            requestBody: body({ type: 'object', required: ['name', 'machines', 'revision'], properties: lineProperties }, {
                revision: 1, name: 'Linha 1', ipRange: { min: 25, max: 75 }, machines: [
                    { machineId: 'm2', name: 'Máquina 2', host: '192.168.1.35', port: 502 },
                    { machineId: 'm1', name: 'Máquina 1', host: '192.168.1.25', port: 502 },
                    { machineId: 'm3', name: 'Máquina 3', host: '192.168.1.45', port: 502 }
                ]
            }), responses }
    },
    '/api/lines/{lineId}/minimum-operators': { put: { tags: ['Linha PCM'], summary: 'Atualizar equipe mínima da entrada',
        description: 'Operação ADMIN. Atualiza somente a quantidade de operadores ativos exigida para bipagem.',
        parameters: [parameter('lineId')], requestBody: body({ type: 'object', required: ['minimumOperators', 'revision'], properties: {
            minimumOperators: { type: 'integer', minimum: 1, maximum: 99 }, revision: { type: 'integer', minimum: 1 }
        } }, { minimumOperators: 3, revision: 1 }), responses } },
    '/api/lines/{lineId}/trays': { get: { tags: ['Linha PCM'], summary: 'Últimas bandejas da linha, incluindo etapas e operações',
        parameters: [parameter('lineId'), { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }], responses } },
    '/api/lines/{lineId}/trays/{entrySequence}': { get: { tags: ['Linha PCM'], summary: 'Consultar uma passagem específica pela sequência',
        parameters: [parameter('lineId'), { name: 'entrySequence', in: 'path', required: true,
            schema: { type: 'integer', minimum: 1 } }], responses } },
    '/api/lines/{lineId}/trays/{entrySequence}/interventions': { post: {
        tags: ['Linha PCM'], summary: 'Retirar uma bandeja ou colocá-la em quarentena',
        description: 'Operação ADMIN auditada. Preserva o histórico e encerra a passagem sem contabilizá-la como produção concluída. Para bandeja atribuída a uma estação, exige confirmação da retirada física e do mailbox limpo.',
        security: [{ bearerAuth: [] }],
        parameters: [parameter('lineId'), { name: 'entrySequence', in: 'path', required: true,
            schema: { type: 'integer', minimum: 1 } }],
        requestBody: body({ type: 'object', required: ['action', 'reason'], properties: {
            action: { type: 'string', enum: ['remove', 'quarantine'] },
            reason: { type: 'string', minLength: 3, maxLength: 120 },
            notes: { type: 'string', maxLength: 500 }, physicalRemovalConfirmed: { type: 'boolean' }
        } }, { action: 'quarantine', reason: 'Bandeja danificada', notes: 'Retirada para inspeção', physicalRemovalConfirmed: true }),
        responses: { ...responses, '401': response('Sessão ADMIN ausente ou expirada.') }
    } },
    '/api/lines/{lineId}/trays/{entrySequence}/advance': { post: {
        tags: ['Linha PCM'], summary: 'Avançar manualmente a bandeja para a próxima estação',
        description: 'Operação ADMIN auditada. Marca a etapa atual sem resultado como não executada, pausa os runtimes durante a alteração e coloca a bandeja na fila da próxima estação.',
        security: [{ bearerAuth: [] }],
        parameters: [parameter('lineId'), { name: 'entrySequence', in: 'path', required: true,
            schema: { type: 'integer', minimum: 1 } }],
        requestBody: body({ type: 'object', required: ['reason', 'physicalMovementConfirmed'], properties: {
            reason: { type: 'string', minLength: 3, maxLength: 120 }, notes: { type: 'string', maxLength: 500 },
            physicalMovementConfirmed: { type: 'boolean', enum: [true] }
        } }, { reason: 'Teste da integração IFTS', physicalMovementConfirmed: true }),
        responses: { ...responses, '401': response('Sessão ADMIN ausente ou expirada.') }
    } },
    '/api/trays/{serialNumber}': { get: { tags: ['Linha PCM'], summary: 'Consultar a passagem mais recente da bandeja',
        description: 'Quando o serial já foi reutilizado, retorna a passagem com a maior sequência de entrada.',
        parameters: [{ name: 'serialNumber', in: 'path', required: true, schema: { type: 'string' } }], responses } },
    [`${machinePath}/arrival`]: { post: event('Simular chegada e solicitar identificação',
        { type: 'object', required: ['cycleId'], properties: { cycleId: id } }, { cycleId: 'ciclo-001' }) },
    [`${machinePath}/result`]: { post: event('Simular resultado da operação',
        { type: 'object', required: ['operationId', 'result'], properties: {
            operationId: id, result: { type: 'string', enum: ['OK', 'NAO'] }, data: { type: 'object', additionalProperties: true }
        } }, { operationId: 'ID-retornado-na-chegada', result: 'NAO', data: { reason: 'Falha de processo' } }) },
    [`${machinePath}/passage`]: { post: event('Simular passagem concluída, inclusive bypass', operationBody,
        { operationId: 'ID-retornado-na-chegada' }) }
};

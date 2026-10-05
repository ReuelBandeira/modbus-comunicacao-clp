const response = (description: string) => ({ description });
const operationalResponses = {
    '200': response('Consulta ou execução confirmada.'),
    '400': response('Código ou identificador da requisição inválido.'),
    '404': response('Comando ou CLP ativa não encontrada.'),
    '409': response('Intertravamento, concorrência ou confirmação da CLP impediu a conclusão.'),
    '503': response('Runtime de comunicação indisponível.')
};

export const plcSignalPaths = {
    '/api/station-test-reset': { post: {
        tags: ['Integração CLP'], summary: 'Reiniciar a linha para um novo teste controlado',
        description: 'Uso local e ADMIN. Pausa os handshakes, executa REINICIAR_ESTACAO, zera e confere as áreas Modbus, remove as bandejas da linha e cria uma bandeja pronta para liberação.',
        security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', required: ['requestId'], additionalProperties: false,
            properties: { requestId: { type: 'string', minLength: 1, maxLength: 100 } }
        } } } },
        responses: operationalResponses
    } },
    '/api/plc-alarms/operational': { get: {
        tags: ['Integração CLP'], summary: 'Consultar alarmes ativos e histórico recente',
        description: 'Retorna ocorrências abertas e as últimas ocorrências registradas a partir dos sinais monitorados.',
        responses: operationalResponses
    } },
    '/api/plc-alarms/occurrences/{occurrenceId}/acknowledge': { post: {
        tags: ['Integração CLP'], summary: 'Reconhecer uma ocorrência de alarme',
        description: 'Registra o reconhecimento do operador sem encerrar o alarme; a normalização depende do sinal da CLP.',
        parameters: [{ name: 'occurrenceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: operationalResponses
    } },
    '/api/plc-controls/operational': { get: {
        tags: ['Integração CLP'], summary: 'Consultar botões operacionais, bloqueios e histórico',
        description: 'Uso local na IHM Principal. Informa os comandos visíveis, intertravamentos atuais e as 30 últimas execuções.',
        responses: operationalResponses
    } },
    '/api/plc-controls/{code}/execute': { post: {
        tags: ['Integração CLP'], summary: 'Executar comando configurado pelo código lógico',
        description: 'Valida intertravamentos, grava auditoria, escreve na CLP, aguarda ACK e executa o manipulador de negócio cadastrado. Não substitui segurança física.',
        parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{2,79}$' } }],
        requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', required: ['requestId'], additionalProperties: false,
            properties: { requestId: { type: 'string', minLength: 1, maxLength: 100,
                description: 'Identificador idempotente gerado para a ação do operador.' } }
        } } } }, responses: operationalResponses
    } }
};

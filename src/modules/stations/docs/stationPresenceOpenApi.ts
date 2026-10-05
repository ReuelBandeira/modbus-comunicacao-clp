const response = (description: string) => ({ description });

export const stationPresencePaths = {
    '/api/stations/end-of-line/status': { get: {
        tags: ['Estações'], summary: 'Consultar presença da estação de Final de Linha',
        description: 'Em produção, a presença deve estar dentro do prazo do heartbeat para permitir novas leituras.',
        responses: { '200': response('Estado atual, obrigatoriedade, último heartbeat e timeout.') }
    } },
    '/api/stations/end-of-line/heartbeat': { post: {
        tags: ['Estações'], summary: 'Confirmar presença do aplicativo de Final de Linha',
        requestBody: { required: true, content: { 'application/json': {
            schema: { type: 'object', required: ['role'], additionalProperties: false,
                properties: { role: { type: 'string', enum: ['end-of-line'] } } },
            example: { role: 'end-of-line' }
        } } },
        responses: { '200': response('Presença renovada.'), '400': response('Heartbeat inválido.') }
    } }
};

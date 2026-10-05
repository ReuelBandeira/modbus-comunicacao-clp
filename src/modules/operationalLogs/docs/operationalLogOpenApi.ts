const responses = { 200: { description: 'Consulta realizada.' }, 400: { description: 'Filtros inválidos.' },
    401: { description: 'Sessão ADMIN ausente ou expirada.' }, 503: { description: 'Registro operacional indisponível.' } };

export const operationalLogPaths = {
    '/api/operational-logs': { get: { tags: ['Registro operacional'], summary: 'Consultar auditoria operacional persistida',
        security: [{ bearerAuth: [] }], parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'category', in: 'query', schema: { type: 'string', enum: ['authentication', 'production', 'operators', 'shifts', 'oee', 'plc', 'configuration', 'integration', 'system'] } },
            { name: 'outcome', in: 'query', schema: { type: 'string', enum: ['success', 'failure'] } },
            { name: 'actor', in: 'query', schema: { type: 'string', maxLength: 100 } },
            { name: 'search', in: 'query', schema: { type: 'string', maxLength: 100 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } }
        ], responses } }
};

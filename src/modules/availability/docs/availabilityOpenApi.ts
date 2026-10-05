const ok = { description: 'Operação confirmada.' };
const errors = { '400': { description: 'Dados ou período inválido.' }, '401': { description: 'Sessão ADMIN ausente ou expirada.' },
    '404': { description: 'Cadastro não encontrado.' }, '409': { description: 'Conflito com o estado atual ou histórico.' },
    '503': { description: 'MongoDB não configurado ou operação não confirmada.' } };
const responses = { '200': ok, ...errors };
const admin = [{ bearerAuth: [] }];
const id = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string', format: 'uuid' } });
const json = (required: string[], properties: Record<string, unknown>) => ({ required: true,
    content: { 'application/json': { schema: { type: 'object', required, additionalProperties: false, properties } } } });
const period = [
    { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
    { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
    { name: 'timezoneOffsetMinutes', in: 'query', required: true, schema: { type: 'integer', minimum: -840, maximum: 840 } }
];
const reasonBody = json(['code', 'name', 'classification', 'countsAgainstAvailability', 'active'], {
    code: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,40}$' }, name: { type: 'string', maxLength: 100 },
    classification: { type: 'string', enum: ['planned', 'unplanned'] }, countsAgainstAvailability: { type: 'boolean' }, active: { type: 'boolean' }
});
const breakBody = json(['shiftId', 'name', 'startTime', 'endTime', 'excludeFromPlannedTime', 'active'], {
    shiftId: { type: 'string', format: 'uuid' }, name: { type: 'string', maxLength: 100 },
    startTime: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' }, endTime: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' },
    excludeFromPlannedTime: { type: 'boolean' }, active: { type: 'boolean' }
});

export const availabilityPaths = {
    '/api/availability/current': { get: { tags: ['OEE e disponibilidade'], summary: 'Consultar estado atual, turno e paradas recentes', responses } },
    '/api/availability/report': { get: { tags: ['OEE e disponibilidade'], summary: 'Calcular indicadores OEE no período',
        description: 'Performance e OEE são calculados quando o tempo de ciclo ideal estiver configurado.', parameters: period, responses } },
    '/api/availability/configuration': {
        get: { tags: ['OEE e disponibilidade'], summary: 'Consultar configuração do OEE e estado físico', security: admin, responses },
        put: { tags: ['OEE e disponibilidade'], summary: 'Configurar OEE e consolidação física', security: admin,
            requestBody: json([], { idealCycleTimeSeconds: { type: 'number', minimum: 0.001, maximum: 3600 },
                physicalMonitoring: { type: 'object', additionalProperties: false,
                    required: ['enabled', 'strategy', 'stopConfirmationMs', 'resumeConfirmationMs',
                        'manualContingencyEnabled', 'manualContingencyRequiresAdmin'], properties: {
                        enabled: { type: 'boolean' }, strategy: { type: 'string',
                            enum: ['serial_any_running', 'all_required', 'reference_signal'] },
                        stopConfirmationMs: { type: 'integer', minimum: 0, maximum: 600000 },
                        resumeConfirmationMs: { type: 'integer', minimum: 0, maximum: 600000 },
                        defaultReasonId: { type: 'string', format: 'uuid' }, referenceSignalId: { type: 'string', format: 'uuid' },
                        manualContingencyEnabled: { type: 'boolean' }, manualContingencyRequiresAdmin: { type: 'boolean' }
                    } }
            }), responses }
    },
    '/api/availability/stops': { post: { tags: ['OEE e disponibilidade'], summary: 'Registrar parada manual',
        requestBody: json(['reasonId', 'requestId'], { reasonId: { type: 'string', format: 'uuid' }, notes: { type: 'string', maxLength: 500 }, requestId: { type: 'string', format: 'uuid' } }), responses } },
    '/api/availability/stops/{eventId}/classify': { post: { tags: ['OEE e disponibilidade'], summary: 'Classificar parada automática',
        parameters: [id('eventId')], requestBody: json(['reasonId'], { reasonId: { type: 'string', format: 'uuid' },
            notes: { type: 'string', maxLength: 500 } }), responses } },
    '/api/availability/resume': { post: { tags: ['OEE e disponibilidade'], summary: 'Registrar retomada manual',
        requestBody: json(['requestId'], { requestId: { type: 'string', format: 'uuid' } }), responses } },
    '/api/availability/reasons': {
        get: { tags: ['OEE e disponibilidade'], summary: 'Listar motivos de parada', responses },
        post: { tags: ['OEE e disponibilidade'], summary: 'Cadastrar motivo de parada', security: admin, requestBody: reasonBody, responses }
    },
    '/api/availability/reasons/{reasonId}': {
        put: { tags: ['OEE e disponibilidade'], summary: 'Editar motivo de parada', security: admin, parameters: [id('reasonId')], requestBody: reasonBody, responses },
        delete: { tags: ['OEE e disponibilidade'], summary: 'Remover motivo nunca utilizado', security: admin, parameters: [id('reasonId')], responses }
    },
    '/api/availability/breaks': {
        get: { tags: ['OEE e disponibilidade'], summary: 'Listar pausas dos turnos', security: admin, responses },
        post: { tags: ['OEE e disponibilidade'], summary: 'Cadastrar pausa de turno', security: admin, requestBody: breakBody, responses }
    },
    '/api/availability/breaks/{breakId}': {
        put: { tags: ['OEE e disponibilidade'], summary: 'Editar pausa de turno', security: admin, parameters: [id('breakId')], requestBody: breakBody, responses },
        delete: { tags: ['OEE e disponibilidade'], summary: 'Remover pausa de turno', security: admin, parameters: [id('breakId')], responses }
    },
    '/api/availability/calendar': {
        get: { tags: ['OEE e disponibilidade'], summary: 'Listar exceções do calendário', security: admin, responses },
        post: { tags: ['OEE e disponibilidade'], summary: 'Cadastrar exceção do calendário', security: admin,
            requestBody: json(['shiftId', 'date', 'productionEnabled'], { shiftId: { type: 'string', format: 'uuid' },
                date: { type: 'string', format: 'date' }, productionEnabled: { type: 'boolean' }, notes: { type: 'string', maxLength: 300 } }), responses }
    },
    '/api/availability/calendar/{exceptionId}': { delete: { tags: ['OEE e disponibilidade'], summary: 'Remover exceção do calendário',
        security: admin, parameters: [id('exceptionId')], responses } }
};

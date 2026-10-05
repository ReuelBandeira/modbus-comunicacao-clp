import type { Express } from 'express';
import swaggerUi = require('swagger-ui-express');
import { openApiDocument } from './openApi';

export function registerSwagger(app: Express): void {
    app.get('/api-docs/openapi.json', (_req, res) => { res.json(openApiDocument); });
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiDocument, {
        customSiteTitle: 'PCM · Documentação da API',
        swaggerOptions: { validatorUrl: null, persistAuthorization: false }
    }));
}

import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ApiResponseDto } from '../dtos/apiResponseDto';

export const notFound: RequestHandler<Record<string, string>, ApiResponseDto, unknown> = (_req, res) => {
    res.status(404).json({ status: 'ERROR', msg: 'Rota não encontrada.' });
};
export const handleError: ErrorRequestHandler<Record<string, string>, ApiResponseDto, unknown> = (error, req, res, _next) => {
    const status = error.status === 413 ? 413 : error.status === 415 ? 415 : error.status === 400 ? 400 : 500;
    const messages = { 400: 'JSON inválido.', 413: 'Corpo da requisição excede o limite permitido.', 415: 'Codificação não suportada.', 500: 'Erro interno.' };
    if (req.path.startsWith('/api/test-results')) console.warn(`[IFTS] Requisição rejeitada antes do processamento: HTTP ${status}.`);
    res.status(status).json({ status: 'ERROR', msg: messages[status] });
};

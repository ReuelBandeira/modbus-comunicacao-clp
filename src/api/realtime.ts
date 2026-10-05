import type { RequestHandler } from 'express';
import type { LineCoordinatorService } from '../modules/pcm/workflow/services/lineCoordinatorService';
import { identifier } from '../modules/machines/validators/lineValidation';

export function createRealtimeHandler(coordinator?: LineCoordinatorService): RequestHandler {
    return async (req, res) => {
        if (!coordinator) { res.status(503).json({ status: 'ERROR', msg: 'Controle da linha indisponível.' }); return; }
        let lineId: string;
        try { lineId = identifier(String(req.query.lineId || ''), 'lineId'); }
        catch { res.status(400).json({ status: 'ERROR', msg: 'lineId inválido.' }); return; }
        res.status(200);
        res.set({
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();
        res.write('retry: 2000\n\n');
        let closed = false, signature = '';
        const publish = async () => {
            if (closed) return;
            try {
                const dashboard = await coordinator.dashboard(lineId);
                const nextSignature = JSON.stringify({ line: dashboard.line, snapshot: dashboard.snapshot });
                if (nextSignature !== signature) {
                    signature = nextSignature;
                    res.write(`event: line:state\ndata: ${JSON.stringify(dashboard)}\n\n`);
                }
            } catch (error) {
                res.write(`event: server:error\ndata: ${JSON.stringify({ message: (error as Error).message })}\n\n`);
            }
        };
        await publish();
        const refresh = setInterval(() => { void publish(); }, 1000);
        const heartbeat = setInterval(() => { if (!closed) res.write(': heartbeat\n\n'); }, 15000);
        const close = () => { closed = true; clearInterval(refresh); clearInterval(heartbeat); };
        req.once('close', close);
        res.once('close', close);
    };
}

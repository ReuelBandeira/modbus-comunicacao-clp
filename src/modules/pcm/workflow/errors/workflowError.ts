export class WorkflowError extends Error {
    constructor(public readonly status: 400 | 404 | 409 | 503, message: string) { super(message); }
}

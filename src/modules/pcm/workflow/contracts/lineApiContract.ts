export interface LineApiResponse { httpStatus: number; status: string; data?: unknown; msg?: string; }

export interface LineApiContract {
    request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, authorization?: string): Promise<LineApiResponse>;
}

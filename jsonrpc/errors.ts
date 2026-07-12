/** Thrown when a core RPC method is not yet backed by madcore logic. */
export class RpcNotImplemented extends Error {
    readonly method: string;
    constructor(method: string, detail?: string) {
        super(
            detail
                ? `JSON-RPC method not implemented in madcore: ${method} (${detail})`
                : `JSON-RPC method not implemented in madcore: ${method}`,
        );
        this.name = 'RpcNotImplemented';
        this.method = method;
    }
}

/** Thrown for invalid parameters / missing account. */
export class RpcError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RpcError';
    }
}

declare module "pg" {
  export class Pool {
    constructor(config?: {
      connectionString?: string;
      max?: number;
      idleTimeoutMillis?: number;
      connectionTimeoutMillis?: number;
    });
    on(event: "error", listener: (error: Error) => void): this;
    end(): Promise<void>;
  }
}

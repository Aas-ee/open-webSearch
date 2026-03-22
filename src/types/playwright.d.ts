declare module 'playwright' {
    export const chromium: {
        launch(options?: any): Promise<any>;
        connect(options: { wsEndpoint: string; timeout?: number; headers?: Record<string, string> }): Promise<any>;
        connectOverCDP(endpoint: string, options?: any): Promise<any>;
    };
}

declare module 'playwright-core' {
    export const chromium: {
        launch(options?: any): Promise<any>;
        connect(options: { wsEndpoint: string; timeout?: number; headers?: Record<string, string> }): Promise<any>;
        connectOverCDP(endpoint: string, options?: any): Promise<any>;
    };
}

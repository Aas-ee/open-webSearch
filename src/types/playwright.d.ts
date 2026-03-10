declare module 'playwright' {
    export const chromium: {
        launch(options?: any): Promise<any>;
    };
}

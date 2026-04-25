declare module 'koffi' {
    export interface IKoffiCType {}

    export interface IKoffiFunction {
        (...args: any[]): any;
        async?: (...args: any[]) => any;
    }

    export interface IKoffiLibrary {
        func(signature: string): IKoffiFunction;
    }

    export function load(path: string): IKoffiLibrary;
    export function struct(name: string, fields: Record<string, string>): IKoffiCType;
    export function address(value: unknown): bigint;
    export function sizeof(type: string | IKoffiCType): number;
}

export type ControlOk<T> = { ok: true } & T;
export type ControlErr<C extends string> = { ok: false; code: C; message: string };
export type ControlOp<T, C extends string = never> = Promise<ControlOk<T> | ControlErr<"not_found" | "forbidden" | C>>;

export const fail = <C extends string>(code: C, message: string): ControlErr<C> => ({ ok: false, code, message });

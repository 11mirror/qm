interface ModelDispatch {
  responded: boolean;
  gateway?: Record<string, string>;
}

interface CapturedRequest {
  envelope: unknown;
  truncated: boolean;
  transport?: { modelId?: string; headers?: Record<string, string> };
}

export interface ModelCallLog {
  count(): number;
  dispatched(): void;
  responded(gateway: () => Record<string, string> | undefined): void;
  capture(request: CapturedRequest): void;
  takeCaptured(): CapturedRequest[];
  takeDispatches(): ModelDispatch[];
}

export function createModelCallLog(): ModelCallLog {
  let calls = 0;
  let captured: CapturedRequest[] | undefined = [];
  let dispatches: ModelDispatch[] | undefined = [];
  return {
    count: () => calls,
    dispatched: () => {
      calls += 1;
      (dispatches ??= []).push({ responded: false });
    },
    responded: (gateway) => {
      const last = dispatches?.at(-1);
      if (!last || last.responded) return;
      last.responded = true;
      const headers = gateway();
      if (headers) last.gateway = headers;
    },
    capture: (request) => {
      captured?.push(request);
    },
    takeCaptured: () => {
      const taken = captured ?? [];
      captured = undefined;
      return taken;
    },
    takeDispatches: () => {
      const taken = dispatches ?? [];
      dispatches = undefined;
      return taken;
    },
  };
}

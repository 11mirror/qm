import { createServer } from "node:net";

export const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

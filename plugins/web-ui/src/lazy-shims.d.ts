declare module "katex-real" {
  const katex: { renderToString: (text: string, opts?: object) => string };
  export default katex;
}
declare module "hljs-real" {
  const hljs: unknown;
  export default hljs;
}
declare module "hljs-real-*" {
  const lang: unknown;
  export default lang;
}

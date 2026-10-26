import { swallowAs } from "../../chassis/src/errors.ts";

const MAX_ANNOTATION_TEXT = 20_000;
const MAX_ANNOTATION_BYTES = 20 * 1024 * 1024;
const MAX_ANNOTATION_FILES = 2;

export function watchAppAnnotations(
  slug: string,
  add: (text: string, files: File[], annotationId?: string, remove?: boolean) => boolean | Promise<boolean>,
): () => void {
  const seen = new Set<string>();
  let queue = Promise.resolve();
  let active = true;
  const receive = async (event: MessageEvent): Promise<void> => {
    if (!active) return;
    if (window.parent === window || event.source !== window.parent) return;
    const data = event.data as {
      type?: unknown;
      id?: unknown;
      text?: unknown;
      files?: unknown;
      annotationId?: unknown;
      remove?: unknown;
    } | null;
    if (data?.type !== "qm:annotations" || typeof data.id !== "string" || typeof data.text !== "string") return;
    if (
      data.annotationId !== undefined &&
      (typeof data.annotationId !== "string" || !data.annotationId || data.annotationId.length > 256)
    )
      return;
    let host: string;
    try {
      host = new URL(event.origin).hostname;
    } catch {
      return;
    }
    if (!host.startsWith(`${slug}.`)) return;
    const files = Array.isArray(data.files)
      ? data.files.filter(
          (f): f is File => f instanceof File && f.type === "image/png" && f.size <= MAX_ANNOTATION_BYTES,
        )
      : [];
    if (!seen.has(data.id)) {
      const notes = [
        data.text.length > MAX_ANNOTATION_TEXT ? `[Annotation text cut at ${MAX_ANNOTATION_TEXT} characters.]` : "",
        files.length > MAX_ANNOTATION_FILES
          ? `[${files.length - MAX_ANNOTATION_FILES} more screenshot(s) left out; only ${MAX_ANNOTATION_FILES} are attached.]`
          : "",
      ].filter(Boolean);
      if (
        !(await add(
          [data.text.slice(0, MAX_ANNOTATION_TEXT), ...notes].join("\n\n"),
          files.slice(0, MAX_ANNOTATION_FILES),
          data.annotationId as string | undefined,
          data.remove === true,
        ))
      )
        return;
      seen.add(data.id);
    }
    (event.source as Window).postMessage({ type: "qm:annotations-ack", id: data.id }, event.origin);
  };
  const onMessage = (event: MessageEvent): void => {
    queue = queue.then(() => receive(event)).catch(swallowAs("web-ui: app annotation message", undefined));
  };
  window.addEventListener("message", onMessage);
  return () => {
    active = false;
    window.removeEventListener("message", onMessage);
  };
}

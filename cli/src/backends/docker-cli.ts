import { CliError, die, errMessage } from "../log.ts";
import { capture, runInherit, which } from "../util.ts";

export function requireDocker(): void {
  if (!which("docker")) die("docker not found on PATH (the docker target needs a running Docker daemon).");
  try {
    capture("docker", ["version", "-f", "{{.Server.Version}}"]);
  } catch {
    die("the Docker daemon is not reachable — start Docker (or OrbStack) and retry.");
  }
}

export function docker(args: string[], allow?: RegExp): string {
  try {
    return capture("docker", args, allow ? { allow } : {});
  } catch (e) {
    throw dockerError(args, errMessage(e));
  }
}

export function dockerInherit(args: string[], hint?: string): void {
  try {
    runInherit("docker", args);
  } catch (error) {
    throw new CliError(`docker ${args.slice(0, 2).join(" ")} failed: ${errMessage(error)}${hint ? `\n${hint}` : ""}`, {
      cause: error,
    });
  }
}

function dockerError(args: string[], message: string): CliError {
  let hint = "";
  if (/port is already allocated|address already in use/i.test(message)) {
    hint = `\nhint: a host port is already in use — set QM_BASE_PORT to a free base port.`;
  }
  return new CliError(`docker ${args.slice(0, 3).join(" ")}… failed:\n${message}${hint}`);
}

export function containerRunning(name: string): boolean {
  try {
    return docker(["inspect", "-f", "{{.State.Running}}", name], /No such object/).trim() === "true";
  } catch {
    return false;
  }
}

function inspectExists(args: string[], notFound: RegExp): boolean {
  const out = docker(args, notFound);
  return out.trim().length > 0 && !notFound.test(out);
}

export function containerExists(name: string): boolean {
  return inspectExists(["inspect", "-f", "{{.Id}}", name], /No such object|No such container/i);
}

export function volumeExists(name: string): boolean {
  return inspectExists(["volume", "inspect", "-f", "{{.Name}}", name], /No such volume|not found/i);
}

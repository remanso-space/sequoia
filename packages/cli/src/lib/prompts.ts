import { isCancel, cancel } from "@clack/prompts";

export function exitOnCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Cancelled");
    process.exit(0);
  }
  return value as T;
}

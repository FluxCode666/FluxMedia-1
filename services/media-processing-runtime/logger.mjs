export function logWarn(message, details = {}) {
  console.warn(JSON.stringify({ level: "warn", service: "media-processing-runtime", message, ...details }));
}

/**
 * OpenClaw tool success shape — mirrors `jsonResult` from `openclaw/plugin-sdk`.
 * Implemented locally so DevClaw tools work when the host resolves `openclaw/plugin-sdk`
 * in a way that breaks named imports (e.g. interop / bundling).
 */
export function jsonResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

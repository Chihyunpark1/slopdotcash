/** Field-specific validation for exact, self-reported model-run identity. */

const IDENTITY_PATTERN =
  /^[@~]?[A-Za-z0-9](?:[A-Za-z0-9._:@/+~-]{0,126}[A-Za-z0-9])?$/u;

const COMMON_PLACEHOLDERS = new Set([
  "na",
  "none",
  "null",
  "other",
  "placeholder",
  "tbd",
  "todo",
  "unknown",
  "unspecified",
]);
const PROVIDER_PLACEHOLDERS = new Set(["ai", "model", "provider"]);
const MODEL_PLACEHOLDERS = new Set([
  "ai",
  "claude",
  "gemini",
  "gpt",
  "grok",
  "llama",
  "llm",
  "model",
]);
const CLIENT_PLACEHOLDERS = new Set(["agent", "app", "cli", "client"]);
const VERSION_PLACEHOLDERS = new Set(["current", "latest", "version"]);

/**
 * The one supported declaration for a run whose exact model could not be
 * established from client or provider metadata. It is never an exact model:
 * signed receipts and private traces still require one.
 */
export const UNAVAILABLE_MODEL_IDENTIFIER = "unavailable";

function normalizedPlaceholder(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

function exactIdentity(
  value: unknown,
  maxLength: number,
  fieldPlaceholders: ReadonlySet<string>,
): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    !IDENTITY_PATTERN.test(value)
  ) {
    return false;
  }
  const normalized = normalizedPlaceholder(value);
  return (
    !COMMON_PLACEHOLDERS.has(normalized) && !fieldPlaceholders.has(normalized)
  );
}

export function isExactProviderIdentifier(value: unknown): value is string {
  return exactIdentity(value, 64, PROVIDER_PLACEHOLDERS);
}

export function isExactModelIdentifier(value: unknown): value is string {
  return (
    exactIdentity(value, 128, MODEL_PLACEHOLDERS) &&
    normalizedPlaceholder(value) !== UNAVAILABLE_MODEL_IDENTIFIER
  );
}

export function isUnavailableModelIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.toLowerCase() === UNAVAILABLE_MODEL_IDENTIFIER
  );
}

/** An exact model, or the explicit statement that none could be established. */
export function isDeclaredModelIdentifier(value: unknown): value is string {
  return isExactModelIdentifier(value) || isUnavailableModelIdentifier(value);
}

/**
 * Validates the public `provider/model` form without assuming that the first
 * slash is the separator. Exact provider and model identifiers may themselves
 * contain slashes, so every possible boundary must be considered.
 */
export function isExactProviderModelIdentifier(
  value: unknown,
): value is string {
  if (typeof value !== "string") return false;
  for (
    let index = value.indexOf("/");
    index >= 0;
    index = value.indexOf("/", index + 1)
  ) {
    if (
      isExactProviderIdentifier(value.slice(0, index)) &&
      isExactModelIdentifier(value.slice(index + 1))
    ) {
      return true;
    }
  }
  return false;
}

export function isExactClientIdentifier(value: unknown): value is string {
  return exactIdentity(value, 64, CLIENT_PLACEHOLDERS);
}

export function isExactClientVersion(value: unknown): value is string {
  return exactIdentity(value, 128, VERSION_PLACEHOLDERS);
}

export function assertExactModelIdentity(input: {
  provider: unknown;
  model: unknown;
  client: unknown;
}): asserts input is { provider: string; model: string; client: string } {
  if (!isExactProviderIdentifier(input.provider)) {
    throw new TypeError("provider must be an exact non-placeholder identifier");
  }
  if (!isExactModelIdentifier(input.model)) {
    throw new TypeError("model must be an exact non-placeholder identifier");
  }
  if (!isExactClientIdentifier(input.client)) {
    throw new TypeError("client must be an exact non-placeholder identifier");
  }
}

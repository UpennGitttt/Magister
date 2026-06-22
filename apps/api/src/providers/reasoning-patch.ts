import type {
  ModelProfile,
  ProviderConfig,
  ProviderReasoningPolicy,
} from "./types";

function resolveProviderFamily(provider: ProviderConfig, model: ModelProfile) {
  const haystack = [provider.id, provider.label, provider.vendor, model.id, model.label, model.modelName]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .join(" ")
    .toLowerCase();

  if (haystack.includes("moonshot") || haystack.includes("kimi")) {
    return "kimi" as const;
  }
  if (haystack.includes("bigmodel") || haystack.includes("glm") || haystack.includes("zhipu")) {
    return "glm" as const;
  }
  if (haystack.includes("dashscope") || haystack.includes("qwen") || haystack.includes("aliyun")) {
    return "dashscope" as const;
  }
  if (haystack.includes("deepseek")) {
    return "deepseek" as const;
  }
  return "generic" as const;
}

export function resolveReasoningPolicy(
  model: ModelProfile,
  override?: ProviderReasoningPolicy,
): ProviderReasoningPolicy | undefined {
  const base = model.defaultReasoning;
  if (!base && !override) {
    return undefined;
  }

  const mode = override?.mode ?? base?.mode ?? "auto";
  const effort = override?.effort ?? base?.effort;
  const budgetTokens = override?.budgetTokens ?? base?.budgetTokens;
  const visibility = override?.visibility ?? base?.visibility;

  return {
    mode,
    ...(effort ? { effort } : {}),
    ...(typeof budgetTokens === "number" && budgetTokens > 0 ? { budgetTokens } : {}),
    ...(visibility ? { visibility } : {}),
  };
}

export function buildReasoningPatch(
  provider: ProviderConfig,
  model: ModelProfile,
  reasoningPolicy?: ProviderReasoningPolicy,
): Record<string, unknown> {
  const effectivePolicy = resolveReasoningPolicy(model, reasoningPolicy);
  if (!effectivePolicy) {
    return {};
  }

  if (provider.apiDialect === "anthropic_messages") {
    if (effectivePolicy.mode === "off") {
      return {};
    }

    // Anthropic-compat providers diverge on the "let the model decide"
    // sentinel. Anthropic's Claude API only accepts "enabled" (or omit);
    // DeepSeek accepts {"adaptive", "enabled", "disabled"}.
    //
    // When mode === "on" we emit "enabled" (both accept). When mode ===
    // "auto", route by provider family: DeepSeek gets "adaptive",
    // everyone else gets the patch OMITTED (model default behavior).
    if (effectivePolicy.mode === "on") {
      return {
        thinking: {
          type: "enabled",
          ...(effectivePolicy.budgetTokens
            ? { budget_tokens: effectivePolicy.budgetTokens }
            : {}),
        },
      };
    }

    // mode === "auto" (or any value other than "on" / "off")
    const family = resolveProviderFamily(provider, model);
    if (family === "deepseek") {
      return {
        thinking: {
          type: "adaptive",
          ...(effectivePolicy.budgetTokens
            ? { budget_tokens: effectivePolicy.budgetTokens }
            : {}),
        },
      };
    }
    // Anthropic Claude (default anthropic_messages target) doesn't
    // accept "auto" — omit the patch so the request goes out without
    // a thinking field, which Claude treats as "no extended thinking
    // requested" (its non-thinking default behavior).
    return {};
  }

  const family = resolveProviderFamily(provider, model);
  const enabled = effectivePolicy.mode !== "off";

  switch (family) {
    case "kimi":
      return {
        thinking: {
          type: enabled ? "enabled" : "disabled",
        },
        ...(effectivePolicy.budgetTokens
          ? { thinking_budget: effectivePolicy.budgetTokens }
          : {}),
      };
    case "glm":
      return {
        thinking: {
          type: enabled ? "enabled" : "disabled",
          clear_thinking: effectivePolicy.visibility === "full" ? false : true,
        },
      };
    case "dashscope":
      return {
        enable_thinking: enabled,
        ...(effectivePolicy.budgetTokens
          ? { thinking_budget: effectivePolicy.budgetTokens }
          : {}),
      };
    default:
      if (provider.apiDialect !== "openai_chat_completions" || !enabled) {
        return {};
      }

      const effortMap: Record<string, "low" | "medium" | "high"> = {
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "high",
      };
      const effort = effectivePolicy.effort ? effortMap[effectivePolicy.effort] : undefined;
      return effort ? { reasoning_effort: effort } : {};
  }
}

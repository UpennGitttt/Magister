import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { getAgentModels } from "../../lib/api";
import type { DiscoveredModel } from "../../lib/types";

type RuntimeType = "ucm" | "codex" | "opencode" | "claude-code" | "kiro";

type ModelSelectorProps = {
  runtimeType: RuntimeType;
  agentId: string;
  commandPath?: string;
  /** Draft provider id from the parent form. When the user picks a
   *  new provider in the dropdown but hasn't saved yet, this lets us
   *  refetch the model list for the chosen provider — without it the
   *  backend reads the old saved providerId and the model list stays
   *  stale (e.g. switching from volceengine to minimax still shows
   *  volce models). */
  providerId?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

type DiscoveryState = {
  models: DiscoveredModel[];
  supported: boolean;
  error: string | null;
};

type OptionItem =
  | {
      kind: "model";
      key: string;
      provider: string;
      model: DiscoveredModel;
      value: string;
    }
  | {
      kind: "custom";
      key: string;
      value: string;
    };

function normalizeProvider(value: string | null | undefined): string {
  const provider = value?.trim();
  return provider && provider.length > 0 ? provider : "unknown";
}

function groupModelsByProvider(models: DiscoveredModel[]): Array<{ provider: string; models: DiscoveredModel[] }> {
  const buckets = new Map<string, DiscoveredModel[]>();

  for (const model of models) {
    const provider = normalizeProvider(model.provider);
    const existing = buckets.get(provider) ?? [];
    existing.push(model);
    buckets.set(provider, existing);
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, items]) => ({
      provider,
      models: [...items].sort((left, right) => left.label.localeCompare(right.label)),
    }));
}

export function ModelSelector({
  runtimeType,
  agentId,
  commandPath,
  providerId,
  value,
  onChange,
  disabled = false,
}: ModelSelectorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState(value);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (!open) {
      setSearch(value);
    }
  }, [open, value]);

  useEffect(() => {
    let active = true;
    const normalizedAgentId = agentId.trim();

    if (!normalizedAgentId) {
      setModels([]);
      setSupported(true);
      setError(null);
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    setError(null);
    getAgentModels(normalizedAgentId, {
      runtimeType,
      ...(commandPath ? { commandPath } : {}),
      ...(providerId ? { providerId } : {}),
      refresh: true,
    })
      .then((result) => {
        if (!active) {
          return;
        }

        const nextState: DiscoveryState = {
          models: result.models ?? [],
          supported: result.supported !== false,
          error: null,
        };
        setModels(nextState.models);
        setSupported(nextState.supported);
      })
      .catch((err) => {
        if (!active) {
          return;
        }

        const message = err instanceof Error ? err.message : "Failed to load models";
        // Don't cache errors — allow retry on next mount
        setModels([]);
        setSupported(true);
        setError(message);
      })
      .finally(() => {
        if (!active) {
          return;
        }
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [agentId, runtimeType, commandPath, providerId, refreshToken]);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current) {
        return;
      }
      if (!rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, []);

  const groupedModels = useMemo(() => groupModelsByProvider(models), [models]);

  const filteredGroups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) {
      return groupedModels;
    }

    return groupedModels
      .map((group) => ({
        provider: group.provider,
        models: group.models.filter((model) => {
          const haystack = `${model.id} ${model.label} ${model.provider}`.toLowerCase();
          return haystack.includes(needle);
        }),
      }))
      .filter((group) => group.models.length > 0);
  }, [groupedModels, search]);

  const normalizedSearch = search.trim();
  const hasSearch = normalizedSearch.length > 0;
  const normalizedSearchLower = normalizedSearch.toLowerCase();
  const hasExactMatch = models.some((model) => {
    return model.id.toLowerCase() === normalizedSearchLower || model.label.toLowerCase() === normalizedSearchLower;
  });

  const optionList = useMemo(() => {
    const options: OptionItem[] = [];
    for (const group of filteredGroups) {
      for (const model of group.models) {
        options.push({
          kind: "model",
          key: `model:${model.id}`,
          provider: group.provider,
          model,
          value: model.id,
        });
      }
    }

    if (hasSearch && !hasExactMatch) {
      options.push({
        kind: "custom",
        key: `custom:${normalizedSearch}`,
        value: normalizedSearch,
      });
    }

    return options;
  }, [filteredGroups, hasExactMatch, hasSearch, normalizedSearch]);

  useEffect(() => {
    if (!open) {
      setHighlightedIndex(-1);
      return;
    }

    if (optionList.length === 0) {
      setHighlightedIndex(-1);
      return;
    }

    const selectedIndex = optionList.findIndex((option) => option.value === value);
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, optionList, value]);

  function selectValue(nextValue: string) {
    onChange(nextValue);
    setOpen(false);
    setSearch(nextValue);
  }

  function moveHighlight(step: -1 | 1) {
    if (!open) {
      setOpen(true);
      return;
    }

    if (optionList.length === 0) {
      return;
    }

    setHighlightedIndex((prev) => {
      if (prev < 0) {
        return step === 1 ? 0 : optionList.length - 1;
      }

      const next = prev + step;
      if (next < 0) {
        return optionList.length - 1;
      }
      if (next >= optionList.length) {
        return 0;
      }
      return next;
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(-1);
      return;
    }

    if (event.key === "Enter") {
      if (!open) {
        return;
      }
      event.preventDefault();
      if (highlightedIndex < 0 || highlightedIndex >= optionList.length) {
        return;
      }
      const highlighted = optionList[highlightedIndex];
      if (!highlighted) {
        return;
      }
      selectValue(highlighted.value);
      return;
    }

    if (event.key === "Escape") {
      setOpen(false);
      setSearch(value);
    }
  }

  const fallbackToManualInput = !loading && (error !== null || models.length === 0);
  const showDropdown = !loading && !fallbackToManualInput && supported;
  const listboxId = `model-selector-${agentId.replace(/[^a-zA-Z0-9_-]/g, "-")}-listbox`;

  if (!supported && !loading) {
    return (
      <div
        style={{
          border: "1px dashed var(--border)",
          borderRadius: "var(--radius-md)",
          background: "var(--surface)",
          color: "var(--muted)",
          padding: "10px 14px",
          fontSize: "14px",
        }}
      >
        Model selection is managed by this runtime
      </div>
    );
  }

  if (fallbackToManualInput) {
    return (
      <div style={{ display: "grid", gap: "6px" }}>
        <input
          className="config-input"
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Enter model name manually"
          autoComplete="off"
          disabled={disabled}
        />
        {error ? (
          <span className="settings-error">{error}</span>
        ) : (
          <span style={{ color: "var(--muted)", fontSize: "12px" }}>
            No models discovered for this CLI — it may not be logged in or configured yet. Type any
            model name to use it directly (Magister passes it as <code>--model</code>).
          </span>
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} style={{ position: "relative", display: "grid", gap: "6px" }}>
      <input
        className="config-input"
        role="combobox"
        aria-expanded={open && showDropdown && !disabled}
        aria-controls={showDropdown ? listboxId : undefined}
        aria-autocomplete="list"
        type="text"
        value={open ? search : value}
        onFocus={() => {
          setSearch(value);
          setOpen(true);
        }}
        onChange={(event) => {
          setSearch(event.target.value);
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        placeholder="Search models..."
        autoComplete="off"
        disabled={disabled}
        onClick={() => {
          setRefreshToken((prev) => prev + 1);
        }}
      />

      {loading ? (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--muted)" }}>
          <span className="status-dot status-dot--active" aria-hidden="true" />
          <span>Discovering models...</span>
        </div>
      ) : null}

      {showDropdown && open && !disabled ? (
        <div
          id={listboxId}
          role="listbox"
          style={{
            position: "absolute",
            zIndex: 30,
            top: "calc(100% + 6px)",
            left: 0,
            right: 0,
            maxHeight: "260px",
            overflowY: "auto",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            background: "var(--bg)",
            boxShadow: "var(--shadow-card)",
            padding: "6px",
          }}
        >
          {filteredGroups.length === 0 && !hasSearch ? (
            <div style={{ padding: "8px 10px", color: "var(--muted)", fontSize: "14px" }}>
              No models found.
            </div>
          ) : null}

          {filteredGroups.map((group) => (
            <div key={group.provider} style={{ marginBottom: "2px" }}>
              <div
                style={{
                  color: "var(--subtle)",
                  fontSize: "11px",
                  fontWeight: 600,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  padding: "6px 8px 4px",
                }}
              >
                {group.provider}
              </div>
              {group.models.map((model) => {
                const optionIndex = optionList.findIndex((option) => option.kind === "model" && option.value === model.id);
                const isActive = optionIndex === highlightedIndex;
                const isSelected = model.id === value;
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectValue(model.id)}
                    style={{
                      width: "100%",
                      border: "none",
                      borderRadius: "var(--radius-md)",
                      background: isActive ? "var(--surface-soft)" : "transparent",
                      color: "var(--text)",
                      textAlign: "left",
                      minHeight: "40px",
                      padding: "7px 10px",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="status-dot"
                      style={{
                        background: isSelected ? "var(--primary)" : "var(--subtle)",
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {model.label}
                      </span>
                      {model.isDefault ? (
                        <span
                          style={{
                            fontSize: "11px",
                            color: "var(--primary)",
                            border: "1px solid var(--primary)",
                            borderRadius: "999px",
                            padding: "0 6px",
                            lineHeight: "16px",
                            flexShrink: 0,
                          }}
                        >
                          default
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}

          {hasSearch && !hasExactMatch ? (
            <button
              type="button"
              role="option"
              aria-selected={false}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectValue(normalizedSearch)}
              style={{
                width: "100%",
                border: "none",
                borderRadius: "var(--radius-md)",
                background:
                  highlightedIndex >= 0 &&
                    optionList[highlightedIndex] &&
                    optionList[highlightedIndex].kind === "custom"
                    ? "var(--surface-soft)"
                    : "transparent",
                color: "var(--text)",
                textAlign: "left",
                minHeight: "40px",
                padding: "7px 10px",
                cursor: "pointer",
                overflowWrap: "anywhere",
              }}
            >
              Use custom: '{normalizedSearch}'
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

import { useState } from "react";
import type { McpPromptDescriptor } from "../../lib/api";

export function PromptArgsForm({
  prompt,
  onSubmit,
  onCancel,
  externalError,
}: {
  prompt: McpPromptDescriptor;
  onSubmit: (args: Record<string, string>) => void;
  onCancel: () => void;
  /** Set by the parent when `renderMcpPrompt` rejects so the user
   *  sees the failure inline instead of the form just disappearing. */
  externalError?: string | null;
}) {
  const [args, setArgs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const displayError = externalError ?? error;

  function update(name: string, value: string) {
    setArgs((prev) => ({ ...prev, [name]: value }));
  }

  function submit() {
    const missing = (prompt.arguments ?? [])
      .filter((a) => a.required && !args[a.name]?.trim())
      .map((a) => a.name);
    if (missing.length > 0) {
      setError(`Missing required: ${missing.join(", ")}`);
      return;
    }
    setError(null);
    onSubmit(args);
  }

  return (
    <div className="prompt-args-form">
      <div className="prompt-args-form__header">
        <strong>{prompt.serverName} / {prompt.name}</strong>
        {prompt.description ? <p className="prompt-args-form__desc">{prompt.description}</p> : null}
      </div>
      {(prompt.arguments ?? []).map((a) => (
        <label key={a.name} className="prompt-args-form__field">
          <span>
            {a.name}
            {a.required ? <span className="prompt-args-form__required">*</span> : null}
          </span>
          <input
            className="config-input"
            type="text"
            value={args[a.name] ?? ""}
            onChange={(e) => update(a.name, e.target.value)}
            placeholder={a.description ?? ""}
          />
        </label>
      ))}
      {displayError ? <p className="settings-error">{displayError}</p> : null}
      <div className="prompt-args-form__footer">
        <button type="button" className="config-edit-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="config-save-btn" onClick={submit}>Render &amp; submit</button>
      </div>
    </div>
  );
}

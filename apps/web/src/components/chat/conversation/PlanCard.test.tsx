import "../../../test-setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PlanCard } from "./PlanCard";
import {
  PLAN_TOKEN_APPROVED,
  PLAN_TOKEN_CANCELLED,
  PLAN_TOKEN_REVISED_PREFIX,
} from "./plan-tokens";
import type { PlanPart } from "./types";

const TASK_ID = "task_plan_test";

const ORIGINAL_FETCH = globalThis.fetch;

type RecordedRequest = { url: string; method?: string | undefined; body?: string | undefined };
const requests: RecordedRequest[] = [];

function installFetchMock() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    requests.push({
      url,
      method: init?.method,
      body: typeof init?.body === "string" ? init?.body : undefined,
    });
    return new Response(
      JSON.stringify({ ok: true, data: { id: "msg_1", taskId: TASK_ID } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

function makePart(overrides: Partial<PlanPart> = {}): PlanPart {
  return {
    kind: "plan",
    id: "plan_1",
    plan: "1. Inspect file\n2. Apply fix\n3. Add test",
    status: "awaiting_approval",
    ...overrides,
  };
}

beforeEach(() => {
  // Clear any DOM a prior test leaked: react-markdown portals/observers
  // occasionally survive afterEach cleanup under full-suite CPU load,
  // leaving stale PlanCard buttons that make queries match multiple
  // elements ("Found multiple elements with the role button"). Clearing
  // up front guarantees each test queries only its own render.
  cleanup();
  requests.length = 0;
  installFetchMock();
});

afterEach(() => {
  // Defensive: the global test-setup also runs cleanup() but tests in
  // this file mount large trees with portals (react-markdown can leak
  // observers), so unmount eagerly instead of trusting interleave.
  cleanup();
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("PlanCard", () => {
  test("renders plan body and shows all three actions when awaiting approval", async () => {
    const part = makePart();
    const view = render(<PlanCard part={part} taskId={TASK_ID} />);

    // react-markdown body + the card chrome can render across separate
    // passes; under full-suite CPU load a synchronous getBy can race them.
    // waitFor retries the whole set until the render settles (deflake).
    await waitFor(() => {
      expect(view.getByText(/Inspect file/i)).toBeTruthy();
      expect(view.getByText(/Awaiting your approval/i)).toBeTruthy();
      expect(view.getByRole("button", { name: /Approve/i })).toBeTruthy();
      expect(view.getByRole("button", { name: /Revise/i })).toBeTruthy();
      expect(view.getByRole("button", { name: /Cancel/i })).toBeTruthy();
    });
  });

  test("clicking Approve posts the approved sentinel to /tasks/:id/messages", async () => {
    const view = render(<PlanCard part={makePart()} taskId={TASK_ID} />);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /Approve/i }));
    });

    await waitFor(() => expect(requests.length).toBe(1));
    const req = requests[0]!;
    expect(req.url).toContain(`/tasks/${TASK_ID}/messages`);
    expect(req.method).toBe("POST");
    expect(JSON.parse(req.body!)).toEqual({ content: PLAN_TOKEN_APPROVED });
  });

  test("clicking Cancel posts the cancelled sentinel", async () => {
    const view = render(<PlanCard part={makePart()} taskId={TASK_ID} />);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /Cancel/i }));
    });

    await waitFor(() => expect(requests.length).toBe(1));
    expect(JSON.parse(requests[0]!.body!)).toEqual({ content: PLAN_TOKEN_CANCELLED });
  });

  test("Revise opens an editor; Submit posts the revised sentinel with feedback", async () => {
    const view = render(<PlanCard part={makePart()} taskId={TASK_ID} />);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /Revise/i }));
    });

    const textarea = view.getByPlaceholderText(/What should the plan change/i) as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    // Submit button is disabled when feedback is empty.
    expect(
      (view.getByRole("button", { name: /Submit revision/i }) as HTMLButtonElement).disabled,
    ).toBe(true);

    const user = userEvent.setup();
    await user.type(textarea, "Skip step 2, batch 3 and 4");
    const submit = view.getByRole("button", { name: /Submit revision/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(submit);
    });

    await waitFor(() => expect(requests.length).toBe(1));
    expect(JSON.parse(requests[0]!.body!)).toEqual({
      content: `${PLAN_TOKEN_REVISED_PREFIX}Skip step 2, batch 3 and 4`,
    });
  });

  test("non-interactive states (approved/cancelled/revised) hide the action row", () => {
    for (const status of ["approved", "cancelled", "revised"] as const) {
      const view = render(<PlanCard part={makePart({ status })} taskId={TASK_ID} />);
      expect(view.queryByRole("button", { name: /Approve/i })).toBeNull();
      expect(view.queryByRole("button", { name: /Cancel/i })).toBeNull();
      expect(view.queryByRole("button", { name: /Revise/i })).toBeNull();
      view.unmount();
    }
  });

  test("revised feedback line is rendered when present on the part", () => {
    const view = render(
      <PlanCard
        part={makePart({ status: "revised", feedback: "Trim out step 2" })}
        taskId={TASK_ID}
      />,
    );
    expect(view.getByText(/Trim out step 2/)).toBeTruthy();
    expect(view.getByText(/Revising/i)).toBeTruthy();
  });
});

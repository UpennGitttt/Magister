import "../../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { Panel } from "./Panel";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("Panel", () => {
  test("renders the title in the head", () => {
    const view = render(<Panel title="Work Queue">body</Panel>);
    expect(view.getByText("Work Queue")).toBeTruthy();
    const head = view.container.querySelector(".magister-panel__head");
    expect(head).toBeTruthy();
    expect(head!.textContent).toContain("Work Queue");
  });

  test("renders subtitle when provided", () => {
    const view = render(
      <Panel title="Agents" subtitle="Status across roles">
        body
      </Panel>,
    );
    const subtitle = view.container.querySelector(".magister-panel__subtitle");
    expect(subtitle).toBeTruthy();
    expect(subtitle!.textContent).toBe("Status across roles");
  });

  test("does not render subtitle node when omitted", () => {
    const view = render(<Panel title="Hi">body</Panel>);
    expect(view.container.querySelector(".magister-panel__subtitle")).toBeNull();
  });

  test("renders the actions slot when provided", () => {
    const view = render(
      <Panel title="X" actions={<button type="button">Refresh</button>}>
        body
      </Panel>,
    );
    const actions = view.container.querySelector(".magister-panel__actions");
    expect(actions).toBeTruthy();
    expect(actions!.textContent).toContain("Refresh");
  });

  test("does not render the actions container when no actions prop is supplied", () => {
    const view = render(<Panel title="X">body</Panel>);
    expect(view.container.querySelector(".magister-panel__actions")).toBeNull();
  });

  test("renders body children inside the body slot", () => {
    const view = render(
      <Panel title="X">
        <div data-testid="kid">hello</div>
      </Panel>,
    );
    const body = view.container.querySelector(".magister-panel__body");
    expect(body).toBeTruthy();
    expect(body!.querySelector("[data-testid='kid']")).toBeTruthy();
  });

  test("omits the body when no children are passed", () => {
    const view = render(<Panel title="X" />);
    expect(view.container.querySelector(".magister-panel__body")).toBeNull();
  });

  test("renders the footer slot when provided", () => {
    const view = render(
      <Panel title="X" footer={<span>last sync 1m ago</span>}>
        body
      </Panel>,
    );
    const foot = view.container.querySelector(".magister-panel__foot");
    expect(foot).toBeTruthy();
    expect(foot!.textContent).toContain("last sync 1m ago");
  });

  test("applies custom className alongside the base magister-panel class", () => {
    const view = render(<Panel title="X" className="my-extra">body</Panel>);
    const panel = view.container.querySelector(".magister-panel");
    expect(panel).toBeTruthy();
    expect(panel!.classList.contains("magister-panel")).toBe(true);
    expect(panel!.classList.contains("my-extra")).toBe(true);
  });
});

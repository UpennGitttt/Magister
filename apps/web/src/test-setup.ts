import { afterEach } from "bun:test";
import { act, cleanup } from "@testing-library/react";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});

class MockEventSource {
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

// vite-injected build-time constants (see apps/web/vite.config.ts).
// Under bun test there's no Vite `define` pass, so consumers that read
// these at module-eval time (e.g. DashboardPage's footer) throw
// ReferenceError. Stub with a sentinel so tests don't depend on real
// build provenance.
Object.assign(globalThis, {
  __MAGISTER_BUILD_SHA__: "test",
  __MAGISTER_BUILD_AT__: "test",
});

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
  cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  IS_REACT_ACT_ENVIRONMENT: true,
  EventSource: MockEventSource,
});

Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
  configurable: true,
  value: () => {},
});

Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
  configurable: true,
  value: () => {},
});

afterEach(async () => {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  cleanup();
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
});

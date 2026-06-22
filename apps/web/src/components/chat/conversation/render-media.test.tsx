import "../../../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { ExchangeView } from "./render";
import type { Exchange, MediaPart } from "./types";

afterEach(() => {
  cleanup();
});

function makeExchange(part: MediaPart): Exchange {
  return {
    id: "req_media",
    status: "complete",
    user: { content: "show media" },
    response: { parts: [part] },
    lastAppliedSeq: 1,
  };
}

describe("MediaPart rendering", () => {
  test("renders image media with alt text and plain caption", () => {
    const view = render(
      <ExchangeView
        taskId="task_media"
        exchange={makeExchange({
          kind: "media",
          id: "req_media:media:media_png",
          mediaId: "media_png",
          mediaKind: "image",
          mimeType: "image/png",
          filename: "shot.png",
          sizeBytes: 95,
          url: "/api/tasks/task_media/media/media_png",
          caption: "Current screen",
          display: "inline",
          width: 1,
          height: 1,
        })}
      />,
    );

    const img = view.getByAltText("Current screen") as HTMLImageElement;
    expect(img.src).toContain("/api/tasks/task_media/media/media_png");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(view.getByText("Current screen")).toBeTruthy();
  });

  test("renders video media with controls and metadata preload", () => {
    const view = render(
      <ExchangeView
        taskId="task_media"
        exchange={makeExchange({
          kind: "media",
          id: "req_media:media:media_mp4",
          mediaId: "media_mp4",
          mediaKind: "video",
          mimeType: "video/mp4",
          filename: "demo.mp4",
          sizeBytes: 28,
          url: "/api/tasks/task_media/media/media_mp4",
          display: "inline",
        })}
      />,
    );

    const video = view.container.querySelector("video") as HTMLVideoElement | null;
    expect(video).toBeTruthy();
    expect(video?.controls).toBe(true);
    expect(video?.preload).toBe("metadata");
    expect(video?.querySelector("source")?.getAttribute("src")).toBe("/api/tasks/task_media/media/media_mp4");
    expect(video?.querySelector("source")?.getAttribute("type")).toBe("video/mp4");
  });
});

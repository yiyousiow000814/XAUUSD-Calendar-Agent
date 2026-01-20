import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HistoryPanel } from "../components/HistoryPanel";

const renderHistory = () =>
  render(
    <HistoryPanel
      events={[]}
      loading={false}
      impactTone={() => "low"}
      impactFilter={["Low", "Medium", "High"]}
    />
  );

describe("HistoryPanel scroll persistence", () => {
  it("restores scroll position from localStorage", async () => {
    window.localStorage.setItem("xauusd:scroll:history", "90");
    const { container } = renderHistory();
    const body = container.querySelector(".history-body") as HTMLDivElement;
    await waitFor(() => expect(body.scrollTop).toBe(90));
  });

  it("stores scroll position to localStorage", () => {
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => {
        cb(0);
        return 1;
      });
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const { container } = renderHistory();
    const body = container.querySelector(".history-body") as HTMLDivElement;
    body.scrollTop = 40;
    fireEvent.scroll(body);
    expect(window.localStorage.getItem("xauusd:scroll:history")).toBe("40");
    rafSpy.mockRestore();
    cancelSpy.mockRestore();
  });
});

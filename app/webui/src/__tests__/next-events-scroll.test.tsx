import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NextEvents } from "../components/NextEvents";

const renderNextEvents = () =>
  render(
    <NextEvents
      events={[]}
      loading={false}
      currency="USD"
      currencyOptions={["USD"]}
      onCurrencyChange={() => {}}
      impactTone={() => "low"}
      impactFilter={["Low", "Medium", "High"]}
      onImpactFilterChange={() => {}}
    />
  );

describe("NextEvents scroll persistence", () => {
  it("restores scroll position from localStorage", async () => {
    window.localStorage.setItem("xauusd:scroll:next-events", "120");
    const { container } = renderNextEvents();
    const list = container.querySelector("[data-qa='qa:list:next-events']") as HTMLDivElement;
    await waitFor(() => expect(list.scrollTop).toBe(120));
  });

  it("stores scroll position to localStorage", () => {
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => {
        cb(0);
        return 1;
      });
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const { container } = renderNextEvents();
    const list = container.querySelector("[data-qa='qa:list:next-events']") as HTMLDivElement;
    list.scrollTop = 55;
    fireEvent.scroll(list);
    expect(window.localStorage.getItem("xauusd:scroll:next-events")).toBe("55");
    rafSpy.mockRestore();
    cancelSpy.mockRestore();
  });
});

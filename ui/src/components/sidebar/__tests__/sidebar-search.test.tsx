import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SidebarSearch } from "@/components/sidebar/sidebar-search";

afterEach(() => vi.useRealTimers());

describe("SidebarSearch", () => {
  it("keeps an empty search open for five seconds after the pointer leaves", () => {
    vi.useFakeTimers();

    render(<SidebarSearch label="Sessions" onSearch={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "Search Sessions" });
    fireEvent.click(trigger);
    fireEvent.mouseLeave(screen.getByRole("searchbox", { name: "Search Sessions" }));

    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("cancels the pending close when the user starts typing", () => {
    vi.useFakeTimers();

    render(<SidebarSearch label="Sessions" onSearch={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "Search Sessions" });
    fireEvent.click(trigger);
    const input = screen.getByRole("searchbox", { name: "Search Sessions" });
    fireEvent.mouseLeave(input);
    fireEvent.change(input, { target: { value: "s" } });

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });
});

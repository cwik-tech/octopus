import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ResponseTime } from "../response-time";

afterEach(() => vi.useRealTimers());

it("keeps counting while the reply is still running", () => {
  vi.useFakeTimers();
  render(<ResponseTime startedAt={Date.now() - 5_000} />);
  expect(screen.getByRole("timer", { name: "Response time" })).toHaveTextContent("00:05");

  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(screen.getByRole("timer", { name: "Response time" })).toHaveTextContent("01:05");
});

it("stays at the final duration once the reply is saved", () => {
  vi.useFakeTimers();
  const startedAt = Date.now() - 600_000;
  render(<ResponseTime startedAt={startedAt} completedAt={startedAt + 42_000} />);
  expect(screen.getByRole("timer", { name: "Response time" })).toHaveTextContent("00:42");

  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(screen.getByRole("timer", { name: "Response time" })).toHaveTextContent("00:42");
});

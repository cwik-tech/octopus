export function QueueStateDot({
  state,
}: {
  state: "waiting" | "starting" | "running" | "finishing";
}) {
  return (
    <span
      className={[
        "size-2 rounded-full",
        state === "running"
          ? "bg-emerald-500"
          : state === "starting"
            ? "bg-sky-500"
            : state === "finishing"
              ? "bg-amber-500"
              : "bg-sidebar-foreground/35",
      ].join(" ")}
    />
  );
}

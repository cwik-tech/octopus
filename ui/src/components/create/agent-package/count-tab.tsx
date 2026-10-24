import { TabsTrigger } from "@/components/ui/tabs";

export function CountTab(props: {
  value: string;
  label: string;
  count?: number;
}) {
  return (
    <TabsTrigger value={props.value} className="shrink-0 px-1.5 text-xs">
      <span>{props.label}</span>
      {props.count && props.count > 0 ? (
        <span className="tabular-nums">{props.count}</span>
      ) : null}
    </TabsTrigger>
  );
}

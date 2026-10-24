import { Badge } from "@/components/ui/badge";

export function SmallCount(props: { label: string; count: number }) {
  if (props.count === 0) return null;
  return (
    <Badge variant="secondary" className="h-4 px-1.5 text-xs">
      {props.count} {props.label}
    </Badge>
  );
}

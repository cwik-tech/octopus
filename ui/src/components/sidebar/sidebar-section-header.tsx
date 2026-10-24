import { SidebarSearch } from "@/components/sidebar/sidebar-search";

export function SidebarSectionHeader({
  title,
  onSearch,
  searchLabel = title ?? "",
  searchPlaceholder,
}: {
  /** Omit where an enclosing control already names the section. */
  title?: string;
  onSearch?: (query: string) => void;
  searchLabel?: string;
  searchPlaceholder?: string;
}) {
  return (
    <div className="relative mb-1 flex h-7 items-center px-2.5">
      {title ? (
        <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-sidebar-foreground/45">
          {title}
        </h2>
      ) : null}
      {onSearch ? (
        <SidebarSearch
          label={searchLabel}
          onSearch={onSearch}
          placeholder={searchPlaceholder}
        />
      ) : null}
    </div>
  );
}

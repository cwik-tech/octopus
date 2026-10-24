export function filterSidebarItems<T>(
  items: T[],
  query: string,
  values: (item: T) => Array<string | null | undefined>,
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return items;

  return items.filter((item) =>
    values(item).some((value) =>
      value?.toLocaleLowerCase().includes(normalizedQuery),
    ),
  );
}

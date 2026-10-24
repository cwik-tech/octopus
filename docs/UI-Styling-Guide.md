# UI Styling Guide

How styling works in `ui/`. Two rules cover most of it:

1. **Reach for a shadcn primitive before writing markup.** They live in
   `ui/src/components/ui/`.
2. **Never write a raw pixel value in a class.** Every size, radius, and type
   step comes from the theme.

The look of the app is the theme, not the components. Change a token in
`ui/src/index.css` and the whole app follows.

## Tokens

Defined in `ui/src/index.css`. Colours are set twice — once on `:root` for
light, once on `.dark`.

### Radius

The base is `--radius: 0.5rem`, and every step is a fixed offset from it, so
the scale lands on whole pixels. This is shadcn's stock formula.

| Class | Value |
|---|---|
| `rounded-xs` | 2px |
| `rounded-sm` | 4px |
| `rounded-md` | 6px |
| `rounded-lg` | 8px — the default for rows and inputs (`Card` and `PanelCard` use `rounded-xl`) |
| `rounded-xl` | 12px |
| `rounded-2xl` | 16px |
| `rounded-full` | pill |

### Type

Tailwind's stock scale. `text-xs` (12px) is the floor — there is no smaller
step, and meta labels, badge text, and captions all use it.

### Colour

Semantic tokens only: `bg-background`, `bg-card`, `bg-muted`, `text-foreground`,
`text-muted-foreground`, `border-border`, `bg-primary`, `bg-destructive`.

One project-specific addition: **`bg-surface-sunken`**, a recessed fill that is
always a step darker than the surface behind it, in both themes. Use it for
cards nested inside a panel that has no background of its own.

Never write a raw colour (`bg-[#1a202b]`, `text-white`). An accent computed at
runtime is the one exception — see below.

### Spacing and sizing

Tailwind's 0.25rem scale, including fractional steps. Any pixel value that is a
multiple of 1px maps onto it directly: `w-75` is 300px, `size-4.5` is 18px,
`p-0.75` is 3px, `pl-21.5` is 86px.

Border and ring widths take plain numbers: `border-l-3`, `ring-3`.

## Components

Use the primitive. They carry focus rings, disabled states, and keyboard
behaviour that hand-rolled markup silently drops.

| Instead of | Use |
|---|---|
| `<button>` | `Button` — `variant` and `size` cover almost every case |
| a bordered div | `Card` / `PanelCard` |
| a dashed "nothing here" box | `PanelEmptyState` |
| a hand-rolled tab strip or segmented toggle | `Tabs` + `TabsList` + `TabsTrigger` |
| a custom modal | `Dialog` |
| an "i" tooltip on a form field | `FieldHelp` |

**Anything clickable is a `Button`**, even when it looks nothing like one. A
selectable row, a sidebar entry, a link-styled action, a drop zone — all of them
are `Button` with `variant="ghost"` (or `"link"`) and layout classes. Reach for
`h-auto`, `w-full`, `justify-start`, `flex-col items-stretch`, and
`font-normal` to reshape it; that is expected and not a smell.

**A `TabsList` is the right answer for any two-or-more mutually exclusive
options** rendered side by side, including underline-style tabs
(`variant="line"`) and segmented pills (the default).

Shared composites live beside the primitives:

- `components/overview/overview-header.tsx` — the heading block every overview
  panel shares: an identity row (tabs or title) and a description row carrying
  the panel's actions.
- `components/overview/overview-panel.tsx` — `OverviewPanel`, `OverviewStats`,
  `OverviewStat`, `OverviewSection`, `OverviewRow`.
- `components/ui/field-help.tsx` — `FieldHelp`, the "i" affordance for forms.

If you need a variant a primitive does not have, add it to the primitive rather
than forking the markup at the call site.

**Primitives implement their own root element.** A raw `<button>` inside
`components/ui/` is correct — that is the primitive doing its job. `sheet.tsx`
(the backdrop), `resizable-right-sheet.tsx` (the drag handle),
`model-select.tsx` (the select trigger), and `card.tsx` (`PanelItemButton`) all
own one. Everywhere else, a raw `<button>` is a bug.

## Accepted exceptions

Four cases legitimately carry pixel values. Everything else is a bug.

1. **Radius expressions inside vendored shadcn primitives.** `button.tsx`,
   `select.tsx`, and `input-group.tsx` clamp their radius with expressions like
   `rounded-[min(var(--radius-md),10px)]` and `rounded-[calc(var(--radius)-3px)]`.
   Leave those exactly as upstream ships them, so a future `shadcn add` does not
   conflict. Straight token swaps inside a primitive are fine and expected —
   `ring-[3px]` became `ring-3` in `badge.tsx`, `scroll-area.tsx`, and
   `tabs.tsx`.
2. **Runtime-measured values.** `resizable-right-sheet.tsx` writes a width the
   user drags. These are numbers, not design decisions.
3. **Values computed from data.** The timeline indents by depth
   (`paddingLeft: 10 + depth * 14`) and tints a border by team accent
   (`borderLeftColor`). Keep the computed part inline and put everything
   static — width, style — in classes.
4. **Viewport clamps.** `w-[min(340px,50vw)]` and similar have no token
   equivalent.

## Adding a token

Two edits in `ui/src/index.css`: declare the value under `:root` and `.dark`,
then map it in the `@theme inline` block so Tailwind generates classes for it. Example,
`--surface-sunken`:

```css
@theme inline {
  --color-surface-sunken: var(--surface-sunken);
}
:root { --surface-sunken: #e7eaf9; }
.dark { --surface-sunken: #161320; }
```

## Checking your work

Both of these should print nothing:

```sh
# No arbitrary pixel values.
grep -rnE "[a-zA-Z-]+-\[-?[0-9.]+px\]" ui/src --include="*.tsx" --include="*.ts"

# No raw <button> outside the primitives themselves.
grep -rn "<button" ui/src --include="*.tsx" \
  --exclude-dir=__tests__ --exclude-dir=ui
```
